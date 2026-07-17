import manifest from "../data/collections.json";

import type { Collection, Photo } from "../types/library";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    throw new Error(`${path}.${key} must be a string.`);
  }
  return candidate;
}

function readPhoto(value: unknown, path: string): Photo {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }

  const file = readString(value, "file", path);
  const photo: Photo = {
    id: readString(value, "id", path),
    file,
    src: file,
    timestamp: readString(value, "timestamp", path),
    alt: readString(value, "alt", path),
  };

  if (Number.isNaN(Date.parse(photo.timestamp))) {
    throw new Error(`${path}.timestamp must be a valid ISO date.`);
  }

  return photo;
}

function readCollection(value: unknown, index: number): Collection {
  const path = `collections[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object.`);
  }
  if (!Array.isArray(value.photos) || value.photos.length === 0) {
    throw new Error(`${path}.photos must contain at least one photo.`);
  }

  return {
    id: readString(value, "id", path),
    title: readString(value, "title", path),
    dateLabel: readString(value, "dateLabel", path),
    promptTemplate: readString(value, "promptTemplate", path),
    photos: value.photos.map((photo, photoIndex) =>
      readPhoto(photo, `${path}.photos[${photoIndex}]`),
    ),
  };
}

export function loadCollections(): readonly Collection[] {
  const value: unknown = manifest;
  if (!isRecord(value) || !Array.isArray(value.collections)) {
    throw new Error("data/collections.json must contain a collections array.");
  }

  return value.collections.map(readCollection);
}
