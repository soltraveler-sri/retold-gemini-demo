"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import Image from "next/image";

import type { Collection, Photo } from "../types/library";

export const MAX_SELECTED_PHOTOS = 6;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

interface SelectionState {
  collectionId: string | null;
  photoIds: readonly string[];
}

interface DragState {
  pointerId: number;
  collectionId: string;
  photoIds: readonly string[];
  anchorIndex: number;
  currentIndex: number;
  baseIds: ReadonlySet<string>;
  mode: "select" | "deselect";
}

interface SelectionResult {
  ids: readonly string[];
  hitCap: boolean;
}

const EMPTY_SELECTION: SelectionState = {
  collectionId: null,
  photoIds: [],
};

function formatClusterDate(timestamp: string): string {
  const dateKey = timestamp.slice(0, 10);
  return dateFormatter.format(new Date(`${dateKey}T12:00:00Z`));
}

function RetoldMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 place-items-center rounded-[12px] bg-[#25231f] font-editorial text-[19px] italic text-white shadow-[0_5px_16px_rgba(37,35,31,0.12)]"
    >
      R
    </span>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path
        d="m4 8.2 2.45 2.45L12.25 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function SparkMark() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="M11.75 2.75c.58 4.26 2.9 6.62 7.2 7.25-4.3.63-6.62 2.99-7.2 7.25C11.17 13 8.84 10.63 4.55 10c4.29-.63 6.62-2.99 7.2-7.25Z"
        fill="currentColor"
      />
      <circle cx="18.7" cy="17.9" r="1.55" fill="currentColor" opacity=".72" />
      <path
        d="M4.2 14.8c.18 1.32.9 2.05 2.23 2.25-1.33.19-2.05.92-2.23 2.24-.18-1.32-.9-2.05-2.23-2.24 1.33-.2 2.05-.93 2.23-2.25Z"
        fill="currentColor"
        opacity=".58"
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <circle cx="5" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14.5" cy="5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14.5" cy="15" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="m6.8 9.05 5.85-3.08M6.8 10.95l5.85 3.08" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M4.5 6.25h11M8 3.75h4M6.25 6.25l.6 10h6.3l.6-10M8.5 9v4.5M11.5 9v4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45" />
    </svg>
  );
}

function rangeSelection(drag: DragState, currentIndex: number): SelectionResult {
  const nextIds = new Set(drag.baseIds);
  const step = currentIndex >= drag.anchorIndex ? 1 : -1;
  let hitCap = false;

  for (
    let index = drag.anchorIndex;
    index !== currentIndex + step;
    index += step
  ) {
    const photoId = drag.photoIds[index];
    if (!photoId) continue;

    if (drag.mode === "deselect") {
      nextIds.delete(photoId);
      continue;
    }

    if (nextIds.has(photoId)) continue;
    if (nextIds.size >= MAX_SELECTED_PHOTOS) {
      hitCap = true;
      continue;
    }
    nextIds.add(photoId);
  }

  return { ids: [...nextIds], hitCap };
}

function photoIndexAtPoint(
  x: number,
  y: number,
  collectionId: string,
): number | null {
  const directHit = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-photo-index][data-collection-id]");

  if (directHit?.dataset.collectionId === collectionId) {
    const directIndex = Number(directHit.dataset.photoIndex);
    return Number.isInteger(directIndex) ? directIndex : null;
  }

  let nearestIndex: number | null = null;
  let nearestDistance = 18 * 18;
  const tiles = document.querySelectorAll<HTMLElement>(
    "[data-photo-index][data-collection-id]",
  );

  for (const tile of tiles) {
    if (tile.dataset.collectionId !== collectionId) continue;
    const rect = tile.getBoundingClientRect();
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const distance = dx * dx + dy * dy;

    if (distance <= nearestDistance) {
      const index = Number(tile.dataset.photoIndex);
      if (Number.isInteger(index)) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
  }

  return nearestIndex;
}

