# Prototype Architecture — Retold, a Gemini demo

High-level design for the v0.1 prototype, plus the v0.2 feature set (designed here, deliberately not shipped in the 0→1 sprint). Companion to the [README](README.md), which carries the product thesis; this doc carries the system.

---

## 1. Scope

**v0.1 ships exactly one surface:** a Google Photos-style library mockup, live on Vercel, where a visitor can:

1. Browse three seeded photo collections (5–8 photos each, distinct events/themes, clustered chronologically like a real camera roll).
2. Multi-select photos within a collection (tap + drag-select, mirroring the Photos gesture).
3. Tap the **Gemini button** → receive a single coherent generative film composed from the selected photos.
4. (Secondary flourish) Type a scene prompt (e.g. *"a wedding on Catalina Island"*) → a Gemini image model generates a small, sequentially coherent photo cluster into the library → same select-and-generate flow applies to it.

**Explicit non-goals for v0.1:** photo uploads, user accounts, library management, an LLM organizing/curating photos, the storyboard checkpoint, the authenticity dial, conversational editing, mobile-native anything. The demo is one magic moment, end to end, on the real model.

---

## 2. System overview

```
┌─────────────────────────────  Vercel  ─────────────────────────────┐
│                                                                    │
│  Next.js (App Router)                                              │
│  ┌──────────────────────────┐        ┌──────────────────────────┐  │
│  │  UI: Photos-style        │        │  API routes (Node,       │  │
│  │  library mockup          │───────▶│  Fluid Compute)          │  │
│  │  · collection grid       │        │  · POST /api/film        │  │
│  │  · drag multi-select     │        │  · POST /api/scene       │  │
│  │  · Gemini action button  │        │  · GET  /api/film/:id    │  │
│  │  · generation progress   │        └───────────┬──────────────┘  │
│  │  · inline video player   │                    │                 │
│  │  · scene prompt box      │                    │                 │
│  └──────────────────────────┘                    │                 │
│                                                  │                 │
│  Static assets: seeded photo collections         │                 │
│  Vercel Blob: generated films + generated scenes │                 │
└──────────────────────────────────────────────────┼─────────────────┘
                                                   │
                                     Gemini API (/v1beta)
                                     · Interactions API →  gemini-omni-flash-preview   (video)
                                     · Image generation →  Gemini image model          (scene photos)
```

**Stack:** Next.js (App Router) on Vercel, TypeScript, official `@google/genai` SDK, Vercel Blob for generated media. No database in v0.1 — seeded collections are static assets with a JSON manifest; generated artifacts live in Blob with metadata in the object path/headers.

---

## 3. The video pipeline (`POST /api/film`)

Input: an ordered list of selected photo IDs (resolved server-side to image data — the client never supplies arbitrary image bytes in v0.1).

### 3.1 Shot planning (deterministic in v0.1)

No LLM planner in v0.1. Selected photos are kept in **chronological order** and chunked into shots by a simple rule:

- **≤ 6 photos selected** → one generation. All photos passed as tagged reference images; Omni Flash's native multi-shot behavior carries the montage structure within a single 8–10s clip.
- **7–8 photos selected** → two chunks (split at the largest timestamp gap, i.e. the natural scene boundary), two sequential generations, stitched.

