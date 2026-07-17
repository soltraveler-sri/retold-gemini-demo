"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { FILM_PROGRESS_STAGES } from "../lib/film-stages";
import type { Collection, Photo } from "../types/library";

const FILM_STORAGE_KEY = "retold.generated-films.v1";

function passthroughImageLoader({ src }: { src: string }): string {
  return src;
}

type GenerationErrorKind = "failed" | "capacity" | "network";

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

interface ActiveGeneration extends FilmSelection {
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

const STAGE_COPY: Record<
  (typeof FILM_PROGRESS_STAGES)[number]["id"],
  { eyebrow: string; title: string; note: string }
> = {
  preparing: {
    eyebrow: "Finding the through-line",
    title: "Studying your photos…",
    note: "Gemini is reading the people, places, and light that hold this moment together.",
  },
  generating: {
    eyebrow: "Building the movement",
    title: "Composing shots…",
    note: "Your selected frames are becoming the anchors of one connected scene.",
  },
  finalizing: {
    eyebrow: "Bringing it home",
    title: "Rendering your film…",
    note: "The final frames are settling into place. This last pass can take a little while.",
  },
};

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
    const value: unknown = JSON.parse(sessionStorage.getItem(FILM_STORAGE_KEY) ?? "[]");
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

function sampleStageDuration(stage: (typeof FILM_PROGRESS_STAGES)[number]): number {
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
  if (status === 429 || status === 402 || code === "cap-reached" || code === "budget-exceeded") {
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
    FILM_PROGRESS_STAGES.slice(0, -1).forEach((stage, stageIndex) => {
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
          const next = [film, ...current.filter((item) => item.filmId !== film.filmId)];
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
            retryAvailable: kind !== "capacity" && !isRetry && !retryUsedRef.current,
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
    if (!selection || generation?.status !== "error" || !generation.error?.retryAvailable) {
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

function AnchorImage({ photo }: { photo: Photo }) {
  const isRemote = photo.src.startsWith("https://");
  return photo.src ? (
    <Image
      alt=""
      className="object-cover"
      draggable={false}
      fill
      {...(isRemote ? { loader: passthroughImageLoader } : {})}
      sizes="(max-width: 640px) 24vw, 120px"
      src={photo.src}
      unoptimized={isRemote}
    />
  ) : (
    <div aria-hidden="true" className="placeholder-tile absolute inset-0" />
  );
}

const ERROR_COPY: Record<
  GenerationErrorKind,
  { eyebrow: string; title: string; note: string; action: string }
> = {
  failed: {
    eyebrow: "The moment is still here",
    title: "The film slipped away.",
    note: "Gemini couldn’t finish this pass. Your photos are still selected, so you can try once more.",
    action: "Retry generation",
  },
  capacity: {
    eyebrow: "A busy screening room",
    title: "The demo is at capacity.",
    note: "Generation is paused for now. Showcase films will be available here while you wait.",
    action: "Back to photos",
  },
  network: {
    eyebrow: "Your selection is safe",
    title: "Connection lost.",
    note: "We couldn’t reach the film service. Check your connection, then try again.",
    action: "Try again",
  },
};

export function GenerationOverlay({
  generation,
  onDismiss,
  onRetry,
}: {
  generation: ActiveGeneration;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const stage = FILM_PROGRESS_STAGES[generation.stageIndex] ?? FILM_PROGRESS_STAGES[0];
  const copy = STAGE_COPY[stage.id];
  const errorCopy = generation.error ? ERROR_COPY[generation.error.kind] : null;

  useEffect(() => {
    if (generation.status !== "error") return;
    actionRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [generation.status, onDismiss]);

  return (
    <div
      aria-labelledby="generation-title"
      aria-modal="true"
      className="fixed inset-0 z-[70] grid overflow-y-auto bg-[#25231f]/45 px-3 py-5 backdrop-blur-md sm:px-8 sm:py-10"
      role="dialog"
    >
      <div className="m-auto w-full max-w-4xl overflow-hidden rounded-[28px] border border-white/60 bg-[#fbfaf7] shadow-[0_30px_90px_rgba(37,35,31,0.28)] sm:rounded-[34px]">
        <div className="border-b border-[#25231f]/10 px-5 py-5 sm:flex sm:items-center sm:justify-between sm:px-8">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8c5746]">
              Retold · {generation.collection.title}
            </p>
            <p className="mt-1 text-xs text-[#777169]">
              {generation.photos.length} film {generation.photos.length === 1 ? "anchor" : "anchors"}
            </p>
          </div>
          <p className="mt-3 text-[11px] font-medium text-[#8a857d] sm:mt-0">
            Usually ready in under a minute
          </p>
        </div>

        <div className="px-5 pb-7 pt-6 sm:px-8 sm:pb-9 sm:pt-8">
          <div aria-label="Selected photos anchoring the film" className="filmstrip">
            {generation.photos.map((photo, index) => (
              <div
                className="film-anchor relative aspect-[4/5] min-w-0 overflow-hidden rounded-[12px]"
                data-active={generation.status === "progress" && index === generation.activeAnchorIndex}
                key={photo.id}
              >
                <AnchorImage photo={photo} />
                <span className="film-anchor-number">{String(index + 1).padStart(2, "0")}</span>
              </div>
            ))}
          </div>

          <div aria-live="polite" className="mx-auto max-w-2xl pb-2 pt-8 text-center sm:pt-10">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8c5746]">
              {errorCopy?.eyebrow ?? copy.eyebrow}
            </p>
            <h2
              className="mt-3 font-editorial text-[clamp(2.3rem,7vw,4.4rem)] font-normal leading-[0.95] tracking-[-0.045em]"
              id="generation-title"
            >
              {errorCopy?.title ?? copy.title}
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-sm leading-6 text-[#6e6961]">
              {errorCopy?.note ?? copy.note}
            </p>

            {generation.status === "progress" ? (
              <div className="mt-7 flex items-center justify-center gap-2" role="status">
                {FILM_PROGRESS_STAGES.map((item, index) => (
                  <span
                    aria-hidden="true"
                    className="generation-stage-dot"
                    data-active={index === generation.stageIndex}
                    data-passed={index < generation.stageIndex}
                    key={item.id}
                  />
                ))}
                <span className="sr-only">{copy.title}</span>
              </div>
            ) : (
              <div className="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
                {generation.error?.retryAvailable ? (
                  <button className="primary-film-action" onClick={onRetry} ref={actionRef} type="button">
                    {errorCopy?.action}
                  </button>
                ) : null}
                <button
                  className="secondary-film-action"
                  onClick={onDismiss}
                  ref={generation.error?.retryAvailable ? undefined : actionRef}
                  type="button"
                >
                  {generation.error?.retryAvailable ? "Keep my selection" : errorCopy?.action}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayMark() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="m9 7 8 5-8 5V7Z" fill="currentColor" />
    </svg>
  );
}

export function GeneratedFilmShelf({
  collection,
  films,
  onOpen,
}: {
  collection: Collection;
  films: readonly GeneratedFilm[];
  onOpen: (film: GeneratedFilm) => void;
}) {
  if (!films.length) return null;

  return (
    <div className="mt-4 rounded-[20px] border border-[#25231f]/10 bg-[#f4f0e9] p-3 sm:mt-5 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-4 px-1">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8c5746]">Your films</p>
          <p className="mt-0.5 text-xs text-[#777169]">Kept with this moment for this session</p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a857d]">
          {films.length} {films.length === 1 ? "film" : "films"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {films.map((film) => {
          const anchors = film.photoIds
            .map((id) => collection.photos.find((photo) => photo.id === id))
            .filter((photo): photo is Photo => Boolean(photo))
            .slice(0, 3);
          return (
            <button
              className="group flex min-w-0 items-center gap-3 rounded-[15px] border border-[#25231f]/10 bg-[#fbfaf7] p-2 text-left transition hover:-translate-y-0.5 hover:border-[#8c5746]/35 hover:shadow-[0_8px_22px_rgba(37,35,31,0.09)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746]"
              key={film.filmId}
              onClick={() => onOpen(film)}
              type="button"
            >
              <span className="relative grid h-16 w-[84px] shrink-0 grid-cols-3 overflow-hidden rounded-[10px] bg-[#25231f]">
                {anchors.map((photo) => (
                  <span className="relative" key={photo.id}>
                    <AnchorImage photo={photo} />
                  </span>
                ))}
                <span className="absolute inset-0 grid place-items-center bg-[#25231f]/20 text-white">
                  <span className="grid size-8 place-items-center rounded-full bg-[#25231f]/75 shadow-lg">
                    <span className="size-4"><PlayMark /></span>
                  </span>
                </span>
              </span>
              <span className="min-w-0">
                <span className="block font-editorial text-lg leading-5 tracking-[-0.02em]">Play your film</span>
                <span className="mt-1 block truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8c5746]">
                  Gemini Omni · Preview
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ShowcaseFilmCard({
  collection,
  onOpen,
}: {
  collection: Collection;
  onOpen: () => void;
}) {
  const anchors = collection.photos.slice(0, 3);

  return (
    <div className="showcase-card mt-4 overflow-hidden rounded-[20px] border border-[#8c5746]/20 bg-[#f5eee9] sm:mt-5">
      <div className="flex flex-col gap-4 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="relative grid h-[72px] w-[96px] shrink-0 grid-cols-3 overflow-hidden rounded-[12px] bg-[#25231f] shadow-[0_7px_22px_rgba(72,48,40,0.14)]">
            {anchors.map((photo) => (
              <span className="relative" key={photo.id}>
                <AnchorImage photo={photo} />
              </span>
            ))}
            <span className="absolute inset-0 grid place-items-center bg-[#6f4436]/20 text-white">
              <span className="grid size-9 place-items-center rounded-full border border-white/30 bg-[#6f4436]/85 shadow-lg">
                <span className="size-4"><PlayMark /></span>
              </span>
            </span>
          </span>
          <span className="min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.19em] text-[#8c5746]">
              Pre-generated example
            </span>
            <span className="mt-1 block font-editorial text-xl leading-6 tracking-[-0.025em] sm:text-2xl">
              See how this moment could move
            </span>
            <span className="mt-1 block text-xs leading-5 text-[#6e6961]">
              A ready-made preview from these seeded photos — never from your selection.
            </span>
          </span>
        </div>
        <button
          className="showcase-film-action shrink-0 self-start sm:self-auto"
          onClick={onOpen}
          type="button"
        >
          <span aria-hidden="true">▶</span>
          Watch an example film
          <span className="showcase-zero-cost">Free · instant</span>
        </button>
      </div>
    </div>
  );
}

function ReplayIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M5.2 6.1H2.7V3.6M3 6a7 7 0 1 1-.6 7.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M10 2.8v9.1m0 0 3.2-3.2M10 11.9 6.8 8.7M4 15.8h12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

export function FilmLightbox({
  film,
  collection,
  mode = "generated",
  onClose,
}: {
  film: Pick<GeneratedFilm, "filmId" | "photoIds" | "url">;
  collection: Collection | undefined;
  mode?: "generated" | "showcase";
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [videoError, setVideoError] = useState(false);
  const isShowcase = mode === "showcase";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const replay = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    void video.play();
  };

  return (
    <div
      aria-labelledby="film-player-title"
      aria-modal="true"
      className="fixed inset-0 z-[80] grid overflow-y-auto bg-[#181714]/90 px-3 py-4 backdrop-blur-xl sm:px-8 sm:py-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="m-auto w-full max-w-6xl overflow-hidden rounded-[24px] border border-white/10 bg-[#25231f] text-white shadow-[0_35px_100px_rgba(0,0,0,0.48)] sm:rounded-[30px]">
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="min-w-0">
            <p className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-[#ddb09b]">
              {isShowcase ? "Pre-generated example" : collection?.title ?? "Your moment"}
            </p>
            <h2 className="mt-0.5 font-editorial text-xl tracking-[-0.02em] sm:text-2xl" id="film-player-title">
              {isShowcase ? `${collection?.title ?? "Example"} — example film` : "Your film"}
            </h2>
          </div>
          <button
            aria-label="Close film"
            className="grid size-10 shrink-0 place-items-center rounded-full border border-white/15 bg-white/[0.06] text-xl text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ddb09b]"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="grid min-h-[min(68vh,560px)] place-items-center bg-black">
          {videoError ? (
            <div className="max-w-md px-6 py-16 text-center" role="status">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#ddb09b]">
                {isShowcase ? "Preview coming soon" : "Playback unavailable"}
              </p>
              <p className="mt-3 font-editorial text-3xl tracking-[-0.03em]">
                {isShowcase
                  ? "This example film is not available yet."
                  : "This film could not be loaded."}
              </p>
              <p className="mt-3 text-sm leading-6 text-white/55">
                {isShowcase
                  ? "The photos are ready to explore. The pre-generated film can be added later without changing this page."
                  : "Close the player and try opening the film again."}
              </p>
            </div>
          ) : (
            <video
              autoPlay
              className="mx-auto block max-h-[68vh] w-full bg-black object-contain"
              controls
              onError={() => setVideoError(true)}
              playsInline
              preload="metadata"
              ref={videoRef}
              src={film.url}
            >
              Your browser does not support the video element.
            </video>
          )}
        </div>

        <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#ddb09b]">
              {isShowcase ? "Pre-generated with Gemini Omni (preview)" : "Generated with Gemini Omni (preview)"}
            </p>
            <p className="mt-1 text-xs text-white/50">
              {isShowcase
                ? `A ready-made example from all ${film.photoIds.length} seeded photos — not your selection`
                : `Built from ${film.photoIds.length} selected ${film.photoIds.length === 1 ? "photo" : "photos"}`}
            </p>
          </div>
          {!videoError ? (
            <div className="flex items-center gap-2">
              <button className="dark-film-action" onClick={replay} type="button">
                <span className="size-4"><ReplayIcon /></span>
                Replay
              </button>
              <a className="dark-film-action" download={`retold-${film.filmId}.mp4`} href={film.url}>
                <span className="size-4"><DownloadIcon /></span>
                Download
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
