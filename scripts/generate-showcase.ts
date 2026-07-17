import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCollections } from "../lib/collections.js";
import { buildFilmPrompt, MAX_FILM_PHOTOS } from "../lib/film.js";
import {
  generateOmniVideo,
  OMNI_MODEL_ID,
  OMNI_OUTPUT_DURATION_SECONDS,
  writeOmniVideoFile,
  type OmniReferenceImage,
  type OmniReferenceImageMimeType,
} from "../lib/omni.js";
import type { Collection, Photo } from "../types/library.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(SCRIPT_DIR, "..", "public");
const PRICE_PER_OUTPUT_SECOND_USD = 0.1;
const MAX_SHOWCASE_FILM_BYTES = 10 * 1024 * 1024;

interface CliOptions {
  collectionId?: string;
  confirmPaid: boolean;
  force: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  let collectionId: string | undefined;
  let confirmPaid = false;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--confirm-paid") {
      confirmPaid = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--collection") {
      collectionId = args[index + 1];
      if (!collectionId) {
        throw new Error("--collection requires a collection id.");
      }
      index += 1;
      continue;
    }
    if (arg?.startsWith("--collection=")) {
      collectionId = arg.slice("--collection=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    ...(collectionId === undefined ? {} : { collectionId }),
    confirmPaid,
    force,
  };
}

function publicAssetPath(asset: string): string {
  const path = resolve(PUBLIC_DIR, asset.replace(/^\/+/, ""));
  if (path !== PUBLIC_DIR && !path.startsWith(`${PUBLIC_DIR}${sep}`)) {
    throw new Error(`Public asset escapes public/: ${asset}`);
  }
  return path;
}

function mimeTypeForPhoto(photo: Photo): OmniReferenceImageMimeType {
  switch (extname(photo.file).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported collection photo type: ${photo.file}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadReferenceImages(
  collection: Collection,
): Promise<readonly OmniReferenceImage[]> {
  return Promise.all(
    collection.photos.map(async (photo) => ({
      bytes: await readFile(publicAssetPath(photo.file)),
      mimeType: mimeTypeForPhoto(photo),
    })),
  );
}

function interactionIdFromError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/interaction\s+([^\s.]+)/iu)?.[1];
}

function redactError(error: unknown, secret: string | undefined): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return secret ? raw.split(secret).join("[REDACTED]") : raw;
}

async function generateCollection(collection: Collection): Promise<void> {
  if (collection.photos.length > MAX_FILM_PHOTOS) {
    throw new Error(
      `${collection.id} has ${collection.photos.length} photos; Omni accepts at most ${MAX_FILM_PHOTOS}.`,
    );
  }

  const outputPath = publicAssetPath(collection.showcaseFilm);
  let interactionId: string | undefined;

  try {
    console.log(`Generating ${collection.id} from all ${collection.photos.length} seeded photos.`);
    const result = await generateOmniVideo({
      referenceImages: await loadReferenceImages(collection),
      prompt: buildFilmPrompt(
        collection.promptTemplate,
        collection.photos.length,
      ),
    });
    interactionId = result.interactionId;
    await writeOmniVideoFile(result.video, outputPath);

    const output = await stat(outputPath);
    const cost =
      OMNI_OUTPUT_DURATION_SECONDS * PRICE_PER_OUTPUT_SECOND_USD;

    console.log(`  Interaction ID: ${result.interactionId}`);
    console.log(`  Wall-clock latency: ${result.wallClockMs}ms`);
    console.log(
      `  Output size: ${output.size} bytes (${(output.size / 1_048_576).toFixed(2)} MiB)`,
    );
    console.log(
      `  Estimated cost: $${cost.toFixed(2)} (${OMNI_OUTPUT_DURATION_SECONDS}s × $${PRICE_PER_OUTPUT_SECOND_USD.toFixed(2)}/s)`,
    );
    console.log(`  Saved: ${outputPath}`);

    if (output.size > MAX_SHOWCASE_FILM_BYTES) {
      console.warn(
        `  WARNING: output exceeds the issue's 10 MiB static-asset threshold; the file was kept for review.`,
      );
    }
  } catch (error) {
    const failedInteractionId = interactionId ?? interactionIdFromError(error);
    console.error(`Showcase generation failed for ${collection.id}.`);
    console.error(
      `Interaction ID: ${failedInteractionId ?? "unavailable (the request failed before an id was returned)"}`,
    );
    console.error(
      `Retry only this collection: npx tsx scripts/generate-showcase.ts --confirm-paid --collection ${collection.id} --force`,
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.confirmPaid) {
    throw new Error(
      "This script makes paid Gemini Omni requests. Re-run with --confirm-paid after reviewing the selected collections.",
    );
  }
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new Error("GEMINI_API_KEY is required to generate showcase films.");
  }

  const collections = loadCollections();
  const jobs = options.collectionId
    ? collections.filter((collection) => collection.id === options.collectionId)
    : collections;
  if (jobs.length === 0) {
    throw new Error(`Unknown collection id: ${options.collectionId}`);
  }

  const estimatedCost =
    jobs.length * OMNI_OUTPUT_DURATION_SECONDS * PRICE_PER_OUTPUT_SECOND_USD;
  console.log(
    `Preparing up to ${jobs.length} paid ${OMNI_MODEL_ID} generation${jobs.length === 1 ? "" : "s"}; estimated maximum $${estimatedCost.toFixed(2)}.`,
  );

  for (const collection of jobs) {
    const outputPath = publicAssetPath(collection.showcaseFilm);
    if (!options.force && (await exists(outputPath))) {
      const output = await stat(outputPath);
      console.log(
        `Skipped ${collection.id}: ${collection.showcaseFilm} already exists (${(output.size / 1_048_576).toFixed(2)} MiB).`,
      );
      continue;
    }
    await generateCollection(collection);
  }
}

main().catch((error: unknown) => {
  console.error("Showcase generation stopped.");
  console.error(redactError(error, process.env.GEMINI_API_KEY));
  process.exitCode = 1;
});