Per-chunk prompts are assembled from a fixed, well-tuned prompt template per collection theme (each seeded collection ships with a hand-written cinematic prompt; generated scenes reuse the user's scene prompt). The template encodes the montage grammar: chronological progression, real photos as anchor moments, connective cinematic motion between them.

### 3.2 Generation (Gemini Interactions API)

- Model: `gemini-omni-flash-preview`, task `image_to_video` / `reference_to_video`, via `client.interactions.create(...)` on the `/v1beta/interactions` endpoint. **Not** `generate_content` — video does not flow through it.
- Reference images passed with the documented tagging grammar (`<FIRST_FRAME>@Image1`, `<IMAGE_REF_n>@ImageN`), up to 6 per generation.
- **`store: true`** on every generation. It costs nothing in v0.1 and keeps every generated clip conversationally editable via `previous_interaction_id` — the door v0.2's refinement feature walks through. (`store: false` would permanently orphan the clip from future edits.)
- Synchronous unary mode (`background: false, stream: false`) inside the API route. Vercel's 300s function timeout comfortably covers observed generation latency (tens of seconds per clip); if real-world latency proves spikier, the fallback is `background: true` + client polling on `GET /api/film/:id` — the route split exists from day one so this is a config change, not a refactor.
- Output constraints accepted as-is: 720p, 24fps, 3–10s per generation.

### 3.3 Assembly

- Single-chunk films: the clip is the film. Upload to Blob, return URL. This is the v0.1 golden path and ships first.
- Two-chunk films: server-side concatenation with a crossfade (`ffmpeg-static` binary + `xfade` in the Node function — well within Fluid Compute limits for two 10s 720p clips). Stitching is the *last* issue in the 0→1 epic, so the demo is fully functional before it lands; until then the UI simply caps selection at 6.

### 3.4 First build task: the person-generation smoke test

Before any UI exists, issue #1 is a script that sends two photos of people through the pipeline and inspects the result. Face/identity fidelity and person-generation policy on the AI-Studio key path are the two genuine unknowns; everything else in this document is confirmed against docs. If fidelity disappoints, the fallback ladder is: prompt-template iteration → Veo 3.1 (first/last-frame mode) for interpolation-style shots → non-Google models (Kling 3.0 / Seedance 2.0 via fal.ai) as a last resort, noting that a Google-model demo is strategically preferable for this project's purpose.

---

## 4. The scene generator (`POST /api/scene`)

The demo's secondary flourish: prompt → coherent photo cluster.

- **5–6 images as a single narratively sequential set** from a Gemini image model (Nano Banana family) — same event, same people, same light arc (e.g. ceremony → golden hour → first dance), composed so they read as one camera roll cluster. *Amended from "one request" after measurement:* sequential coherence comes from generating the set as **one chained interaction** (each image passing `previous_interaction_id`), which is what actually holds identity across a set. Independent generations do not.
- Results land in Blob and appear in the library UI as a new collection, visually identical to the seeded ones (timestamped, clustered). From there the film flow is exactly the same code path — the scene generator adds zero branches to the video pipeline.
- This feature is intentionally lower priority than the core flow: it ships after the select-and-generate loop is solid.

---

## 5. Cost and abuse controls (this is a paid-model public demo)

Every film costs real money (~$0.10/sec of output video ≈ **$0.80–$2.00 per film**; scene generation is comparatively negligible). Controls, all in v0.1:

1. **Showcase mode is the default.** Each seeded collection ships with a pre-generated film. Visitors watch those for free (served as static assets, zero API cost). Live generation is an explicit second step, not the landing experience.
2. **Generation is identity-bound.** Anonymous visitors get the entire demo — the library, the guided walkthrough, every showcase film — and can spend nothing. Live generation requires a signed-in identity from an env-var allowlist: *guest* (a one-time credit) or *admin* (a monthly budget). This supersedes the original "no accounts" position; see §7.6.
3. **Budgets are counted in dollars, not requests.** A film costs $1.00 and a scene ~$0.90 (measured, not estimated), so spend is reserved in cents against the identity's budget before the paid call, atomically with the global cap. Counting requests was always a proxy for the real constraint.
4. **Hard global spend cap.** A daily generation counter (Upstash Redis via Vercel Marketplace) with a hard ceiling, retained as a circuit breaker behind the per-identity budgets.
5. **Optional demo key.** An environment-flagged passphrase that grants an *admin-tier session* for portfolio presentations. It is metered like any other session — there is deliberately no unmetered path.
6. **Server-resolved inputs only.** The API accepts photo IDs, never raw images — no vector for using the demo as a free video-generation proxy. Generated scene photos are signed descriptors, and the reference-image fetch is pinned to the Blob host.
7. **Fails closed.** A missing signing secret, missing caps, or unreachable Redis refuses real generation. Mock, showcase, and the walkthrough are unaffected. A misconfigured demo must never mean unmetered spend.

Env: `GEMINI_API_KEY` (AI Studio key on a billing-enabled project), `BLOB_READ_WRITE_TOKEN`, `UPSTASH_REDIS_REST_URL` / `_TOKEN`, `AUTH_SECRET`, `ADMIN_EMAILS` / `GUEST_EMAILS`, `ADMIN_ACCESS_CODE` / `GUEST_ACCESS_CODE`, budget and cap vars. Development iterates against cached/mock responses by default; real generations are deliberate.

---

## 6. UX notes (v0.1)

- The library mockup should feel unmistakably Photos-like — date-clustered grid, rounded selection checkmarks, a bottom action bar that appears on selection — without cloning Google trade dress: this is a concept mockup, visibly labeled as such, not an imitation of the real app.
- The Gemini action uses the drag-select → action-bar pattern so the demo's thesis ("the entry point is a gesture you already know") is embodied, not narrated.
- Generation wait (~1–2 min worst case) is fronted with honest progress theater: which photos are anchoring the film, shot-by-shot status. This is also the seam where v0.2's storyboard checkpoint slots in without redesign.
- The finished film plays inline where the photos were selected, with a replay + download affordance and a visible "generated with Gemini Omni (preview)" label.

---

## 7. v0.2 — designed now, deliberately not in the 0→1 sprint

These are part of the product design and are documented so the v0.1 architecture leaves their seams open. None are in the initial epic.

### 7.1 Storyboard checkpoint
After selection, an instant, near-zero-cost intermediate screen: the AI's read of the event as named scenes ("First dance · Golden hour · Send-off"), a style choice (Montage / Time-lapse / Story), and a Create button — plus a "Surprise me" one-tap bypass. Three jobs: turns generation latency into anticipation, gives the user an approval point before compute is spent (at scale: Google's quota/cost gate), and is where creative direction gets expressed. Architecturally: one cheap multimodal Gemini call producing a storyboard JSON that parameterizes the existing chunk-and-prompt step — the deterministic v0.1 planner is the degenerate case of this.

