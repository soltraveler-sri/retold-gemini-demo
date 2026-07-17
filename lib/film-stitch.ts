import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import ffmpegPath from "ffmpeg-static";

export const FILM_CROSSFADE_SECONDS = 0.5;
const CLIP_DURATION_SECONDS = 10;
const MAX_FFMPEG_ERROR_LENGTH = 8_000;

function runFfmpeg(arguments_: readonly string[]): Promise<void> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static does not support this runtime platform.");
  }
  // Turbopack rewrites the package's __dirname to a virtual /ROOT path. The
  // NFT trace still places the executable under the deployed project root, so
  // resolve the traced filename from the runtime cwd instead of spawning the
  // compile-time virtual path. FFMPEG_BIN remains an explicit operator escape.
  const configuredPath = process.env.FFMPEG_BIN?.trim();
  const executable =
    configuredPath ||
    resolve(
      process.cwd(),
      "node_modules",
      "ffmpeg-static",
      basename(ffmpegPath),
    );

  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ["ignore", "ignore", "pipe"] as const,
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_FFMPEG_ERROR_LENGTH);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `ffmpeg stitching failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

/** Crossfades two 10-second Omni clips into one browser-safe 720p MP4. */
export async function stitchFilmClips(
  firstClip: Uint8Array,
  secondClip: Uint8Array,
): Promise<Uint8Array> {
  const directory = await mkdtemp(resolve(tmpdir(), "retold-stitch-"));
  const firstPath = resolve(directory, "part-one.mp4");
  const secondPath = resolve(directory, "part-two.mp4");
  const outputPath = resolve(directory, "film.mp4");
  const startedAt = performance.now();

  try {
    await Promise.all([
      writeFile(firstPath, firstClip),
      writeFile(secondPath, secondClip),
    ]);

    const fadeOffset = CLIP_DURATION_SECONDS - FILM_CROSSFADE_SECONDS;
    const videoFilter = [
      "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,",
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,",
      "format=yuv420p,settb=AVTB[v0];",
      "[1:v]scale=1280:720:force_original_aspect_ratio=decrease,",
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,",
      "format=yuv420p,settb=AVTB[v1];",
      `[v0][v1]xfade=transition=fade:duration=${FILM_CROSSFADE_SECONDS}:offset=${fadeOffset},`,
      "format=yuv420p[v];",
      "[0:a]aresample=48000:first_pts=0[a0];",
      "[1:a]aresample=48000:first_pts=0[a1];",
      `[a0][a1]acrossfade=d=${FILM_CROSSFADE_SECONDS}:c1=tri:c2=tri[a]`,
    ].join("");

    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      firstPath,
      "-i",
      secondPath,
      "-filter_complex",
      videoFilter,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-shortest",
      outputPath,
    ]);

    const bytes = await readFile(outputPath);
    console.info(
      "[film] ffmpeg stitch completed:",
      JSON.stringify({
        wallClockMs: Math.round(performance.now() - startedAt),
        nodeRssBytes: process.memoryUsage().rss,
        inputBytes: firstClip.byteLength + secondClip.byteLength,
        outputBytes: bytes.byteLength,
      }),
    );
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
