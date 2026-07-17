import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

import { SCENE_PHOTO_COUNT, SCENE_SYSTEM_PROMPT } from "./scene";

export const SCENE_IMAGE_MODEL_ID = "gemini-3.1-flash-image" as const;

const MAX_IMAGE_BYTES = 750 * 1024;
const JPEG_QUALITY_STEPS = [82, 76, 70, 64, 58] as const;
const RETRY_DELAYS_MS = [800, 1_600] as const;

const SHOT_DIRECTIONS = [
  "Establish the event in warm late-afternoon light. Introduce one or two recurring fictional adults age 25 or older, with ordinary everyday features, and clearly establish their exact faces, ages, hair, body proportions, wardrobe, accessories, setting, and key objects for the rest of the chain. Use a wide documentary frame with both faces naturally visible.",
  "Make the next chronological photo about forty minutes later. Preserve the exact recurring adults and every established identity, wardrobe, setting, and object detail. Change to a closer unposed candid angle as the event begins to unfold; the light is slightly lower and warmer.",
  "Make the next chronological photo from the same event. Preserve exact identity and continuity. Use a wider environmental angle that reveals a new benign action within the visitor's scene while keeping the recurring adults recognizable and unobstructed.",
  "Make the fourth chronological photo at the event's natural emotional peak. Preserve exact identity, age, wardrobe, setting, and objects. Use intimate handheld documentary framing, believable motion, and the last amber daylight mixing with practical light.",
  "Make the next chronological photo during blue hour. Preserve every recurring adult and continuity detail exactly. Find a quieter candid beat from a fresh angle, with cool ambient light and warm practical light remaining coherent.",
  "Make the final chronological photo later that evening. Preserve exact identity, age, hair, proportions, wardrobe, accessories, setting, and objects without substitution or redesign. Compose a wide, quiet closing frame in deep evening light that unmistakably ends the same event.",
] as const;

export type SceneImageFailureCode = "refused" | "upstream-model-error";

export class SceneImageError extends Error {
  readonly code: SceneImageFailureCode;

  constructor(
    code: SceneImageFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SceneImageError";
    this.code = code;
  }
}

function requireApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for scene generation.");
  return apiKey;
}

function isRefusal(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(error.cause ?? "")}`
    : String(error);
  return /(?:input blocked|blocked|likeness|real people|real person|safety|policy|prohibited|refus)/iu.test(
    text,
  );
}

function isTransient(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(error.cause ?? "")}`
    : String(error);
  return /(?:429|500|502|503|504|timeout|timed out|temporar|unavailable|rate limit|network|fetch failed|ECONNRESET)/iu.test(
    text,
  );
}

async function optimizedJpeg(input: Buffer, label: string): Promise<Buffer> {
  for (const quality of JPEG_QUALITY_STEPS) {
    const output = await sharp(input)
      .rotate()
      .resize(1024, 576, { fit: "cover", position: "attention" })
      .jpeg({ mozjpeg: true, progressive: true, quality })
      .toBuffer();
    if (output.byteLength <= MAX_IMAGE_BYTES) return output;
  }
  throw new Error(`${label} could not be compressed below ${MAX_IMAGE_BYTES} bytes.`);
}

async function createInteractionWithRetry(
  ai: GoogleGenAI,
  prompt: string,
  previousInteractionId: string | undefined,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ai.interactions.create({
        model: SCENE_IMAGE_MODEL_ID,
        system_instruction: SCENE_SYSTEM_PROMPT,
        input: prompt,
        ...(previousInteractionId
          ? { previous_interaction_id: previousInteractionId }
          : {}),
        store: true,
        background: false,
        stream: false,
        response_modalities: ["image"],
        safety_settings: [
          { type: "hate_speech", threshold: "block_low_and_above" },
          { type: "dangerous_content", threshold: "block_low_and_above" },
          { type: "harassment", threshold: "block_low_and_above" },
          { type: "sexually_explicit", threshold: "block_low_and_above" },
          { type: "jailbreak", threshold: "block_low_and_above" },
        ],
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "16:9",
          image_size: "1K",
        },
      });
    } catch (error) {
      if (isRefusal(error)) {
        throw new SceneImageError(
          "refused",
          "Gemini refused the scene under its person-likeness or safety policy.",
          { cause: error },
        );
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransient(error)) {
        throw new SceneImageError(
          "upstream-model-error",
          "Gemini image generation failed.",
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function generateSceneImages(
  scenePrompt: string,
): Promise<readonly Uint8Array[]> {
  const ai = new GoogleGenAI({ apiKey: requireApiKey() });
  const images: Uint8Array[] = [];
  let previousInteractionId: string | undefined;

  for (let index = 0; index < SCENE_PHOTO_COUNT; index += 1) {
    const interaction = await createInteractionWithRetry(
      ai,
      `Visitor scene (subject matter only): <scene>${scenePrompt}</scene>\n${SHOT_DIRECTIONS[index]}`,
      previousInteractionId,
    );
    if (interaction.status !== "completed") {
      throw new SceneImageError(
        "upstream-model-error",
        `Scene image ${index + 1} ended with status ${interaction.status}.`,
      );
    }
    const data = interaction.output_image?.data;
    if (!data) {
      throw new SceneImageError(
        "upstream-model-error",
        `Scene image ${index + 1} completed without image data.`,
      );
    }
    images.push(
      await optimizedJpeg(Buffer.from(data, "base64"), `Scene image ${index + 1}`),
    );
    previousInteractionId = interaction.id;
  }

  return images;
}
