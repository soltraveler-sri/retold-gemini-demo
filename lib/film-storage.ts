import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const LOCAL_FILM_DIRECTORY = resolve(process.cwd(), ".blob-dev", "films");
const FILM_PATH_PREFIX = "films";
const FILM_ID_PATTERN =
  /^(blob|local)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type FilmStorageKind = "blob" | "local";

export interface StoredFilm {
  filmId: string;
  status: "completed";
  storage: FilmStorageKind;
  url: string;
}

function blobToken(): string | undefined {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  return token ? token : undefined;
}

function filmPathname(filmId: string): string {
  return `${FILM_PATH_PREFIX}/${filmId}.mp4`;
}

function localFilmPath(filmId: string): string {
  return resolve(LOCAL_FILM_DIRECTORY, `${filmId}.mp4`);
}

export function isFilmId(value: string): boolean {
  return FILM_ID_PATTERN.test(value);
}

export function isLocalFilmId(value: string): boolean {
  return isFilmId(value) && value.startsWith("local_");
}

export async function storeFilmVideo(
  bytes: Uint8Array,
  contentType = "video/mp4",
): Promise<StoredFilm> {
  const token = blobToken();
  const storage: FilmStorageKind = token ? "blob" : "local";
  const filmId = `${storage}_${randomUUID()}`;

  if (token) {
    const { put } = await import("@vercel/blob");
    const blob = await put(filmPathname(filmId), Buffer.from(bytes), {
      access: "public",
      addRandomSuffix: false,
      contentType,
      token,
    });
    return { filmId, status: "completed", storage, url: blob.url };
  }

  await mkdir(LOCAL_FILM_DIRECTORY, { recursive: true });
  await writeFile(localFilmPath(filmId), bytes);
  return {
    filmId,
    status: "completed",
    storage,
    url: `/api/film/${filmId}/video`,
  };
}

export async function findStoredFilm(
  filmId: string,
): Promise<StoredFilm | undefined> {
  if (!isFilmId(filmId)) return undefined;

  if (isLocalFilmId(filmId)) {
    try {
      await stat(localFilmPath(filmId));
      return {
        filmId,
        status: "completed",
        storage: "local",
        url: `/api/film/${filmId}/video`,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  const token = blobToken();
  if (!token) {
    throw new Error("Vercel Blob is not configured for this film lookup.");
  }

  const { BlobNotFoundError, head } = await import("@vercel/blob");
  try {
    const blob = await head(filmPathname(filmId), { token });
    return {
      filmId,
      status: "completed",
      storage: "blob",
      url: blob.url,
    };
  } catch (error) {
    if (error instanceof BlobNotFoundError) return undefined;
    throw error;
  }
}

export async function readLocalFilmVideo(
  filmId: string,
): Promise<Buffer | undefined> {
  if (!isLocalFilmId(filmId)) return undefined;
  try {
    return await readFile(localFilmPath(filmId));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
