"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  FILM_PROGRESS_STAGES,
  TWO_CHUNK_FILM_PROGRESS_STAGES,
  type FilmProgressStage,
} from "../lib/film-stages";
import type { Collection, Photo } from "../types/library";

const FILM_STORAGE_KEY = "retold.generated-films.v1";

export type GenerationErrorKind =
  | "failed"
  | "capacity"
  /** No invitation: the visitor must be nudged, not shown an error. */
  | "access"
  /** Signed in, but their own demo credit is spent. */
  | "credit"
  | "network";

interface FilmApiResponse {
  filmId: string;
  url: string;
  shots: readonly (readonly string[])[];
}

interface FilmApiError {
  error?: {
    code?: string;
    message?: string;
  };
}

export interface GeneratedFilm {
  filmId: string;
  url: string;
  shots: readonly (readonly string[])[];
  collectionId: string;
  photoIds: readonly string[];
  createdAt: string;
}

interface FilmSelection {
  collection: Collection;
  photos: readonly Photo[];
}

interface GenerationError {
  kind: GenerationErrorKind;
  retryAvailable: boolean;
}

export interface ActiveGeneration extends FilmSelection {
  status: "progress" | "error";
  stageIndex: number;
  activeAnchorIndex: number;
  error: GenerationError | null;
}

interface FilmGenerationController {
  activeFilm: GeneratedFilm | null;
  closeFilm: () => void;
  dismissError: () => void;
  films: readonly GeneratedFilm[];
  generation: ActiveGeneration | null;
  isGenerating: boolean;
  openFilm: (film: GeneratedFilm) => void;
  retry: () => void;
  start: (selection: FilmSelection) => void;
}

function isFilmApiResponse(value: unknown): value is FilmApiResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FilmApiResponse>;
  return (
    typeof candidate.filmId === "string" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.shots)
  );
}

function isGeneratedFilm(value: unknown): value is GeneratedFilm {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GeneratedFilm>;
  return (
    typeof candidate.filmId === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.collectionId === "string" &&
    typeof candidate.createdAt === "string" &&
    Array.isArray(candidate.photoIds) &&
    candidate.photoIds.every((id) => typeof id === "string") &&
    Array.isArray(candidate.shots)
  );
}

function readStoredFilms(): readonly GeneratedFilm[] {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(FILM_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(value) ? value.filter(isGeneratedFilm) : [];
  } catch {
    return [];
  }
}

function storeFilms(films: readonly GeneratedFilm[]): void {
  try {
    sessionStorage.setItem(FILM_STORAGE_KEY, JSON.stringify(films));
  } catch {
    // The film remains available in memory when storage is unavailable.
  }
}

export function progressStagesForPhotoCount(
  photoCount: number,
): readonly FilmProgressStage[] {
  return photoCount > 6
    ? TWO_CHUNK_FILM_PROGRESS_STAGES
    : FILM_PROGRESS_STAGES;
}

function sampleStageDuration(stage: FilmProgressStage): number {
  return (
    stage.minDurationMs +
    Math.floor(Math.random() * (stage.maxDurationMs - stage.minDurationMs + 1))
  );
}

function forcedErrorFromUrl(): GenerationErrorKind | null {
  const value = new URLSearchParams(window.location.search).get("mockError");
  if (value === "network") return "network";
  if (value === "cap-reached" || value === "capacity") return "capacity";
  if (value === "upstream-model-error" || value === "generation") return "failed";
  return null;
}

function generationErrorFromResponse(
  status: number,
  payload: FilmApiError,
): GenerationErrorKind {
  const code = payload.error?.code;
  if (status === 401 || code === "auth-required") return "access";
  if (code === "credit-exhausted") return "credit";
  // 402 budget-exceeded is Gemini's OWN budget, not the visitor's credit.
  if (
    status === 429 ||
    status === 402 ||
    code === "cap-reached" ||
    code === "budget-exceeded"
  ) {
    return "capacity";
  }
  return "failed";
}

function clearTimers(timers: RefObject<number[]>): void {
  for (const timer of timers.current) window.clearTimeout(timer);
  timers.current = [];
}

