"use client";

import { useCallback, useEffect, useState } from "react";

export interface AccessState {
  signedIn: boolean;
  email: string | null;
  tier: "admin" | "guest" | null;
  contactEmail: string;
}

const INITIAL: AccessState = {
  signedIn: false,
  email: null,
  tier: null,
  contactEmail: "hvmerk.work@gmail.com",
};

export function useAccess(): {
  access: AccessState;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
} {
  const [access, setAccess] = useState<AccessState>(INITIAL);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/access", { cache: "no-store" });
      if (response.ok) setAccess((await response.json()) as AccessState);
    } catch {
      // Access state is advisory in the UI; the server is always the authority.
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sign-out" }),
    });
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { access, refresh, signOut };
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <rect x="5.5" y="5.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3.5A2 2 0 0 0 8.5 2H4.5a2 2 0 0 0-2 2v4a2 2 0 0 0 1.5 1.94" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The whole button is the copy affordance, not just the icon — the request was
 * that clicking either one copies the address.
 */
function EmailDirectly({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Clipboard can be blocked (insecure context, permissions). Fall back to
      // a selection-based copy so the affordance still works.
      const field = document.createElement("textarea");
      field.value = address;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing more we can do; the address is still shown below */
      }
      document.body.removeChild(field);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  }, [address]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className="inline-flex h-11 items-center gap-2 rounded-[14px] bg-[#25231f] px-4 text-[13px] font-semibold text-white transition hover:-translate-y-px hover:bg-[#34312c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746]"
    >
      {copied ? "Email copied" : "Email directly"}
      {copied ? (
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
          <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <CopyIcon />
      )}
    </button>
  );
}

export interface AccessNudgeProps {
  access: AccessState;
  /** Set when the visitor is signed in but has spent their credit. */
  creditExhaustedMessage?: string | undefined;
  onClose: () => void;
  onSignedIn: () => void;
  onWatchWalkthrough?: (() => void) | undefined;
}

/**
 * Shown when someone reaches for a paid feature without access. It is a nudge,
 * never a wall: the demo itself stays fully visible behind it, and the two
 * things a visitor can actually do — watch the walkthrough, or ask for access —
 * are the two things offered.
 */
export function AccessNudge({
  access,
  creditExhaustedMessage,
  onClose,
  onSignedIn,
  onWatchWalkthrough,
}: AccessNudgeProps) {
  const [showSignIn, setShowSignIn] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/access", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        if (response.ok) {
          onSignedIn();
          onClose();
          return;
        }
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? "That didn't work. Try again.");
      } catch {
        setError("Couldn't reach the server. Check your connection.");
      } finally {
        setBusy(false);
      }
    },
    [code, email, onClose, onSignedIn],
  );

  const exhausted = Boolean(creditExhaustedMessage);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[#25231f]/45 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={exhausted ? "Demo credit used" : "Access required"}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[520px] rounded-[22px] border border-[#25231f]/10 bg-[#fbfaf7] p-7 shadow-[0_24px_70px_rgba(37,35,31,0.28)] sm:p-8">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8c5746]">
          {exhausted ? "Demo credit used" : "Generation is by invitation"}
        </p>
        <h2 className="font-editorial text-[clamp(1.6rem,3.6vw,2.1rem)] leading-[1.1] tracking-[-0.03em]">
          {exhausted ? "That's your credit spent." : "This part runs on a paid model."}
        </h2>
        <p className="mt-3.5 text-sm leading-6 text-[#6e6961]">
          {creditExhaustedMessage ??
            "Every film costs real compute, so live generation is opened up per person. Everything else — the library, the walkthrough, and the example films — is free and unrestricted."}
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          {onWatchWalkthrough ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                onWatchWalkthrough();
              }}
              className="inline-flex h-11 items-center gap-2 rounded-[14px] border border-[#25231f]/12 bg-white/70 px-4 text-[13px] font-semibold text-[#3f3b35] transition hover:-translate-y-px hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8c5746]"
            >
              <span aria-hidden="true">▶</span> Watch walkthrough
            </button>
          ) : null}
          <EmailDirectly address={access.contactEmail} />
        </div>
        <p className="mt-3 text-[12px] text-[#8a857d]">
          {access.contactEmail}
        </p>

        {!access.signedIn && (
          <div className="mt-6 border-t border-[#25231f]/10 pt-5">
            {showSignIn ? (
              <form onSubmit={submit} className="space-y-3">
                <label className="block text-[12px] font-medium text-[#6e6961]">
                  Email
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="mt-1 h-11 w-full rounded-[12px] border border-[#25231f]/12 bg-white px-3 text-[14px] text-[#25231f] outline-none focus:border-[#8c5746]"
                  />
                </label>
                <label className="block text-[12px] font-medium text-[#6e6961]">
                  Access code
                  <input
                    type="text"
                    required
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    className="mt-1 h-11 w-full rounded-[12px] border border-[#25231f]/12 bg-white px-3 text-[14px] text-[#25231f] outline-none focus:border-[#8c5746]"
                  />
                </label>
                {error ? (
                  <p role="alert" className="text-[12px] text-[#8c5746]">
                    {error}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={busy}
                  className="h-11 w-full rounded-[14px] bg-[#25231f] text-[13px] font-semibold text-white transition hover:bg-[#34312c] disabled:opacity-60"
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setShowSignIn(true)}
                className="text-[13px] font-semibold text-[#8c5746] underline underline-offset-4"
              >
                I already have access → Sign in
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-5 text-[12px] text-[#8a857d] underline underline-offset-4"
        >
          Keep looking around
        </button>
      </div>
    </div>
  );
}
