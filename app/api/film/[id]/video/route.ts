import { FilmError } from "../../../../../lib/film";
import {
  isLocalFilmId,
  readLocalFilmVideo,
} from "../../../../../lib/film-storage";

export const runtime = "nodejs";

interface FilmVideoRouteContext {
  params: Promise<{ id: string }>;
}

function errorResponse(error: FilmError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export async function GET(
  request: Request,
  context: FilmVideoRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  if (!isLocalFilmId(id)) {
    return errorResponse(
      new FilmError("invalid-input", 404, "Film was not found."),
    );
  }

  try {
    const video = await readLocalFilmVideo(id);
    if (!video) {
      return errorResponse(
        new FilmError("invalid-input", 404, "Film was not found."),
      );
    }

    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "video/mp4",
    });
    const range = request.headers.get("range");
    if (!range) {
      headers.set("Content-Length", String(video.byteLength));
      return new Response(responseBody(video), { headers });
    }

    const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
    const start = match?.[1] ? Number(match[1]) : Number.NaN;
    const requestedEnd = match?.[2] ? Number(match[2]) : video.byteLength - 1;
    const end = Math.min(requestedEnd, video.byteLength - 1);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start > end
    ) {
      headers.set("Content-Range", `bytes */${video.byteLength}`);
      return new Response(null, { status: 416, headers });
    }

    const chunk = video.subarray(start, end + 1);
    headers.set("Content-Length", String(chunk.byteLength));
    headers.set("Content-Range", `bytes ${start}-${end}/${video.byteLength}`);
    return new Response(responseBody(chunk), { status: 206, headers });
  } catch {
    return errorResponse(
      new FilmError(
        "upstream-model-error",
        502,
        "Film playback is temporarily unavailable. Please try again.",
      ),
    );
  }
}
