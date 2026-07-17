# Gemini Omni smoke findings

Issue #1. Validates the two genuine unknowns from architecture §3.4 before any UI is built:
does person generation work on the AI-Studio key path, and does identity survive across a
generated clip.

**Date:** 2026-07-17 · **Model:** `gemini-omni-flash-preview` · **SDK:** `@google/genai` 2.12.0
**Real runs used:** 2 of the 5 permitted · **Real spend:** $2.00 video + ~$0.30 fixture images

| Run | Prompt mode | Interaction ID | Latency | Output | Cost |
|---|---|---|---|---|---|
| 1 | `baseline` | `v1_ChdHLVZaYXR2VEc4dlhfdU1QeTZ6aXVBNBIXRy1WWmF0dlRHOHZYX3VNUHk2eml1QTQ` | 42.4s | 1280x720, 10.01s, 2.33 MiB | $1.00 |
| 2 | `montage` | `v1_ChdoLVZaYW9PRkotLVpfdU1QNWNpUHVBSRIXaC1WWmFvT0ZKLS1aX3VNUDVjaVB1QUk` | 50.5s | 1280x720, 10.01s, 2.26 MiB | $1.00 |

Fixtures: two synthetic adults at a garden birthday party, generated with `gemini-3.1-flash-image`
(`scripts/make-fixtures.ts`). The second fixture was chained off the first via
`previous_interaction_id`, which held identity between the two stills convincingly.

## Person generation success (Y/N)

**Yes.** People generate on the open AI-Studio key path with a billing-enabled key. No policy
refusal, no allowlist gate, no degraded output on either run. This was the primary risk to the
whole project and it is retired.

Both runs used adults only, synthetic and non-identifiable. The docs' stated restrictions
(minors in EEA/UK/CH, recognizable real people) were never approached and are not triggered by
v0.1's design.

## Subjective face fidelity and identity across cuts

**Strong — the make-or-break question passes.**

Both people remain unmistakably the same across all sampled frames: the woman's curly dark hair,
face, and mustard patterned dress; the man's auburn hair, beard, and navy linen shirt. No face
drift, no identity merge, no substitution, no duplication. Frames were sampled at 0/3/6/9s
(baseline) and at the three prompted beats (montage) and inspected by eye.

Two findings that matter more than the pass itself:

1. **Omni does chronological multi-shot progression unprompted.** The `baseline` run asked only
   for *minimal, restrained motion* — no montage, no cuts. It nonetheless cut from the first
   reference (arrival, afternoon light) to the second (sunset, cake, glasses), progressing
   chronologically through both references on its own. The model's native multi-shot behaviour
   that architecture §3.1 depends on is real and is the default, not something that must be
   coaxed.

2. **Identity survives an explicit cut, not just elapsed time.** The `montage` run followed its
   timed beat structure — `[0-3s]` establishing, `[3-7s]` closer candid, `[7-10s]` closing on
   the later moment — and identity held across every cut. This is the specific failure mode the
   README calls the hard product problem, and it did not appear.

**Caveat, honestly stated:** n=2, one collection theme, one pair of synthetic faces that the
image model produced (and so are plausibly "easy" for the same model family to re-render).
Real-world faces, larger selections, and 6-reference chunks are unvalidated. This is a GO to
build, not a claim that fidelity is solved.

## Latency per generation

42.4s and 50.5s wall-clock, `store: true`, synchronous unary (`background: false, stream: false`).

Comfortably inside Vercel's 300s function ceiling, so architecture §3.2's synchronous in-route
design holds and the `background: true` + polling fallback stays a fallback. The `GET /api/film/:id`
route split should still ship in #5 as planned — the margin is ~6x, but it is a preview model and
the two-chunk path in #10 doubles the wall-clock.

Note this contradicts nothing, but does bound it: two samples is not a latency distribution.
Watch for spikes during #5 and #8.

## Actual observed cost

**$1.00 per 10.01s generation, exactly as modelled.** Billing matches the published rate of
$17.50/1M output tokens at 5,792 tokens per second of 720p video (= $0.10/sec). The architecture's
$0.80–2.00 per film estimate and the ~$25 v0.1 envelope are sound.

Fixture images cost ~$0.15 each at 1K on `gemini-3.1-flash-image` — negligible, and it makes
issue #3's seeded collections cheap.

## API surprises

- **`response_format.duration` is a string** (`"10s"`), not a number. Costs a round-trip to learn.
- **Two undocumented statuses.** The SDK's status union includes `incomplete` and `budget_exceeded`
  beyond the documented `completed`/`in_progress`/`requires_action`/`failed`/`cancelled`.
  `budget_exceeded` is directly relevant to #7's cost controls — it is a real upstream signal we
  should surface rather than swallow as a generic failure.
- **The model ID is not in the SDK's model literal union**, but the union admits `(string & {})`,
  so it type-checks. Expected for a preview model; worth re-checking on SDK upgrades.
- **`store: true` did not visibly cost latency.** The live docs suggest `store=false` is faster for
  synchronous generation; at 42–50s we cannot detect a penalty worth trading v0.2's conversational
  refinement for. Architecture §3.2's always-`store: true` decision stands, now on evidence.
- **Videos return by URI, not inline**, with `delivery: "uri"` — and the file needs polling to
  `ACTIVE` via `ai.files.get()` before download. `lib/omni.ts` handles this; #5 inherits it free.
- **`previous_interaction_id` chaining works well for images**, which is unplanned good news for
  #3 (recurring people across a seeded collection) and confirms the seam v0.2's §7.3 walks through.

## Verdict

**GO.**

Person generation works on the key path we designed for, identity holds across cuts, latency fits
the synchronous design, and cost matches the model the budget was built on. No fallback from the
ladder in §3.4 (prompt iteration → Veo 3.1 → non-Google models) is needed; the Google-model demo
that is strategically preferable for this project is also the one that works.

Proceed to #2. The 3 unused real runs from this issue's budget are returned to the envelope.
