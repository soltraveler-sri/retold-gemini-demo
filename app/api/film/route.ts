import {
  capReachedError,
  checkFilmGenerationCapacity,
  createFilm,
  FilmError,
  MAX_FILM_REQUEST_BYTES,
  parseFilmRequestBody,
  resolveFilmSelection,
} from "../../../lib/film";

export const runtime = "nodejs";
export const maxDuration = 300;

function responseHeaders(setCookies: readonly string[]): Headers {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return headers;
}

function errorResponse(
  error: FilmError,
  setCookies: readonly string[] = [],
): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers: responseHeaders(setCookies) },
  );
}

function unexpectedError(): FilmError {
  return new FilmError(
    "upstream-model-error",
    502,
    "The film service is temporarily unavailable. Please try again.",
  );
}

async function readRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new FilmError(
      "invalid-input",
      400,
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_FILM_REQUEST_BYTES
  ) {
    throw new FilmError("invalid-input", 400, "Request body is too large.");
  }

  const text = await request.text();
  if (text.length === 0 || Buffer.byteLength(text) > MAX_FILM_REQUEST_BYTES) {
    throw new FilmError(
      "invalid-input",
      400,
      "Request body is empty or too large.",
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FilmError(
      "invalid-input",
      400,
      "Request body must be valid JSON.",
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let setCookies: readonly string[] = [];
  try {
    const { photoIds } = parseFilmRequestBody(await readRequestBody(request));
    // Reject unknown or cross-collection ids before consuming paid capacity.
    resolveFilmSelection(photoIds);

    const capacity = await checkFilmGenerationCapacity(request);
    setCookies = capacity.setCookies;
    if (!capacity.allowed) throw capReachedError(capacity.message);

    const film = await createFilm(photoIds);
    const url = new URL(film.url, request.url).toString();
    return Response.json(
      { ...film, url },
      { status: 201, headers: responseHeaders(setCookies) },
    );
  } catch (error) {
    return errorResponse(
      error instanceof FilmError ? error : unexpectedError(),
      setCookies,
    );
  }
}
