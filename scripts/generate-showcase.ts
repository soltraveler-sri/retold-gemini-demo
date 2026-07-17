import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCollections } from "../lib/collections.js";
import { buildChunkPrompt, buildFilmPrompt, splitFilmPhotos } from "../lib/film.js";
import { FILM_CROSSFADE_SECONDS, stitchFilmClips } from "../lib/film-stitch.js";
import {
  generateOmniVideo,
  OMNI_MODEL_ID,
  OMNI_OUTPUT_DURATION_SECONDS,
  writeOmniVideoFile,
  type OmniReferenceImage,
  type OmniReferenceImageMimeType,
  type OmniVideo,
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
  photos: readonly Photo[],
): Promise<readonly OmniReferenceImage[]> {
  return Promise.all(
    photos.map(async (photo) => ({
      bytes: await readFile(publicAssetPath(photo.file)),
      mimeType: mimeTypeForPhoto(photo),
    })),
  );
}

/** Chunk clips must be bytes in memory before ffmpeg can stitch them. */
async function materializeShowcaseVideo(video: OmniVideo): Promise<Uint8Array> {
  if (video.kind === "inline") return video.bytes;
  const directory = await mkdtemp(resolve(tmpdir(), "retold-showcase-"));
  try {
    const temporary = resolve(directory, "chunk.mp4");
    await writeOmniVideoFile(video, temporary);
    return await readFile(temporary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function interactionIdFromError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/interaction\s+([^\s.]+)/iu)?.[1];
}

function redactError(error: unknown, secret: string | undefined): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return secret ? raw.split(secret).join("[REDACTED]") : raw;
}

/**
 * Showcase films go through the SAME chunk-and-stitch path as /api/film, so a
 * 7-8 photo collection produces the same two-chunk film a visitor would get.
 * Duplicating a single-chunk-only path here would mean the showcase silently
 * diverged from the product the moment a collection grew past six photos.
 */
async function generateCollection(collection: Collection): Promise<void> {
  const chunks = splitFilmPhotos(collection.photos);
  const outputPath = publicAssetPath(collection.showcaseFilm);
  let interactionId: string | undefined;

  try {
    console.log(
      `Generating ${collection.id} from all ${collection.photos.length} seeded photos in ${chunks.length} chunk(s).`,
    );

    const clips: Uint8Array[] = [];
    let totalMs = 0;
    for (const [index, chunk] of chunks.entries()) {
      const result = await generateOmniVideo({
        referenceImages: await loadReferenceImages(chunk),
        prompt:
          chunks.length === 1
            ? buildFilmPrompt(collection.promptTemplate, chunk.length)
            : buildChunkPrompt(
                collection.promptTemplate,
                chunk.length,
                (index + 1) as 1 | 2,
              ),
      });
      interactionId = result.interactionId;
      totalMs += result.wallClockMs;
      console.log(
        `  part ${index + 1}/${chunks.length}: ${result.interactionId} (${result.wallClockMs}ms, ${chunk.length} photos)`,
      );
      clips.push(await materializeShowcaseVideo(result.video));
    }

    if (clips.length === 1) {
      await writeFile(outputPath, clips[0]!);
    } else {
      await writeFile(outputPath, await stitchFilmClips(clips[0]!, clips[1]!));
      console.log(`  stitched ${clips.length} clips with a ${FILM_CROSSFADE_SECONDS}s crossfade`);
    }

    const output = await stat(outputPath);
    const cost =
      OMNI_OUTPUT_DURATION_SECONDS * PRICE_PER_OUTPUT_SECOND_USD * chunks.length;

    console.log(`  Wall-clock latency: ${totalMs}ms`);
    console.log(
      `  Output size: ${output.size} bytes (${(output.size / 1_048_576).toFixed(2)} MiB)`,
    );
    console.log(
      `  Estimated cost: $${cost.toFixed(2)} (${chunks.length} × ${OMNI_OUTPUT_DURATION_SECONDS}s × $${PRICE_PER_OUTPUT_SECOND_USD.toFixed(2)}/s)`,
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
  const collections = loadCollections();
  const jobs = options.collectionId
    ? collections.filter((collection) => collection.id === options.collectionId)
    : collections;
  if (jobs.length === 0) {
    throw new Error(`Unknown collection id: ${options.collectionId}`);
  }

  // A 7-8 photo collection is TWO generations, so count chunks rather than
  // collections. Announcing "$1.00" and then spending $2.00 is exactly the
  // kind of quiet drift this script's --confirm-paid gate exists to prevent.
  const clipCount = jobs.reduce(
    (total, job) => total + splitFilmPhotos(job.photos).length,
    0,
  );
  const estimatedCost =
    clipCount * OMNI_OUTPUT_DURATION_SECONDS * PRICE_PER_OUTPUT_SECOND_USD;
  console.log(
    `Preparing up to ${clipCount} paid ${OMNI_MODEL_ID} generation${clipCount === 1 ? "" : "s"} across ${jobs.length} collection${jobs.length === 1 ? "" : "s"}; estimated maximum $${estimatedCost.toFixed(2)}.`,
  );
  for (const job of jobs) {
    const parts = splitFilmPhotos(job.photos).length;
    console.log(
      `  ${job.id}: ${job.photos.length} photos -> ${parts} clip${parts === 1 ? "" : "s"} ($${(parts * OMNI_OUTPUT_DURATION_SECONDS * PRICE_PER_OUTPUT_SECOND_USD).toFixed(2)})`,
    );
  }

  // The estimate is printed FIRST: a confirmation gate that hides the number
  // it is asking you to confirm is not informed consent.
  if (!options.confirmPaid) {
    throw new Error(
      "This script makes paid Gemini Omni requests. Re-run with --confirm-paid to spend the amount above.",
    );
  }
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new Error("GEMINI_API_KEY is required to generate showcase films.");
  }

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
