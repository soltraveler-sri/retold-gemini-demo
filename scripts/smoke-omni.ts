import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateOmniVideo,
  OMNI_MODEL_ID,
  OMNI_OUTPUT_DURATION_SECONDS,
  writeOmniVideoFile,
  type OmniReferenceImage,
  type OmniReferenceImageMimeType,
  type OmniVideo,
} from "../lib/omni.js";

type PromptMode = "baseline" | "montage";

interface CliOptions {
  dryRun: boolean;
  promptMode: PromptMode;
}

interface Mp4Box {
  type: string;
  payloadStart: number;
  end: number;
}

interface Mp4Metadata {
  durationSeconds?: number;
  height?: number;
  width?: number;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURE_PATHS = [
  resolve(SCRIPT_DIR, "fixtures/event-early.jpg"),
  resolve(SCRIPT_DIR, "fixtures/event-late.jpg"),
] as const;
const PRICE_PER_OUTPUT_SECOND_USD = 0.1;

const PROMPTS: Record<PromptMode, string> = {
  baseline: `[# References <IMAGE_REF_0>@Image1 <IMAGE_REF_1>@Image2]
Bring these two photos from the same event to life as one natural, restrained video. Use both images as chronological references for the same two adults. Add only minimal realistic motion: subtle blinking, breathing, small smiles, gentle fabric movement, and a slow handheld camera drift. Preserve both people's facial identity, age, hair, and clothing. No dramatic action, no new prominent people, no dialogue. Use the given images as references for video generation; do not use them as literal initial frames.`,
  montage: `[# References <IMAGE_REF_0>@Image1 <IMAGE_REF_1>@Image2]
Create a 10-second multi-shot cinematic montage that progresses chronologically through this one event.
[0-3s] An establishing shot brings the earlier moment in <IMAGE_REF_0> to life.
[3-7s] Cut to a closer candid moment between the same two adults, with natural expressions and understated movement.
[7-10s] Cut to the later moment in <IMAGE_REF_1>, ending on the two adults together.
The same two people are the recurring visual anchors in every shot. Their facial identity, age, hair, body proportions, and clothing must persist across every cut; do not redesign, merge, duplicate, or replace either person. Keep the event setting coherent and the cuts clean. Natural ambient sound only, no dialogue, no captions. Use the given images as chronological identity and event references; do not use them as literal initial frames.`,
};

function parseArgs(args: readonly string[]): CliOptions {
  let dryRun = false;
  let promptMode: PromptMode = "baseline";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--prompt-mode") {
      const value = args[index + 1];
      if (value !== "baseline" && value !== "montage") {
        throw new Error(
          "--prompt-mode requires either 'baseline' or 'montage'.",
        );
      }
      promptMode = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--prompt-mode=")) {
      const value = arg.slice("--prompt-mode=".length);
      if (value !== "baseline" && value !== "montage") {
        throw new Error(
          "--prompt-mode requires either 'baseline' or 'montage'.",
        );
      }
      promptMode = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, promptMode };
}