function PhotoSurface({ photo, index }: { photo: Photo; index: number }) {
  if (photo.src) {
    return (
      <Image
        alt={photo.alt}
        className="object-cover"
        // Native image drag would hijack the pointer and break drag-select.
        draggable={false}
        fill
        sizes="(min-width: 1024px) 16vw, (min-width: 640px) 33vw, 50vw"
        src={photo.src}
      />
    );
  }

  return (
    <div
      aria-label={photo.alt}
      className="placeholder-tile absolute inset-0"
      data-tone={index % 5}
      role="img"
    >
      <span className="absolute inset-x-3 bottom-3 flex items-end justify-between text-[10px] font-medium tracking-[0.12em] text-[#3f3b35]/55">
        <span>PHOTO</span>
        <span>{String(index + 1).padStart(2, "0")}</span>
      </span>
    </div>
  );
}

interface PhotoTileProps {
  collectionId: string;
  index: number;
  isSelected: boolean;
  photo: Photo;
  onPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    collectionId: string,
    index: number,
  ) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyboardToggle: (collectionId: string, index: number) => void;
}

function PhotoTile({
  collectionId,
  index,
  isSelected,
  photo,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onKeyboardToggle,
}: PhotoTileProps) {
  return (
    <div
      className="photo-tile relative aspect-[4/5] min-w-0 overflow-hidden rounded-[14px]"
      data-collection-id={collectionId}
      data-photo-index={index}
      data-selected={isSelected}
    >
      <PhotoSurface index={index} photo={photo} />
      <div aria-hidden="true" className="photo-selection-wash" />
      <button
        aria-describedby="selection-help"
        aria-label={`${isSelected ? "Deselect" : "Select"} ${photo.alt}`}
        aria-pressed={isSelected}
        className="photo-check-target"
        onClick={(event) => {
          if (event.detail === 0) onKeyboardToggle(collectionId, index);
        }}
        onLostPointerCapture={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerDown={(event) =>
          onPointerDown(event, collectionId, index)
        }
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        type="button"
      >
        <span className="photo-check">
          <CheckIcon />
        </span>
      </button>
    </div>
  );
}

export function LibraryView({
  collections,
}: {
  collections: readonly Collection[];
}) {
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [capWasHit, setCapWasHit] = useState(false);
  const selectionRef = useRef<SelectionState>(EMPTY_SELECTION);
  const dragRef = useRef<DragState | null>(null);
  const lastAnchorRef = useRef<{ collectionId: string; index: number } | null>(
    null,
  );

  const photoCount = useMemo(
    () =>
      collections.reduce(
        (total, collection) => total + collection.photos.length,
        0,
      ),
    [collections],
  );
  const selectedIds = useMemo(
    () => new Set(selection.photoIds),
    [selection.photoIds],
  );
  const activeCollection = collections.find(
    (collection) => collection.id === selection.collectionId,
  );
  const selectedCount = selection.photoIds.length;
  const showCapHint = selectedCount >= MAX_SELECTED_PHOTOS || capWasHit;

  const commitSelection = useCallback(
    (collectionId: string, ids: readonly string[], hitCap = false) => {
      const nextSelection: SelectionState = ids.length
        ? { collectionId, photoIds: ids }
        : EMPTY_SELECTION;
      selectionRef.current = nextSelection;
      setSelection(nextSelection);
      setCapWasHit(hitCap && ids.length >= MAX_SELECTED_PHOTOS);
    },
    [],
  );

  const clearSelection = useCallback(() => {
    selectionRef.current = EMPTY_SELECTION;
    dragRef.current = null;
    setSelection(EMPTY_SELECTION);
    setCapWasHit(false);
  }, []);

  const applyDrag = useCallback(
    (drag: DragState, currentIndex: number) => {
      const result = rangeSelection(drag, currentIndex);
      drag.currentIndex = currentIndex;
      commitSelection(drag.collectionId, result.ids, result.hitCap);
    },
    [commitSelection],
  );

  const handlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLButtonElement>,
      collectionId: string,
      index: number,
    ) => {
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const collection = collections.find((item) => item.id === collectionId);
      if (!collection) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const currentSelection = selectionRef.current;
      const baseIds = new Set(
        currentSelection.collectionId === collectionId
          ? currentSelection.photoIds
          : [],
      );
      const photoIds = collection.photos.map((photo) => photo.id);
      const shiftAnchor =
        event.pointerType === "mouse" &&
        event.shiftKey &&
        lastAnchorRef.current?.collectionId === collectionId
          ? lastAnchorRef.current.index
          : null;
      const anchorIndex = shiftAnchor ?? index;
      const anchorId = photoIds[index];

      const drag: DragState = {
        pointerId: event.pointerId,
        collectionId,
        photoIds,
        anchorIndex,
        currentIndex: index,
        baseIds,
        mode:
          shiftAnchor !== null || !anchorId || !baseIds.has(anchorId)
            ? "select"
            : "deselect",
      };

      dragRef.current = drag;
      applyDrag(drag, index);
    },
    [applyDrag, collections],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      event.preventDefault();
      const index = photoIndexAtPoint(
        event.clientX,
        event.clientY,
        drag.collectionId,
      );
      if (index === null || index === drag.currentIndex) return;
      applyDrag(drag, index);
    },
    [applyDrag],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      lastAnchorRef.current = {
        collectionId: drag.collectionId,
        index: drag.currentIndex,
      };
      dragRef.current = null;

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const handleKeyboardToggle = useCallback(
    (collectionId: string, index: number) => {
      const collection = collections.find((item) => item.id === collectionId);
      const photo = collection?.photos[index];
      if (!collection || !photo) return;

      const currentSelection = selectionRef.current;
      const nextIds = new Set(
        currentSelection.collectionId === collectionId
          ? currentSelection.photoIds
          : [],
      );

      if (nextIds.has(photo.id)) {
        nextIds.delete(photo.id);
        commitSelection(collectionId, [...nextIds]);
      } else if (nextIds.size < MAX_SELECTED_PHOTOS) {
        nextIds.add(photo.id);
        commitSelection(collectionId, [...nextIds]);
      } else {
        setCapWasHit(true);
      }

      lastAnchorRef.current = { collectionId, index };
    },
    [collections, commitSelection],
  );

  const handleCreate = useCallback(() => {
    // Intentionally reserved for issue #6.
  }, []);

  return (
    <main className="min-h-screen bg-[#fbfaf7] text-[#25231f]">
      <p className="sr-only" id="selection-help">
        Press Enter or Space to toggle this photo. Drag from its selection
        circle to select a range within this moment.
      </p>

      <header className="sticky top-0 z-30 border-b border-[#25231f]/[0.08] bg-[#fbfaf7]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <RetoldMark />
            <div className="flex items-baseline gap-2.5">
              <span className="font-editorial text-[26px] leading-none tracking-[-0.03em]">
                Retold
              </span>
              <span className="hidden text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6e6961] sm:inline">
                Gemini demo
              </span>
            </div>
          </div>

          {selectedCount ? (
            <div className="flex min-w-0 items-center gap-2.5" aria-live="polite">
              <div className="min-w-0 text-right">
                <p className="text-sm font-semibold text-[#3f3b35]">
                  {selectedCount} {selectedCount === 1 ? "photo" : "photos"} selected
                </p>
                <p className="hidden truncate text-[10px] font-medium text-[#8a857d] sm:block">
                  {activeCollection?.title}
                </p>
              </div>
              <button
                className="rounded-full border border-[#25231f]/10 bg-white/70 px-3 py-1.5 text-[11px] font-semibold text-[#6e6961] transition hover:border-[#25231f]/20 hover:text-[#25231f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746]"
                onClick={clearSelection}
                type="button"
              >
                Clear
              </button>
            </div>
          ) : (
            <div className="hidden shrink-0 rounded-full border border-[#25231f]/10 bg-white/70 px-4 py-1.5 text-[11px] font-medium tracking-[0.01em] text-[#6e6961] shadow-[0_1px_2px_rgba(37,35,31,0.03)] sm:block">
              Concept demo — not affiliated with Google
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 pb-28 pt-12 sm:px-7 sm:pb-32 sm:pt-16">
        <section className="mb-14 flex flex-col justify-between gap-7 border-b border-[#25231f]/10 pb-9 sm:flex-row sm:items-end">
          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.19em] text-[#8c5746]">
              Your library
            </p>
            <h1 className="max-w-3xl font-editorial text-[clamp(2.75rem,6vw,5.4rem)] font-normal leading-[0.94] tracking-[-0.055em]">
              Moments, waiting
              <br />
              to move again.
            </h1>
          </div>
          <div className="max-w-xs sm:pb-1 sm:text-right">
            <p className="text-sm leading-6 text-[#6e6961]">
              Choose a few frames from one moment, then let Gemini carry the
              memory between them.
            </p>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#3f3b35]">
              {collections.length} moments · {photoCount} photos
            </p>
          </div>
        </section>

        <div className="space-y-16 sm:space-y-20">
          {collections.map((collection) => (
            <section
              aria-labelledby={`${collection.id}-date`}
              key={collection.id}
            >
              <div className="mb-4 flex items-end justify-between gap-5 sm:mb-5">
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8c5746]">
                    {collection.title}
                  </p>
                  <h2
                    className="font-editorial text-[clamp(1.6rem,3vw,2.25rem)] tracking-[-0.025em]"
                    id={`${collection.id}-date`}
                  >
                    {formatClusterDate(collection.photos[0]!.timestamp)}
                  </h2>
                </div>
                <span className="pb-1 text-[11px] font-medium text-[#8a857d]">
                  {collection.photos.length} photos
                </span>
              </div>

              <div className="photo-grid grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6 lg:gap-2">
                {collection.photos.map((photo, index) => (
                  <PhotoTile
                    collectionId={collection.id}
                    index={index}
                    isSelected={
                      selection.collectionId === collection.id &&
                      selectedIds.has(photo.id)
                    }
                    key={photo.id}
                    onKeyboardToggle={handleKeyboardToggle}
                    onPointerDown={handlePointerDown}
                    onPointerEnd={handlePointerEnd}
                    onPointerMove={handlePointerMove}
                    photo={photo}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="mt-20 border-t border-[#25231f]/10 pt-10 sm:mt-28 sm:flex sm:items-start sm:justify-between">
          <p className="font-editorial text-2xl tracking-[-0.02em]">
            Start with a frame. Leave with a film.
          </p>
          <p className="mt-3 max-w-sm text-sm leading-6 text-[#777169] sm:mt-0 sm:text-right">
            Select from one moment at a time. The familiar gesture is all the
            setup the story needs.
          </p>
        </section>
      </div>

      {selectedCount ? (
        <div
          aria-label="Photo actions"
          className="selection-action-bar fixed left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-[22px] border border-[#25231f]/10 bg-[#fbfaf7]/95 p-1.5 shadow-[0_12px_42px_rgba(37,35,31,0.18)] backdrop-blur-xl sm:gap-2 sm:p-2"
          role="toolbar"
        >
          <button
            className="gemini-action flex h-12 items-center gap-2.5 whitespace-nowrap rounded-[16px] bg-[#25231f] px-4 text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(37,35,31,0.18)] transition hover:-translate-y-px hover:bg-[#34312c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746] active:translate-y-0 sm:px-5"
            onClick={handleCreate}
            type="button"
          >
            <span className="size-5 text-[#ddb09b]">
              <SparkMark />
            </span>
            Create with Gemini
          </button>
          <button
            aria-label="Share — coming soon"
            className="placeholder-action"
            disabled
            type="button"
          >
            <ShareIcon />
            <span>Share</span>
          </button>
          <button
            aria-label="Delete — coming soon"
            className="placeholder-action"
            disabled
            type="button"
          >
            <DeleteIcon />
            <span>Delete</span>
          </button>
          {showCapHint ? (
            <p
              className="cap-hint absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[#8c5746]/15 bg-[#f5eee9] px-3 py-1 text-[10px] font-semibold text-[#8c5746] shadow-[0_3px_12px_rgba(87,62,52,0.08)]"
              role="status"
            >
              Up to {MAX_SELECTED_PHOTOS} photos for now
            </p>
          ) : null}
        </div>
      ) : (
        <div className="fixed bottom-3 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-[#25231f]/10 bg-[#fbfaf7]/95 px-3.5 py-2 text-[10px] font-medium text-[#6e6961] shadow-[0_4px_18px_rgba(37,35,31,0.10)] backdrop-blur sm:hidden">
          Concept demo — not affiliated with Google
        </div>
      )}
    </main>
  );
}
