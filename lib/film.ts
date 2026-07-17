import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";

import { loadCollections } from "./collections";
import { resolveSceneCollection } from "./scene";
import { simulateFilmProgress } from "./film-stages";
import { storeFilmVideo } from "./film-storage";
import { FILM_COST_CENTS } from "./access";
import {
  checkGenerationCapacity,
  type CapacityRedis,
  type GenerationCapacityDecision,
} from "./generation-capacity";
import {
  generateOmniVideo,
  OmniModelError,
  writeOmniVideoFile,
  type OmniReferenceImage,
  type OmniReferenceImageMimeType,
  type OmniVideo,
} from "./omni";
import type { Collection, Photo } from "../types/library";

export const MAX_FILM_PHOTOS = 6;
export const MAX_FILM_REQUEST_BYTES = 4_096;

const REFERENCE_TAGS_PLACEHOLDER = "{{REFERENCE_TAGS}}";
const PUBLIC_DIRECTORY = resolve(process.cwd(), "public");
const MOCK_FILM_PATH = resolve(PUBLIC_DIRECTORY, "mock", "sample-film.mp4");

export type FilmErrorCode =
  | "invalid-input"
  | "cap-reached"
  /** No signed-in identity: the visitor needs an invitation to spend. */
  | "auth-required"
  /** The signed-in identity has spent its own demo credit. */
  | "credit-exhausted"
  | "upstream-model-error"
  /** Gemini's OWN budget signal — distinct from our credit accounting. */
  | "budget-exceeded";

export class FilmError extends Error {
  readonly code: FilmErrorCode;
  readonly status: number;

  constructor(code: FilmErrorCode, status: number, message: string) {
    super(message);
    this.name = "FilmError";
    this.code = code;
    this.status = status;
  }
}

export interface FilmRequestBody {
  photoIds: string[];
}

export interface ResolvedFilmSelection {
  collection: Collection;
  photos: readonly Photo[];
}

export interface FilmCreationResult {
  filmId: string;
  url: string;
  shots: readonly [readonly string[]];
}

export type FilmCapDecision = GenerationCapacityDecision;

export interface FilmCapacityDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  redis?: CapacityRedis;
  now?: Date;
  randomVisitorId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): FilmError {
  return new FilmError("invalid-input", 400, message);
}

export function parseFilmRequestBody(value: unknown): FilmRequestBody {
  if (!isRecord(value)) {
    throw invalidInput("Request body must contain only a photoIds array.");
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "photoIds") {
    throw invalidInput("Request body must contain only a photoIds array.");
  }

  const photoIds = value.photoIds;
  if (
    !Array.isArray(photoIds) ||
    !photoIds.every((id) => typeof id === "string")
  ) {
    throw invalidInput("photoIds must be an array of photo id strings.");
  }
  if (photoIds.length === 0 || photoIds.length > MAX_FILM_PHOTOS) {
    throw invalidInput(`Choose between 1 and ${MAX_FILM_PHOTOS} photos.`);
  }
  if (photoIds.some((id) => id.length === 0)) {
    throw invalidInput("Photo ids cannot be empty.");
  }
  if (new Set(photoIds).size !== photoIds.length) {
    throw invalidInput("Each photo can only be selected once.");
  }

  return { photoIds: [...photoIds] };
}

export function resolveFilmSelection(
  photoIds: readonly string[],
): ResolvedFilmSelection {
  const matches = loadCollections().flatMap((collection) =>
    collection.photos
      .filter((photo) => photoIds.includes(photo.id))
      .map((photo) => ({ collection, photo })),
  );

  if (matches.length === 0) {
    const sceneCollection = resolveSceneCollection(photoIds);
    if (sceneCollection) {
      return { collection: sceneCollection, photos: sceneCollection.photos };
    }
  }

  if (matches.length !== photoIds.length) {
    throw invalidInput("One or more selected photos are unavailable.");
  }

  const collection = matches[0]?.collection;
  if (!collection) {
    throw invalidInput("Choose at least one photo.");
  }
  if (matches.some((match) => match.collection.id !== collection.id)) {
    throw invalidInput("All selected photos must come from one collection.");
  }

  const photos = matches
    .map((match) => match.photo)
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
  return { collection, photos };
}

export function buildReferenceTags(photoCount: number): string {
  if (
    !Number.isInteger(photoCount) ||
    photoCount < 1 ||
    photoCount > MAX_FILM_PHOTOS
  ) {
    throw invalidInput(
      `Reference photo count must be between 1 and ${MAX_FILM_PHOTOS}.`,
    );
  }

  return Array.from(
    { length: photoCount },
    (_, index) => `<IMAGE_REF_${index}>@Image${index + 1}`,
  ).join(" ");
}

export function buildFilmPrompt(
  promptTemplate: string,
  photoCount: number,
): string {
  const parts = promptTemplate.split(REFERENCE_TAGS_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error(
      "Collection prompt template must contain one reference-tags placeholder.",
    );
  }
  return `${parts[0]}${buildReferenceTags(photoCount)}${parts[1]}`;
}

export function isRealOmniEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    environment.MOCK_OMNI === "0" &&
    Boolean(environment.GEMINI_API_KEY?.trim())
  );
}

export async function checkFilmGenerationCapacity(
  request: Request = new Request("http://localhost/api/film"),
  dependencies: FilmCapacityDependencies = {},
): Promise<FilmCapDecision> {
  const environment = dependencies.environment ?? process.env;
  return checkGenerationCapacity({
    request,
    resource: "film",
    resourceLabel: "film",
    dailyCapEnvironmentVariable: "DAILY_FILM_CAP",
    visitorCapEnvironmentVariable: "VISITOR_FILM_CAP",
    defaultDailyCap: 15,
    defaultVisitorCap: 2,
    realGeneration: isRealOmniEnabled(environment),
    costCents: FILM_COST_CENTS,
    environment,
    ...(dependencies.redis ? { redis: dependencies.redis } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.randomVisitorId
      ? { randomVisitorId: dependencies.randomVisitorId }
      : {}),
  });
}

