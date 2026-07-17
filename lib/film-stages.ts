export const FILM_PROGRESS_STAGES = [
  {
    id: "preparing",
    label: "Preparing your photos",
    minDurationMs: 2_000,
    maxDurationMs: 4_000,
  },
  {
    id: "generating",
    label: "Creating the film",
    minDurationMs: 16_000,
    maxDurationMs: 32_000,
  },
  {
    id: "finalizing",
    label: "Finishing the film",
    minDurationMs: 2_000,
    maxDurationMs: 4_000,
  },
] as const;

export const TWO_CHUNK_FILM_PROGRESS_STAGES = [
  {
    id: "preparing",
    label: "Preparing your photos",
    minDurationMs: 2_000,
    maxDurationMs: 4_000,
  },
  {
    id: "generating-part-one",
    label: "Creating shot one of two",
    minDurationMs: 18_000,
    maxDurationMs: 36_000,
  },
  {
    id: "generating-part-two",
    label: "Creating shot two of two",
    minDurationMs: 18_000,
    maxDurationMs: 36_000,
  },
  {
    id: "finalizing",
    label: "Stitching the film",
    minDurationMs: 2_000,
    maxDurationMs: 4_000,
  },
] as const;

export type FilmProgressStage =
  | (typeof FILM_PROGRESS_STAGES)[number]
  | (typeof TWO_CHUNK_FILM_PROGRESS_STAGES)[number];
export type FilmProgressStageId = FilmProgressStage["id"];

export interface SimulatedFilmStage {
  id: FilmProgressStageId;
  durationMs: number;
}

type Sleep = (durationMs: number) => Promise<void>;

function randomDuration(
  minimum: number,
  maximum: number,
  random: () => number,
): number {
  const sample = Math.max(0, Math.min(0.999_999_999, random()));
  return minimum + Math.floor(sample * (maximum - minimum + 1));
}

/**
 * Runs the same 20–40 second stage envelope that the progress UI can import.
 */
export async function simulateFilmProgress(
  random: () => number = Math.random,
  sleep: Sleep = (durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs)),
): Promise<readonly SimulatedFilmStage[]> {
  const completedStages: SimulatedFilmStage[] = [];

  for (const stage of FILM_PROGRESS_STAGES) {
    const durationMs = randomDuration(
      stage.minDurationMs,
      stage.maxDurationMs,
      random,
    );
    await sleep(durationMs);
    completedStages.push({ id: stage.id, durationMs });
  }

  return completedStages;
}

/** Two mock generations followed by the same assembly phase as the real path. */
export async function simulateTwoChunkFilmProgress(
  random: () => number = Math.random,
  sleep: Sleep = (durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs)),
): Promise<readonly SimulatedFilmStage[]> {
  const completedStages: SimulatedFilmStage[] = [];

  for (const stage of TWO_CHUNK_FILM_PROGRESS_STAGES) {
    const durationMs = randomDuration(
      stage.minDurationMs,
      stage.maxDurationMs,
      random,
    );
    await sleep(durationMs);
    completedStages.push({ id: stage.id, durationMs });
  }

  return completedStages;
}
