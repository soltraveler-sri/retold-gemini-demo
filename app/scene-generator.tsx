"use client";

import { useEffect, useState, type FormEvent } from "react";

import { MAX_SCENE_PROMPT_LENGTH } from "../lib/scene-contract";
import type { Collection } from "../types/library";

interface SceneApiResponse {
  collection: Collection;
}

interface SceneApiError {
  error?: { code?: string; message?: string };
}

const PROGRESS_NOTES = [
  "Establishing the people and place…",
  "Following the moment as the light changes…",
  "Settling the last frames into the camera roll…",
] as const;

function isCollection(value: unknown): value is Collection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Collection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.dateLabel === "string" &&
    typeof candidate.promptTemplate === "string" &&
    typeof candidate.showcaseFilm === "string" &&
    Array.isArray(candidate.photos) &&
    candidate.photos.length >= 5 &&
    candidate.photos.length <= 6 &&
    candidate.photos.every(
      (photo) =>
        typeof photo === "object" &&
        photo !== null &&
        typeof photo.id === "string" &&
        typeof photo.file === "string" &&
        typeof photo.src === "string" &&
        typeof photo.timestamp === "string" &&
        typeof photo.alt === "string",
    )
  );
}

function sceneEndpoint(): string {
  const forced = new URLSearchParams(window.location.search).get(
    "mockSceneError",
  );
  return forced === "refusal" || forced === "failed" || forced === "capacity"
    ? `/api/scene?mockError=${forced}`
    : "/api/scene";
}

export function SceneGenerator({
  disabled,
  onCreated,
  signedIn,
  onAccessRequired,
}: {
  disabled: boolean;
  onCreated: (collection: Collection) => void;
  /** Scene generation costs real money, so it is gated like film generation. */
  signedIn: boolean;
  onAccessRequired: (creditMessage?: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isGenerating) return;
    const interval = window.setInterval(() => {
      setProgressIndex((current) =>
        Math.min(current + 1, PROGRESS_NOTES.length - 1),
      );
    }, 4_500);
    return () => window.clearInterval(interval);
  }, [isGenerating]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Nudge before spending a round-trip; the server still gates the real call.
    if (!signedIn) {
      onAccessRequired();
      return;
    }
    if (disabled || isGenerating || !prompt.trim()) return;
    setError(null);
    setProgressIndex(0);
    setIsGenerating(true);
    try {
      const response = await fetch(sceneEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = (payload as SceneApiError).error?.code;
        if (response.status === 401 || code === "auth-required") {
          onAccessRequired();
          return;
        }
        if (code === "credit-exhausted") {
          onAccessRequired((payload as SceneApiError).error?.message);
          return;
        }
        const message = (payload as SceneApiError).error?.message;
        throw new Error(
          typeof message === "string"
            ? message
            : "Gemini couldn’t create that camera roll. Please try again.",
        );
      }
      const collection = (payload as Partial<SceneApiResponse>).collection;
      if (!isCollection(collection)) {
        throw new Error("The camera roll came back incomplete. Please try again.");
      }
      onCreated(collection);
      setPrompt("");
    } catch (caught) {
      setError(
        caught instanceof TypeError
          ? "The connection slipped. Your scene wasn’t generated — please try again."
          : caught instanceof Error
            ? caught.message
            : "Gemini couldn’t create that camera roll. Please try again.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <section
      aria-labelledby="scene-generator-title"
      className="mt-20 overflow-hidden rounded-[26px] border border-[#8c5746]/20 bg-[#f5eee9] shadow-[0_18px_55px_rgba(82,57,47,0.08)] sm:mt-28 sm:rounded-[32px]"
    >
      <div className="grid gap-8 px-5 py-7 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,0.8fr)_minmax(420px,1.2fr)] lg:items-end lg:px-10 lg:py-10">
        <div className="max-w-xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8c5746]">
            Imagine another moment
          </p>
          <h2
            className="mt-3 font-editorial text-[clamp(2.1rem,4vw,3.7rem)] leading-[0.98] tracking-[-0.045em]"
            id="scene-generator-title"
          >
            Make the camera roll itself.
          </h2>
          <p className="mt-4 max-w-lg text-sm leading-6 text-[#6e6961]">
            Think of a memorable scene, and Gemini will generate the camera
            roll. Then select the photos and turn them into a film.
          </p>
        </div>

        <form className="rounded-[20px] border border-[#25231f]/10 bg-[#fbfaf7] p-3 shadow-[0_8px_28px_rgba(37,35,31,0.07)] sm:p-4" onSubmit={submit}>
          <label className="sr-only" htmlFor="scene-prompt">
            Describe a memorable scene
          </label>
          <textarea
            className="min-h-24 w-full resize-none border-0 bg-transparent px-1 py-1 font-editorial text-xl leading-7 text-[#25231f] outline-none placeholder:text-[#9a948a] sm:min-h-28 sm:text-2xl"
            disabled={disabled || isGenerating}
            id="scene-prompt"
            maxLength={MAX_SCENE_PROMPT_LENGTH}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="A late-summer supper under the olive trees…"
            value={prompt}
          />
          <div className="mt-2 flex flex-col gap-3 border-t border-[#25231f]/10 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#777169]">
                Fictional adults only · no names or likenesses
              </p>
              <p className="mt-1 text-[10px] text-[#9a948a]">
                {prompt.length}/{MAX_SCENE_PROMPT_LENGTH}
              </p>
            </div>
            <button
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-[14px] bg-[#25231f] px-5 text-[12px] font-semibold text-white shadow-[0_5px_16px_rgba(37,35,31,0.14)] transition hover:-translate-y-px hover:bg-[#34312c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0"
              disabled={disabled || isGenerating || prompt.trim().length < 4}
              type="submit"
            >
              {isGenerating ? "Generating six photos…" : "Generate camera roll"}
            </button>
          </div>
          <div aria-live="polite">
            {isGenerating ? (
              <div className="mt-3 flex items-center gap-2 rounded-[12px] bg-[#f5eee9] px-3 py-2.5 text-[11px] font-medium text-[#6f4436]" role="status">
                <span className="size-2 animate-pulse rounded-full bg-[#8c5746]" />
                {PROGRESS_NOTES[progressIndex]}
              </div>
            ) : null}
            {error ? (
              <div className="mt-3 rounded-[12px] border border-[#8c5746]/20 bg-[#f8e9e4] px-3 py-2.5 text-[12px] leading-5 text-[#6f4436]" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}