### 7.2 Authenticity dial (Faithful ↔ Cinematic)
A single slider governing how much invention the model is licensed to do — *Faithful* anchors tightly to source frames (subtle motion, real moments animated); *Cinematic* permits connective tissue and drama. Implementation is prompt-template modulation plus reference-image weighting per chunk. This is the design answer to the memory-hallucination trust problem and the feature's most defensible product idea; it stays v0.2 only because the MVP must prove the core magic first.

### 7.3 Conversational refinement
"Make the ending slower." One shot re-generated in place via `previous_interaction_id` — this is Omni Flash's flagship capability and no competitor's photo product has it. The v0.1 decision to always `store: true` exists precisely so every historical clip remains editable when this ships.

### 7.4 Beat-synced scoring
A music bed with cut points aligned to detected beats (librosa-class onset detection feeding the stitch step's timestamps). Cheap, disproportionate demo impact.

### 7.5 Android / in-Photos concept
A design exploration (not necessarily code): what shipping inside actual Google Photos entails — entry point in the real select action bar, generation quotas by AI subscription tier (free taste with caps, Photo to Video-style, vs. hard-gated, Video Remix-style), SynthID + visible watermarking, EEA person/minor policy constraints, and on-surface labeling. Deliverable is a short design doc + screens, extending this repo's thesis to the real surface.

### 7.6 Explicitly out of scope at every version of this prototype
Uploading personal photos (a real product's core path, but a demo liability: privacy, moderation, and cost surface), and any claim of production-readiness.

**Amended (July 2026): gated access is in v0.1.** This section previously ruled out accounts entirely. Making the repo public changed the calculus: anyone arriving from GitHub can spend the maintainer's money, and anonymous per-IP throttling caps the *rate* of that spend without ever capping *who*. What shipped is deliberately the smallest thing that answers "who is spending": an email allowlist in env vars plus a shared access code — no user database, no password, no email infrastructure, no profile, nothing stored about a person but a hashed address and a number of cents. It exists to bound cost, not to build an account system, and the demo stays entirely visible without it (§5.2).

---

## 8. Known constraints and risks (carried from primary-source research, July 2026)

| Constraint | Consequence for this design |
|---|---|
| Omni Flash: 3–10s per generation, 720p/24fps | Films are chunked shots, stitched; the montage grammar is designed around this, not despite it |
| ~6 reference images max per generation | Chunking rule in §3.1; selection UX caps accordingly |
| No free tier; ~$0.10/sec video output | §5 cost controls; showcase mode default |
| Vertex AI path is allowlist-gated | Demo uses the open AI Studio key path exclusively |
| Reference *videos* ≤3s accepted but not processed correctly (preview) | Not used anywhere in this design |
| `store: false` permanently disables later conversational edits | `store: true` always (§3.2) |
| EEA/UK/CH: no uploaded-video editing; minors-image restrictions | Not triggered by v0.1 (photo inputs, US-hosted demo); flagged for the v0.2 in-Photos concept |
| Person-generation fidelity is unvalidated | Issue #1 smoke test before any UI work (§3.4) |
| Model is in public preview | Model ID and API surface may shift; SDK pinned, integration isolated behind one module |
