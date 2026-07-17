import { FileState, GoogleGenAI } from "@google/genai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const OMNI_MODEL_ID = "gemini-omni-flash-preview" as const;
export const OMNI_OUTPUT_DURATION_SECONDS = 10;

const FILE_POLL_INTERVAL_MS = 5_000;
const FILE_READY_TIMEOUT_MS = 5 * 60_000;

export type OmniReferenceImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface OmniReferenceImage {
  bytes: Uint8Array;
  mimeType: OmniReferenceImageMimeType;
}

export interface GenerateOmniVideoInput {
  /** Image order defines Image1, Image2, and zero-indexed IMAGE_REF_N tags. */
  referenceImages: readonly OmniReferenceImage[];
  prompt: string;
}

interface OmniVideoCommon {
  mimeType: string;
  /** SDK media-resolution label, when the service includes one. */
  resolution?: string;
}

export type OmniVideo =
  | (OmniVideoCommon & {
      kind: "inline";
      bytes: Uint8Array;
    })
  | (OmniVideoCommon & {
      kind: "uri";
      uri: string;
    });

export interface GenerateOmniVideoResult {
  video: OmniVideo;
  interactionId: string;
  wallClockMs: number;
  modelId: typeof OMNI_MODEL_ID;
}

export type OmniModelErrorCode =
  | "budget-exceeded"
  | "upstream-model-error";

export class OmniModelError extends Error {
  readonly code: OmniModelErrorCode;

  constructor(code: OmniModelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmniModelError";
    this.code = code;
  }
}

function requireApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to call Gemini Omni.");
  }
  return apiKey;
}

function fileNameFromUri(uri: string): string {
  const match = uri.match(/(?:^|\/)files\/([^/:?]+)/u);
  if (!match?.[1]) {
    throw new Error(`Gemini returned an unrecognized video URI: ${uri}`);
  }
  return `files/${match[1]}`;
}

async function waitForFileReady(
  ai: GoogleGenAI,
  uri: string,
): Promise<void> {
  const name = fileNameFromUri(uri);
  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const file = await ai.files.get({ name });
    if (file.state === FileState.ACTIVE) return;
    if (file.state === FileState.FAILED) {
      throw new Error(
        `Gemini generated interaction output, but file ${name} failed processing.`,
        { cause: file.error },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for generated video file ${name}.`);
}

/**
 * The sole Gemini Omni generation chokepoint.
 */
export async function generateOmniVideo(
  input: GenerateOmniVideoInput,
): Promise<GenerateOmniVideoResult> {
  if (input.referenceImages.length === 0) {
    throw new Error("Gemini Omni requires at least one ordered reference image.");
  }
  if (!input.prompt.trim()) {
    throw new Error("Gemini Omni requires a non-empty prompt.");
  }

  const ai = new GoogleGenAI({ apiKey: requireApiKey() });
  const startedAt = Date.now();
  const interaction = await ai.interactions.create({
    model: OMNI_MODEL_ID,
    input: [
      ...input.referenceImages.map((image) => ({
        type: "image" as const,
        data: Buffer.from(image.bytes).toString("base64"),
        mime_type: image.mimeType,
      })),
      { type: "text" as const, text: input.prompt },
    ],
    // Live docs say store=false is faster for synchronous generation. We
    // deliberately accept that trade so future edits can use this interaction.
    store: true,
    background: false,
    stream: false,
    response_modalities: ["video"],
    generation_config: {
      video_config: { task: "reference_to_video" },
    },
    response_format: {
      type: "video",
      delivery: "uri",
      duration: `${OMNI_OUTPUT_DURATION_SECONDS}s`,
    },
  });

  if (interaction.status === "budget_exceeded") {
    throw new OmniModelError(
      "budget-exceeded",
      `Gemini Omni interaction ${interaction.id} exhausted its upstream budget.`,
    );
  }

  if (interaction.status !== "completed") {
    throw new OmniModelError(
      "upstream-model-error",
      `Gemini Omni interaction ${interaction.id} ended with status ${interaction.status}.`,
    );
  }

  const output = interaction.output_video;
  if (!output) {
    throw new Error(
      `Gemini Omni interaction ${interaction.id} completed without output_video.`,
    );
  }

  const common = {
    mimeType: output.mime_type ?? "video/mp4",
    ...(output.resolution ? { resolution: output.resolution } : {}),
  };

  let video: OmniVideo;
  if (output.data) {
    video = {
      kind: "inline",
      bytes: Buffer.from(output.data, "base64"),
      ...common,
    };
  } else if (output.uri) {
    await waitForFileReady(ai, output.uri);
    video = { kind: "uri", uri: output.uri, ...common };
  } else {
    throw new Error(
      `Gemini Omni interaction ${interaction.id} returned output_video without data or uri.`,
    );
  }

  return {
    video,
    interactionId: interaction.id,
    wallClockMs: Date.now() - startedAt,
    modelId: OMNI_MODEL_ID,
  };
}

export async function writeOmniVideoFile(
  video: OmniVideo,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });

  if (video.kind === "inline") {
    await writeFile(destination, video.bytes);
    return;
  }

  const ai = new GoogleGenAI({ apiKey: requireApiKey() });
  await ai.files.download({ file: video.uri, downloadPath: destination });
}