export function capReachedError(message: string): FilmError {
  return new FilmError("cap-reached", 429, message);
}

/**
 * Denials must stay distinguishable end to end: the UI shows an invitation
 * nudge for auth-required and a spent-credit message for credit-exhausted.
 * Collapsing them into one code would make both look like a generic failure.
 */
export function filmErrorFromDenial(decision: {
  denial: string;
  message: string;
}): FilmError {
  if (decision.denial === "auth-required") {
    return new FilmError("auth-required", 401, decision.message);
  }
  if (decision.denial === "budget-exhausted") {
    return new FilmError("credit-exhausted", 402, decision.message);
  }
  return new FilmError("cap-reached", 429, decision.message);
}

function mimeTypeForPhoto(photo: Photo): OmniReferenceImageMimeType {
  let pathname = photo.file;
  try {
    pathname = new URL(photo.file).pathname;
  } catch {
    // Seeded photos intentionally use root-relative public paths.
  }
  switch (extname(pathname).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      throw new Error("Collection photo has an unsupported image type.");
  }
}

function publicFilePath(photo: Photo): string {
  const relativePath = photo.file.replace(/^\/+/, "");
  const path = resolve(PUBLIC_DIRECTORY, relativePath);
  if (
    path !== PUBLIC_DIRECTORY &&
    !path.startsWith(`${PUBLIC_DIRECTORY}${sep}`)
  ) {
    throw new Error("Collection photo resolves outside the public directory.");
  }
  return path;
}

/** Generated scene photos live in Vercel Blob and nowhere else. */
const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Reference images are fetched server-side and fed straight to a paid model, so
 * an attacker-controlled URL here would turn this route into a free
 * video-generation proxy (architecture §5.5). Descriptor signatures already
 * gate which URLs can arrive, but a signature is one mistake away from being
 * the only defence — this pins the blast radius to our own Blob host.
 */
function assertBlobHosted(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Scene photo URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(BLOB_HOST_SUFFIX)) {
    throw new Error("Scene photo URL is not hosted on Vercel Blob.");
  }
}

async function loadReferenceImages(
  photos: readonly Photo[],
): Promise<readonly OmniReferenceImage[]> {
  return Promise.all(
    photos.map(async (photo) => {
      if (/^https:\/\//u.test(photo.file)) {
        assertBlobHosted(photo.file);
        const response = await fetch(photo.file, {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(`Scene photo returned HTTP ${response.status}.`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) {
          throw new Error("Scene photo has an invalid byte length.");
        }
        return { bytes, mimeType: mimeTypeForPhoto(photo) };
      }
      return {
        bytes: await readFile(publicFilePath(photo)),
        mimeType: mimeTypeForPhoto(photo),
      };
    }),
  );
}

async function materializeOmniVideo(video: OmniVideo): Promise<Uint8Array> {
  if (video.kind === "inline") return video.bytes;

  const directory = await mkdtemp(resolve(tmpdir(), "retold-omni-"));
  const path = resolve(directory, "film.mp4");
  try {
    await writeOmniVideoFile(video, path);
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createVideoBytes(
  selection: ResolvedFilmSelection,
  prompt: string,
): Promise<Uint8Array> {
  if (!isRealOmniEnabled()) {
    await simulateFilmProgress();
    return readFile(MOCK_FILM_PATH);
  }

  try {
    const result = await generateOmniVideo({
      referenceImages: await loadReferenceImages(selection.photos),
      prompt,
    });
    return await materializeOmniVideo(result.video);
  } catch (error) {
    throw filmErrorFromOmniFailure(error);
  }
}

export function filmErrorFromOmniFailure(error: unknown): FilmError {
  // The client only ever sees a user-safe message, but the operator needs the
  // real cause: without this, a failed generation is indistinguishable from any
  // other failure in the logs, and every upstream error looks identical.
  logOmniFailure(error);

  if (error instanceof OmniModelError && error.code === "budget-exceeded") {
    return new FilmError(
      "budget-exceeded",
      402,
      "The Gemini generation budget is exhausted. Please try again later.",
    );
  }
  return new FilmError(
    "upstream-model-error",
    502,
    "Gemini could not create this film. Please try again.",
  );
}

/** Server-side only. Never reaches the client; never includes the API key. */
function logOmniFailure(error: unknown): void {
  const key = process.env.GEMINI_API_KEY;
  const redact = (text: string): string =>
    key ? text.split(key).join("[REDACTED]") : text;

  const detail =
    error instanceof Error
      ? {
          name: error.name,
          code: error instanceof OmniModelError ? error.code : undefined,
          message: redact(error.message),
          cause: error.cause ? redact(String(error.cause)) : undefined,
        }
      : { name: "NonError", message: redact(String(error)) };

  console.error("[film] Omni generation failed:", JSON.stringify(detail));
}

export async function createFilm(
  photoIds: readonly string[],
): Promise<FilmCreationResult> {
  const selection = resolveFilmSelection(photoIds);
  const prompt = buildFilmPrompt(
    selection.collection.promptTemplate,
    selection.photos.length,
  );
  const videoBytes = await createVideoBytes(selection, prompt);

  try {
    const stored = await storeFilmVideo(videoBytes);
    return {
      filmId: stored.filmId,
      url: stored.url,
      shots: [selection.photos.map((photo) => photo.id)],
    };
  } catch {
    throw new FilmError(
      "upstream-model-error",
      502,
      "The generated film could not be saved. Please try again.",
    );
  }
}
