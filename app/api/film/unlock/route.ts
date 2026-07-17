import { issueDemoUnlockCookie } from "../../../../lib/generation-capacity";

export const runtime = "nodejs";

function unlockResponse(cookie: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.set("Set-Cookie", cookie);
  return Response.json(
    { unlocked: true },
    { status: 200, headers },
  );
}

function invalidUnlockResponse(): Response {
  return Response.json(
    { error: { code: "invalid-unlock", message: "That demo key is invalid." } },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function internalRedirect(request: Request): string | null {
  const redirect = new URL(request.url).searchParams.get("redirect");
  if (!redirect || !redirect.startsWith("/") || redirect.startsWith("//")) {
    return null;
  }
  return new URL(redirect, request.url).toString();
}

export async function GET(request: Request): Promise<Response> {
  const passphrase = new URL(request.url).searchParams.get("key");
  if (passphrase === null) return invalidUnlockResponse();

  const cookie = issueDemoUnlockCookie(passphrase, request);
  if (!cookie) return invalidUnlockResponse();

  const redirect = internalRedirect(request);
  if (!redirect) return unlockResponse(cookie);
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: redirect,
      "Set-Cookie": cookie,
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return invalidUnlockResponse();
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).key !== "string"
  ) {
    return invalidUnlockResponse();
  }

  const cookie = issueDemoUnlockCookie(
    (value as Record<string, unknown>).key as string,
    request,
  );
  return cookie ? unlockResponse(cookie) : invalidUnlockResponse();
}
