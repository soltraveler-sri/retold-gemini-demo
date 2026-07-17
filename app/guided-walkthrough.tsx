"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { FILM_PROGRESS_STAGES } from "../lib/film-stages";
import type { Collection } from "../types/library";
import { FilmLightbox, GenerationOverlay } from "./film-generation";

const OPEN_WALKTHROUGH_EVENT = "retold:open-guided-walkthrough";
const WALKTHROUGH_ANCHOR_COUNT = 6;
const COMPRESSED_STAGE_DURATION_MS = {
  preparing: 1_050,
  generating: 2_200,
  finalizing: 1_050,
} as const;

type WalkthroughPhase = "selecting" | "creating" | "progress" | "film";

interface WalkthroughState {
  collection: Collection;
  phase: WalkthroughPhase;
  stageIndex: number;
  activeAnchorIndex: number;
}

interface SelectionDescriptor {
  collectionId: string;
  photoIndex: number;
}

interface CursorPosition {
  x: number;
  y: number;
  clicking: boolean;
}

interface OpenWalkthroughDetail {
  collectionId?: string;
}

/**
 * Opens the zero-cost guided walkthrough. Omit `collectionId` to lead with the
 * courtyard wedding, or pass any seeded collection that has a showcase film.
 */
export function openGuidedWalkthrough(collectionId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenWalkthroughDetail>(OPEN_WALKTHROUGH_EVENT, {
      detail: collectionId ? { collectionId } : {},
    }),
  );
}

function collectionTiles(collectionId: string): readonly HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      ".photo-tile[data-collection-id][data-photo-index]",
    ),
  ).filter((tile) => tile.dataset.collectionId === collectionId);
}

function selectionButton(
  collectionId: string,
  photoIndex: number,
): HTMLButtonElement | null {
  const tile = collectionTiles(collectionId).find(
    (item) => Number(item.dataset.photoIndex) === photoIndex,
  );
  return tile?.querySelector<HTMLButtonElement>(".photo-check-target") ?? null;
}

function currentSelection(): readonly SelectionDescriptor[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.photo-tile[data-selected="true"][data-collection-id][data-photo-index]',
    ),
  )
    .map((tile) => ({
      collectionId: tile.dataset.collectionId ?? "",
      photoIndex: Number(tile.dataset.photoIndex),
    }))
    .filter(
      (item) => item.collectionId && Number.isInteger(item.photoIndex),
    );
}

function clearLibrarySelection(): void {
  for (const selected of currentSelection()) {
    selectionButton(selected.collectionId, selected.photoIndex)?.click();
  }
}

function restoreLibrarySelection(
  selection: readonly SelectionDescriptor[],
): void {
  clearLibrarySelection();
  for (const selected of selection) {
    selectionButton(selected.collectionId, selected.photoIndex)?.click();
  }
}

function pointFor(element: HTMLElement): CursorPosition {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    clicking: false,
  };
}

function phaseLabel(phase: WalkthroughPhase): string {
  switch (phase) {
    case "selecting":
      return "1 of 3 · Selecting the anchor photos";
    case "creating":
      return "2 of 3 · One Gemini tap";
    case "progress":
      return "3 of 3 · Replaying the generation wait";
    case "film":
      return "Pre-generated example film";
  }
}

