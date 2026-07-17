import { FilmError } from "../../../../lib/film";
import { findStoredFilm, isFilmId } from "../../../../lib/film-storage";

export const runtime = "nodejs";

interface FilmRouteContext {
  params: Promise<{ id: string }>;
}

function errorResponse(error: FilmError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

export async function GET(
  request: Request,
  context: FilmRouteContext,
): Promise<Response> {
  const { id } = await context.params;
  if (!isFilmId(id)) {
    return errorResponse(
      new FilmError("invalid-input", 400, "Film id is invalid."),
    );
  }

  try {
    const film = await findStoredFilm(id);
    if (!film) {
      return errorResponse(
        new FilmError("invalid-input", 404, "Film was not found."),
      );
    }

    return Response.json({
      filmId: film.filmId,
      url: new URL(film.url, request.url).toString(),
      status: film.status,
    });
  } catch {
    return errorResponse(
      new FilmError(
        "upstream-model-error",
        502,
        "Film status is temporarily unavailable. Please try again.",
      ),
    );
  }
}
