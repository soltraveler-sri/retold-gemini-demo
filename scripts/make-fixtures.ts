import { GoogleGenAI } from "@google/genai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_MODEL_ID = "gemini-3.1-flash-image" as const;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(SCRIPT_DIR, "fixtures");

const FIRST_PHOTO_PROMPT = `Generate a clearly synthetic, photorealistic candid event photo. Show exactly two fictional adults who do not resemble real or public figures: a woman in her early 30s with shoulder-length curly dark hair wearing a mustard-yellow dress, and a man in his late 30s with short auburn hair wearing a navy linen shirt. They are close friends arriving together at a warm summer garden birthday party in the late afternoon. Medium-wide 16:9 composition, natural skin texture, documentary photography, soft available light. Both faces must be clearly visible. No children, no text, no logos.`;

const SECOND_PHOTO_PROMPT = `Create a second candid photo from later at the exact same garden birthday party, now near sunset beside the birthday table. Show the exact same two fictional adults from the previous image, with identical facial identity, age, hair, body proportions, and clothing. They are laughing together while holding sparkling-water glasses. Change the camera angle and pose so this is unmistakably a later photo, while keeping the event location coherent. Medium-wide 16:9 documentary photograph, both faces clearly visible. No children, no text, no logos.`;

interface ImageInteractionResult {
  id: string;
  output_image?: { data?: string | undefined } | undefined;
  status: string;
}

function requireApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to generate fixture images.");
  }
  return apiKey;
}

function imageBytes(
  interaction: ImageInteractionResult,
  label: string,
): Buffer {
  if (interaction.status !== "completed") {
    throw new Error(
      `${label} fixture interaction ${interaction.id} ended with status ${interaction.status}.`,
    );
  }
  const data = interaction.output_image?.data;
  if (!data) {
    throw new Error(
      `${label} fixture interaction ${interaction.id} completed without output_image.data.`,
    );
  }
  return Buffer.from(data, "base64");
}

function redactError(error: unknown, secret: string | undefined): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return secret ? raw.split(secret).join("[REDACTED]") : raw;
}

async function main(): Promise<void> {
  const apiKey = requireApiKey();
  const ai = new GoogleGenAI({ apiKey });
  await mkdir(FIXTURE_DIR, { recursive: true });

  const first = await ai.interactions.create({
    model: IMAGE_MODEL_ID,
    input: FIRST_PHOTO_PROMPT,
    store: true,
    background: false,
    stream: false,
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "16:9",
      image_size: "1K",
    },
  });
  const firstPath = resolve(FIXTURE_DIR, "event-early.jpg");
  await writeFile(firstPath, imageBytes(first, "First"));

  const second = await ai.interactions.create({
    model: IMAGE_MODEL_ID,
    input: SECOND_PHOTO_PROMPT,
    previous_interaction_id: first.id,
    store: true,
    background: false,
    stream: false,
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "16:9",
      image_size: "1K",
    },
  });
  const secondPath = resolve(FIXTURE_DIR, "event-late.jpg");
  await writeFile(secondPath, imageBytes(second, "Second"));

  console.log(`Saved synthetic adult fixtures:\n  - ${firstPath}\n  - ${secondPath}`);
}

main().catch((error: unknown) => {
  console.error("Fixture generation failed.");
  console.error(redactError(error, process.env.GEMINI_API_KEY));
  process.exitCode = 1;
});