function DemoCursor({ position }: { position: CursorPosition }) {
  return (
    <div
      aria-hidden="true"
      className="walkthrough-cursor fixed z-[65] pointer-events-none"
      data-clicking={position.clicking}
      style={
        {
          "--walkthrough-cursor-x": `${position.x}px`,
          "--walkthrough-cursor-y": `${position.y}px`,
        } as CSSProperties
      }
    >
      <span className="walkthrough-cursor-pulse" />
      <svg fill="none" viewBox="0 0 28 34">
        <path
          d="M3.5 2.75v24.6l6.2-5.8 4.2 9.25 4.05-1.85-4.2-9.05 8.35-.2L3.5 2.75Z"
          fill="#25231f"
          stroke="#fbfaf7"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}

export function GuidedWalkthrough({
  collections,
}: {
  collections: readonly Collection[];
}) {
  const [walkthrough, setWalkthrough] = useState<WalkthroughState | null>(null);
  const [cursor, setCursor] = useState<CursorPosition | null>(null);
  const timersRef = useRef<number[]>([]);
  const originalSelectionRef = useRef<readonly SelectionDescriptor[]>([]);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const isActiveRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const closeWalkthrough = useCallback(() => {
    if (!isActiveRef.current) return;
    isActiveRef.current = false;
    clearTimers();
    restoreLibrarySelection(originalSelectionRef.current);
    originalSelectionRef.current = [];
    setCursor(null);
    setWalkthrough(null);
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  }, [clearTimers]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if (isActiveRef.current) return;
      const requestedCollectionId = (
        event as CustomEvent<OpenWalkthroughDetail>
      ).detail?.collectionId;
      const collection =
        collections.find(
          (item) =>
            item.id === requestedCollectionId && Boolean(item.showcaseFilm),
        ) ??
        collections.find(
          (item) => item.id === "wedding-evening" && Boolean(item.showcaseFilm),
        ) ??
        collections.find((item) => Boolean(item.showcaseFilm));
      if (!collection) return;

      isActiveRef.current = true;
      originalSelectionRef.current = currentSelection();
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      clearLibrarySelection();
      setWalkthrough({
        collection,
        phase: "selecting",
        stageIndex: 0,
        activeAnchorIndex: 0,
      });

      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const tiles = collectionTiles(collection.id).slice(
        0,
        WALKTHROUGH_ANCHOR_COUNT,
      );
      tiles[0]?.closest("section")?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
      });

      const scrollSettleMs = reduceMotion ? 80 : 650;
      timersRef.current.push(
        window.setTimeout(() => {
          const buttons = tiles
            .map((tile) =>
              tile.querySelector<HTMLButtonElement>(".photo-check-target"),
            )
            .filter((button): button is HTMLButtonElement => Boolean(button));
          const firstButton = buttons[0];
          if (!firstButton) {
            closeWalkthrough();
            return;
          }

          const firstPoint = pointFor(firstButton);
          setCursor(
            reduceMotion
              ? null
              : {
                  x: Math.max(18, firstPoint.x - 86),
                  y: Math.max(78, firstPoint.y - 68),
                  clicking: false,
                },
          );

          const entranceMs = reduceMotion ? 80 : 520;
          timersRef.current.push(
            window.setTimeout(() => {
              if (!reduceMotion) setCursor(firstPoint);
            }, reduceMotion ? 0 : 60),
          );

          buttons.forEach((button, index) => {
            const moveAt = entranceMs + index * (reduceMotion ? 230 : 360);
            const selectAt = moveAt + (reduceMotion ? 70 : 250);
            timersRef.current.push(
              window.setTimeout(() => {
                if (!reduceMotion) setCursor(pointFor(button));
              }, moveAt),
              window.setTimeout(() => {
                button.click();
                if (!reduceMotion) {
                  setCursor({ ...pointFor(button), clicking: true });
                  timersRef.current.push(
                    window.setTimeout(
                      () => setCursor(pointFor(button)),
                      130,
                    ),
                  );
                }
              }, selectAt),
            );
          });

          const selectionDoneAt =
            entranceMs +
            Math.max(0, buttons.length - 1) * (reduceMotion ? 230 : 360) +
            (reduceMotion ? 360 : 680);
          timersRef.current.push(
            window.setTimeout(() => {
              setWalkthrough((current) =>
                current ? { ...current, phase: "creating" } : null,
              );
              const createButton =
                document.querySelector<HTMLButtonElement>(
                  '[aria-label="Photo actions"] .gemini-action',
                );
              if (createButton && !reduceMotion) {
                setCursor(pointFor(createButton));
              }
            }, selectionDoneAt),
          );

          const pressAt = selectionDoneAt + (reduceMotion ? 240 : 720);
          timersRef.current.push(
            window.setTimeout(() => {
              const createButton =
                document.querySelector<HTMLButtonElement>(
                  '[aria-label="Photo actions"] .gemini-action',
                );
              if (createButton && !reduceMotion) {
                setCursor({ ...pointFor(createButton), clicking: true });
              }
            }, pressAt),
            window.setTimeout(() => {
              setCursor(null);
              setWalkthrough((current) =>
                current
                  ? {
                      ...current,
                      phase: "progress",
                      stageIndex: 0,
                      activeAnchorIndex: 0,
                    }
                  : null,
              );

              let elapsed = 0;
              FILM_PROGRESS_STAGES.forEach((stage, stageIndex) => {
                if (stageIndex > 0) {
                  timersRef.current.push(
                    window.setTimeout(() => {
                      setWalkthrough((current) =>
                        current?.phase === "progress"
                          ? { ...current, stageIndex }
                          : current,
                      );
                    }, elapsed),
                  );
                }
                elapsed += COMPRESSED_STAGE_DURATION_MS[stage.id];
              });

              const anchorCount = Math.max(1, buttons.length);
              for (let tick = 1; tick * 560 < elapsed; tick += 1) {
                timersRef.current.push(
                  window.setTimeout(() => {
                    setWalkthrough((current) =>
                      current?.phase === "progress"
                        ? {
                            ...current,
                            activeAnchorIndex: tick % anchorCount,
                          }
                        : current,
                    );
                  }, tick * 560),
                );
              }

              timersRef.current.push(
                window.setTimeout(() => {
                  setWalkthrough((current) =>
                    current ? { ...current, phase: "film" } : null,
                  );
                }, elapsed),
              );
            }, pressAt + (reduceMotion ? 120 : 180)),
          );
        }, scrollSettleMs),
      );
    };

    window.addEventListener(OPEN_WALKTHROUGH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WALKTHROUGH_EVENT, onOpen);
  }, [closeWalkthrough, collections]);

  const walkthroughIsOpen = walkthrough !== null;

  useEffect(() => {
    if (!walkthroughIsOpen) return;
    skipRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWalkthrough();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeWalkthrough, walkthroughIsOpen]);

  useEffect(
    () => () => {
      clearTimers();
      if (isActiveRef.current) {
        restoreLibrarySelection(originalSelectionRef.current);
      }
    },
    [clearTimers],
  );

  if (!walkthrough) return null;

  const walkthroughPhotos = walkthrough.collection.photos.slice(
    0,
    WALKTHROUGH_ANCHOR_COUNT,
  );
  const generation = {
    collection: walkthrough.collection,
    photos: walkthroughPhotos,
    status: "progress" as const,
    stageIndex: walkthrough.stageIndex,
    activeAnchorIndex: walkthrough.activeAnchorIndex,
    error: null,
  };
  return (
    <>
      <style>{`
        .walkthrough-cursor {
          left: 0;
          top: 0;
          width: 28px;
          height: 34px;
          transform: translate3d(var(--walkthrough-cursor-x), var(--walkthrough-cursor-y), 0);
          transform-origin: 3px 3px;
          transition: transform 330ms cubic-bezier(.22,.82,.28,1);
          filter: drop-shadow(0 5px 8px rgba(37,35,31,.22));
        }
        .walkthrough-cursor[data-clicking="true"] {
          transform: translate3d(var(--walkthrough-cursor-x), var(--walkthrough-cursor-y), 0) scale(.84);
          transition-duration: 90ms;
        }
        .walkthrough-cursor-pulse {
          position: absolute;
          left: -10px;
          top: -10px;
          width: 30px;
          height: 30px;
          border: 1px solid rgba(140,87,70,.55);
          border-radius: 999px;
          opacity: 0;
          transform: scale(.45);
        }
        .walkthrough-cursor[data-clicking="true"] .walkthrough-cursor-pulse {
          animation: walkthrough-click 280ms ease-out both;
        }
        @keyframes walkthrough-click {
          45% { opacity: .7; }
          to { opacity: 0; transform: scale(1.35); }
        }
        @media (prefers-reduced-motion: reduce) {
          .walkthrough-cursor { display: none; }
        }
      `}</style>

      <button
        aria-label="Dismiss guided walkthrough"
        className="fixed inset-0 z-[50] cursor-default bg-[#fbfaf7]/[0.08]"
        onClick={closeWalkthrough}
        tabIndex={-1}
        type="button"
      />

      <div
        className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[100] flex w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2 items-center justify-between gap-3 rounded-full border border-[#8c5746]/20 bg-[#fbfaf7]/95 py-1.5 pl-3.5 pr-1.5 text-[#25231f] shadow-[0_9px_30px_rgba(37,35,31,0.15)] backdrop-blur-xl"
        data-phase={walkthrough.phase}
        data-walkthrough="guided"
      >
        <p
          className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.13em] text-[#6f4436] sm:text-[11px]"
          role="status"
        >
          <span className="mr-2 text-[#8c5746]">Guided walkthrough</span>
          <span className="text-[#777169]">{phaseLabel(walkthrough.phase)}</span>
        </p>
        <button
          className="shrink-0 rounded-full border border-[#25231f]/10 bg-white/75 px-3 py-1.5 text-[10px] font-semibold text-[#5f5a53] transition hover:border-[#8c5746]/35 hover:text-[#25231f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746]"
          onClick={closeWalkthrough}
          ref={skipRef}
          type="button"
        >
          Exit
        </button>
      </div>

      {cursor ? <DemoCursor position={cursor} /> : null}

      {walkthrough.phase === "progress" ? (
        <GenerationOverlay
          generation={generation}
          onDismiss={closeWalkthrough}
          onRetry={() => undefined}
        />
      ) : null}

      {walkthrough.phase === "film" ? (
        <FilmLightbox
          collection={walkthrough.collection}
          film={{
            filmId: `showcase-${walkthrough.collection.id}`,
            photoIds: walkthrough.collection.photos.map((photo) => photo.id),
            url: walkthrough.collection.showcaseFilm,
          }}
          mode="showcase"
          onClose={closeWalkthrough}
        />
      ) : null}
    </>
  );
}