export function useFilmGeneration(
  onSuccess: () => void,
): FilmGenerationController {
  const [films, setFilms] = useState<readonly GeneratedFilm[]>([]);
  const [generation, setGeneration] = useState<ActiveGeneration | null>(null);
  const [activeFilm, setActiveFilm] = useState<GeneratedFilm | null>(null);
  const timersRef = useRef<number[]>([]);
  const anchorTimerRef = useRef<number | null>(null);
  const selectionRef = useRef<FilmSelection | null>(null);
  const retryUsedRef = useRef(false);
  const forcedErrorConsumedRef = useRef(false);
  const requestIdRef = useRef(0);

  const stopProgress = useCallback(() => {
    clearTimers(timersRef);
    if (anchorTimerRef.current !== null) {
      window.clearInterval(anchorTimerRef.current);
      anchorTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    setFilms(readStoredFilms());
    return () => {
      clearTimers(timersRef);
      if (anchorTimerRef.current !== null) {
        window.clearInterval(anchorTimerRef.current);
      }
      requestIdRef.current += 1;
    };
  }, []);

  const beginProgress = useCallback((selection: FilmSelection) => {
    clearTimers(timersRef);
    if (anchorTimerRef.current !== null) {
      window.clearInterval(anchorTimerRef.current);
    }

    setGeneration({
      ...selection,
      status: "progress",
      stageIndex: 0,
      activeAnchorIndex: 0,
      error: null,
    });

    let elapsed = 0;
    const progressStages = progressStagesForPhotoCount(selection.photos.length);
    progressStages.slice(0, -1).forEach((stage, stageIndex) => {
      elapsed += sampleStageDuration(stage);
      timersRef.current.push(
        window.setTimeout(() => {
          setGeneration((current) =>
            current?.status === "progress"
              ? { ...current, stageIndex: stageIndex + 1 }
              : current,
          );
        }, elapsed),
      );
    });

    if (selection.photos.length > 1) {
      anchorTimerRef.current = window.setInterval(() => {
        setGeneration((current) =>
          current?.status === "progress"
            ? {
                ...current,
                activeAnchorIndex:
                  (current.activeAnchorIndex + 1) % current.photos.length,
              }
            : current,
        );
      }, 1_800);
    }
  }, []);

  const runGeneration = useCallback(
    async (selection: FilmSelection, isRetry: boolean) => {
      const requestId = ++requestIdRef.current;
      beginProgress(selection);

      try {
        const forcedError = forcedErrorConsumedRef.current
          ? null
          : forcedErrorFromUrl();
        if (forcedError) {
          forcedErrorConsumedRef.current = true;
          await new Promise((resolve) => window.setTimeout(resolve, 650));
          if (forcedError === "network") throw new TypeError("Failed to fetch");
          throw { forcedError };
        }

        const response = await fetch("/api/film", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            photoIds: selection.photos.map((photo) => photo.id),
          }),
        });
        const payload: unknown = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw {
            responseError: generationErrorFromResponse(
              response.status,
              payload as FilmApiError,
            ),
          };
        }
        if (!isFilmApiResponse(payload)) throw { responseError: "failed" };
        if (requestId !== requestIdRef.current) return;

        const film: GeneratedFilm = {
          ...payload,
          collectionId: selection.collection.id,
          photoIds: selection.photos.map((photo) => photo.id),
          createdAt: new Date().toISOString(),
        };
        stopProgress();
        setFilms((current) => {
          const next = [
            film,
            ...current.filter((item) => item.filmId !== film.filmId),
          ];
          storeFilms(next);
          return next;
        });
        setGeneration(null);
        setActiveFilm(film);
        selectionRef.current = null;
        onSuccess();
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        stopProgress();

        let kind: GenerationErrorKind = "failed";
        if (error instanceof TypeError) {
          kind = "network";
        } else if (typeof error === "object" && error !== null) {
          if ("forcedError" in error) {
            kind = (error as { forcedError: GenerationErrorKind }).forcedError;
          } else if ("responseError" in error) {
            kind = (error as { responseError: GenerationErrorKind }).responseError;
          }
        }

        setGeneration({
          ...selection,
          status: "error",
          stageIndex: 0,
          activeAnchorIndex: 0,
          error: {
            kind,
            // Retry only helps for transient failures. A cap, a missing invitation,
            // or a spent credit will fail identically every time.
            retryAvailable:
              kind !== "capacity" &&
              kind !== "access" &&
              kind !== "credit" &&
              !isRetry &&
              !retryUsedRef.current,
          },
        });
      }
    },
    [beginProgress, onSuccess, stopProgress],
  );

  const start = useCallback(
    (selection: FilmSelection) => {
      if (!selection.photos.length || generation?.status === "progress") return;
      selectionRef.current = selection;
      retryUsedRef.current = false;
      forcedErrorConsumedRef.current = false;
      void runGeneration(selection, false);
    },
    [generation?.status, runGeneration],
  );

  const retry = useCallback(() => {
    const selection = selectionRef.current;
    if (
      !selection ||
      generation?.status !== "error" ||
      !generation.error?.retryAvailable
    ) {
      return;
    }
    retryUsedRef.current = true;
    void runGeneration(selection, true);
  }, [generation, runGeneration]);

  const dismissError = useCallback(() => {
    if (generation?.status !== "error") return;
    requestIdRef.current += 1;
    stopProgress();
    setGeneration(null);
    selectionRef.current = null;
  }, [generation?.status, stopProgress]);
  const closeFilm = useCallback(() => setActiveFilm(null), []);

  return {
    activeFilm,
    closeFilm,
    dismissError,
    films,
    generation,
    isGenerating: generation?.status === "progress",
    openFilm: setActiveFilm,
    retry,
    start,
  };
}