async function fixtureExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mimeTypeForPath(path: string): OmniReferenceImageMimeType {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported fixture image extension: ${path}`);
  }
}

async function loadFixtures(): Promise<OmniReferenceImage[]> {
  const missing = (
    await Promise.all(
      FIXTURE_PATHS.map(async (path) => ({
        exists: await fixtureExists(path),
        path,
      })),
    )
  ).filter((fixture) => !fixture.exists);

  if (missing.length > 0) {
    throw new Error(
      `Missing Omni smoke fixture(s):\n${missing
        .map((fixture) => `  - ${fixture.path}`)
        .join("\n")}\nGenerate them first with: npm run fixtures:make`,
    );
  }

  return Promise.all(
    FIXTURE_PATHS.map(async (path) => ({
      bytes: await readFile(path),
      mimeType: mimeTypeForPath(path),
    })),
  );
}

function readBoxes(data: Buffer, start: number, end: number): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;

  while (offset + 8 <= end) {
    const size32 = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;

    if (size32 === 1) {
      if (offset + 16 > end) break;
      const extendedSize = data.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(extendedSize);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, payloadStart: offset + headerSize, end: offset + size });
    offset += size;
  }

  return boxes;
}

function readMvhdDuration(data: Buffer, box: Mp4Box): number | undefined {
  if (box.payloadStart + 1 > box.end) return undefined;
  const version = data.readUInt8(box.payloadStart);
  const timescaleOffset = box.payloadStart + (version === 1 ? 20 : 12);
  const durationOffset = box.payloadStart + (version === 1 ? 24 : 16);
  const requiredBytes = version === 1 ? 8 : 4;
  if (durationOffset + requiredBytes > box.end) return undefined;

  const timescale = data.readUInt32BE(timescaleOffset);
  if (timescale === 0) return undefined;
  const duration =
    version === 1
      ? Number(data.readBigUInt64BE(durationOffset))
      : data.readUInt32BE(durationOffset);
  return duration / timescale;
}

function readTkhdDimensions(
  data: Buffer,
  box: Mp4Box,
): Pick<Mp4Metadata, "height" | "width"> | undefined {
  if (box.payloadStart + 1 > box.end) return undefined;
  const version = data.readUInt8(box.payloadStart);
  const widthOffset = box.payloadStart + (version === 1 ? 88 : 76);
  const heightOffset = widthOffset + 4;
  if (heightOffset + 4 > box.end) return undefined;

  const width = data.readUInt32BE(widthOffset) / 65_536;
  const height = data.readUInt32BE(heightOffset) / 65_536;
  if (width <= 0 || height <= 0) return undefined;
  return { width: Math.round(width), height: Math.round(height) };
}

function readMp4Metadata(data: Buffer): Mp4Metadata {
  const moov = readBoxes(data, 0, data.length).find(
    (box) => box.type === "moov",
  );
  if (!moov) return {};

  const moovChildren = readBoxes(data, moov.payloadStart, moov.end);
  const mvhd = moovChildren.find((box) => box.type === "mvhd");
  const durationSeconds = mvhd ? readMvhdDuration(data, mvhd) : undefined;

  let dimensions: Pick<Mp4Metadata, "height" | "width"> | undefined;
  for (const trak of moovChildren.filter((box) => box.type === "trak")) {
    const tkhd = readBoxes(data, trak.payloadStart, trak.end).find(
      (box) => box.type === "tkhd",
    );
    if (tkhd) {
      dimensions = readTkhdDimensions(data, tkhd);
      if (dimensions) break;
    }
  }

  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...dimensions,
  };
}

function formatResolution(video: OmniVideo, metadata: Mp4Metadata): string {
  if (metadata.width && metadata.height) {
    return `${metadata.width}x${metadata.height}`;
  }
  return video.resolution
    ? `${video.resolution} (SDK media-resolution label)`
    : "unavailable";
}

function redactString(value: string, secret: string | undefined): string {
  let redacted = secret ? value.split(secret).join("[REDACTED]") : value;
  redacted = redacted.replace(/([?&]key=)[^&\s"']+/giu, "$1[REDACTED]");
  return redacted.replace(
    /(x-goog-api-key|authorization)(["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu,
    "$1$2[REDACTED]",
  );
}

function sanitizeError(
  value: unknown,
  secret: string | undefined,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") return redactString(value, secret);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  const sanitized: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (/api.?key|authorization|x-goog-api-key/iu.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    try {
      sanitized[key] = sanitizeError(
        Reflect.get(value, key),
        secret,
        seen,
        depth + 1,
      );
    } catch {
      sanitized[key] = "[unreadable]";
    }
  }
  return sanitized;
}

async function printDryRun(options: CliOptions): Promise<void> {
  console.log("DRY RUN — no API request will be made.");
  console.log(`Model: ${OMNI_MODEL_ID}`);
  console.log(`Prompt mode: ${options.promptMode}`);
  console.log(`Requested duration: ${OMNI_OUTPUT_DURATION_SECONDS}s`);
  for (const path of FIXTURE_PATHS) {
    console.log(`Fixture: ${path} (${(await fixtureExists(path)) ? "present" : "missing"})`);
  }
  console.log("Prompt:");
  console.log(PROMPTS[options.promptMode]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.dryRun) {
    await printDryRun(options);
    return;
  }

  const referenceImages = await loadFixtures();
  const result = await generateOmniVideo({
    referenceImages,
    prompt: PROMPTS[options.promptMode],
  });
  const outputPath = resolve(REPO_ROOT, "out", `omni-${options.promptMode}.mp4`);
  await writeOmniVideoFile(result.video, outputPath);

  const outputBytes = await readFile(outputPath);
  const outputStat = await stat(outputPath);
  const metadata = readMp4Metadata(outputBytes);
  const durationSeconds =
    metadata.durationSeconds ?? OMNI_OUTPUT_DURATION_SECONDS;
  const durationBasis = metadata.durationSeconds
    ? "container metadata"
    : "requested duration; container metadata unavailable";
  const costEstimate = durationSeconds * PRICE_PER_OUTPUT_SECOND_USD;

  console.log(`Interaction ID: ${result.interactionId}`);
  console.log(`Wall-clock latency: ${result.wallClockMs}ms`);
  console.log(
    `Output size: ${outputStat.size} bytes (${(outputStat.size / 1_048_576).toFixed(2)} MiB)`,
  );
  console.log(`Resolution: ${formatResolution(result.video, metadata)}`);
  console.log(`Duration: ${durationSeconds.toFixed(2)}s (${durationBasis})`);
  console.log(
    `Estimated cost: $${costEstimate.toFixed(2)} (${durationSeconds.toFixed(2)}s × $${PRICE_PER_OUTPUT_SECOND_USD.toFixed(2)}/s)`,
  );
  console.log(`Saved: ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error("Omni smoke test failed.");
  console.error("Raw error shape (secrets redacted):");
  console.error(
    JSON.stringify(sanitizeError(error, process.env.GEMINI_API_KEY), null, 2),
  );
  process.exitCode = 1;
});
