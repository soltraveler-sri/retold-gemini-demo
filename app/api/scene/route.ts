import { loadCollections } from "../../../lib/collections";
import {
  checkSceneGenerationCapacity,
  createSceneCollection,
  isRealSceneEnabled,
  MAX_SCENE_REQUEST_BYTES,
  parseSceneRequestBody,
  SceneError,
  sceneCapReachedError,
} from "../../../lib/scene";
import {
  generateSceneImages,
  SceneImageError,
} from "../../../lib/scene-image";
import { storeSceneImages } from "../../../lib/scene-storage";

export const runtime = "nodejs";
export const maxDuration = 300;

const REFUSAL_MESSAGE =
  "Gemini couldn’t make that scene safely. Try describing an everyday place, mood, or event without names or likenesses.";

function responseHeaders(setCookies: readonly string[]): Headers {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return headers;
}

function errorResponse(
  error: SceneError,
  setCookies: readonly string[] = [],
): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status, headers: responseHeaders(setCookies) },
  );
}

async function readRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new SceneError(
      "invalid-input",
      400,
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SCENE_REQUEST_BYTES
  ) {
    throw new SceneError("invalid-input", 400, "Request body is too large.");
  }

  const text = await request.text();
  if (text.length === 0 || Buffer.byteLength(text) > MAX_SCENE_REQUEST_BYTES) {
    throw new SceneError(
      "invalid-input",
      400,
      "Request body is empty or too large.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SceneError(
      "invalid-input",
      400,
      "Request body must be valid JSON.",
    );
  }
}

function mockError(request: Request): SceneError | null {
  if (isRealSceneEnabled()) return null;
  switch (new URL(request.url).searchParams.get("mockError")) {
    case "refusal":
      return new SceneError("refused", 422, REFUSAL_MESSAGE);
    case "failed":
      return new SceneError(
        "upstream-model-error",
        502,
        "Gemini couldn’t create that camera roll. Nothing was charged — please try again.",
      );
    case "capacity":
      return sceneCapReachedError(
        "Today’s live scene limit has been reached. The ready-made moments are still available.",
      );
    default:
      return null;
  }
}

function sceneFailure(error: unknown): SceneError {
  if (error instanceof SceneImageError && error.code === "refused") {
    return new SceneError("refused", 422, REFUSAL_MESSAGE);
  }
  return new SceneError(
    "upstream-model-error",
    502,
    "Gemini couldn’t create that camera roll. Nothing was charged — please try again.",
  );
}

function logSceneFailure(error: unknown): void {
  const key = process.env.GEMINI_API_KEY;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const redact = (value: string): string => {
    let output = value;
    if (key) output = output.split(key).join("[REDACTED]");
    if (token) output = output.split(token).join("[REDACTED]");
    return output;
  };
  const detail = error instanceof Error
    ? {
        name: error.name,
        code: error instanceof SceneImageError ? error.code : undefined,
        message: redact(error.message),
        cause: error.cause ? redact(String(error.cause)) : undefined,
      }
    : { name: "NonError", message: redact(String(error)) };
  console.error("[scene] Generation failed:", JSON.stringify(detail));
}

function cannedSceneSources(): readonly string[] {
  const collection = loadCollections()[0];
  if (!collection || collection.photos.length !== 6) {
    throw new Error("The mock scene collection requires six seeded photos.");
  }
  return collection.photos.map((photo) => photo.src);
}

export async function POST(request: Request): Promise<Response> {
  let setCookies: readonly string[] = [];
  try {
    const { prompt } = parseSceneRequestBody(await readRequestBody(request));
    const forcedError = mockError(request);
    if (forcedError) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      throw forcedError;
    }

    if (isRealSceneEnabled() && !process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
      throw new SceneError(
        "upstream-model-error",
        503,
        "Live scene generation is temporarily unavailable. The ready-made moments are still available.",
      );
    }

    const capacity = await checkSceneGenerationCapacity(request);
    setCookies = capacity.setCookies;
    if (!capacity.allowed) throw sceneCapReachedError(capacity.message);

    let sources: readonly string[];
    if (isRealSceneEnabled()) {
      try {
        sources = await storeSceneImages(await generateSceneImages(prompt));
      } catch (error) {
        logSceneFailure(error);
        throw sceneFailure(error);
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 900));
      sources = cannedSceneSources();
    }

    const collection = createSceneCollection({ prompt, sources });
    return Response.json(
      { collection },
      { status: 201, headers: responseHeaders(setCookies) },
    );
  } catch (error) {
    return errorResponse(
      error instanceof SceneError ? error : sceneFailure(error),
      setCookies,
    );
  }
}
