# Gemini Omni × Google Photos — turning selected photos into film

**A working prototype of a feature Google Photos doesn't have yet: select a handful of photos from your library — the way you already multi-select to delete or share — tap one Gemini button, and get back a single coherent, generative short film of that moment in your life.**

> **Live demo:** _(Vercel deployment link coming with v0.1)_
> **Status:** v0.1 in development · [architecture doc](prototype_architecture.md)

---

## The 15-second version

Google Photos can animate *one* photo into a 6-second clip (Photo to Video, Veo-powered). It can restyle *one* video (Video Remix, Gemini Omni-powered). It can stitch many photos into a *non-generative* slideshow with music (Highlight Videos). What it cannot do is the obvious next rung: take the 30 photos you shot across a wedding night and synthesize them into one continuous, cinematic film — the montage you'd see in a movie flashback, generated from your own real moments.

This repo is a live, working demo of that feature, built on `gemini-omni-flash-preview` — the same model family Google itself ships Video Remix on.

---

## Product thesis — why Google builds this

*This section is the reasoning that led to the prototype, written the way I'd write it for a product review: not "here's a cool AI feature," but why this specific feature, on this specific surface, is strategically overdetermined for Google.*

### Start from an uncomfortable question about Memories

The Memories feature is beloved, but interrogate it honestly: **what is the point — for the user, and for Google?** For the user, it's a pleasant resurfacing of old photos. For Google, it increases user-minutes inside an app that has almost **no natural value capture**. There are no ads in Photos. Core editing and organizing features can't be paywalled — the user expectation for a default photos app is that normal features are free, and violating that expectation would be brand-corrosive. Worse, minutes spent in Photos are minutes *not* spent on surfaces that do capture value.

So Memories, as it stands, is an **engagement layer driving toward a conversion layer** — and the conversion layer is the interesting design problem. Working forward from that:

1. **Photos' baseline features must stay free.** That's the contract with the user, and Google has honored it (Magic Eraser, Unblur, and Portrait Light all went free in 2024).
2. **Therefore the conversion layer must be a category users already expect and tolerate paying for.** You can't invent a new tolerance; you have to borrow an existing one.
3. **Generative AI is that category.** Users in 2026 already pay monthly for generative capability (ChatGPT, Gemini, Midjourney). Charging for *expensive, novel generation* doesn't break the "Photos is free" contract — it sits visibly on top of it, priced by compute, not by holding basic utility hostage.

The feature that fills this slot needs to satisfy two conditions simultaneously: **(A)** deliver value to the user genuinely beyond what they expect from a photos app by default, and **(B)** capture value for Google without violating the free-app contract.

### Google is already executing this exact logic — the ladder just has a missing rung

I arrived at this reasoning independently, and the market check confirmed it's precisely the strategy Google is now running:

- **Photo to Video** (July 2025 → Veo 3 by Sept 2025): free with daily caps, *higher caps for AI Pro/Ultra subscribers*. Single photo in, 6-second clip out.
- **Video Remix** (July 8, 2026): Gemini Omni-powered video restyling, and **the first Photos feature hard-gated to paid AI tiers** — not available on free at all. Compute-cost monetization, layered on top of the storage-tier base that already drives 150M+ Google One subscribers.
- The paywall line is being actively tuned in both directions (personalized image generation went *free* in June 2026, Video Remix went *paid-only* nine days later) — this is a company experimenting in production with exactly the free/paid boundary described above.

The ladder is visible: **one photo → one video** (shipped), **one video → restyled video** (shipped, paywalled), **many photos → one film** (missing). The missing rung is also the most emotionally valuable one, and the market is validating it in real time: Reelful (a16z Speedrun, launched July 15, 2026) charges $15–$100/month for a camera-roll-to-video app; a cluster of AI wedding-montage startups (Mootion, Frameo, Vidio) monetizes the single strongest use case. These startups are fighting for distribution and model access. **Google owns both** — the library where the photos already live, and the model (Gemini Omni) that generates the film.

To be clear about positioning: I don't assume Google hasn't thought of this — it's the natural next rung on a ladder they're clearly climbing, and it's likely somewhere in a queue. The point of this prototype isn't priority claim; it's to demonstrate, concretely, what the experience should feel like and where the hard product problems are.

### The feature, in one paragraph

Inside Google Photos, the user multi-selects photos exactly as they do today (long-press, drag across a range — zero new interaction to learn). A Gemini action appears alongside Share and Delete. One tap, and Gemini Omni composes those photos — in their real chronological order — into a single short generative film: the golden-hour portraits breathing into motion, a cut to the first dance, the send-off sparklers carrying the ending. Not a slideshow with crossfades. A film that treats your real photos as the anchor frames of a story.

### Primary user story: the wedding

> You went to your best friend's wedding and took 30 photos across the night — getting ready, the ceremony, golden hour, the first dance, the sparkler send-off. Today, those live in your library as a strip of 30 thumbnails you scroll past. You select them, tap **Create with Gemini**, and a minute later you're watching a 25-second film of that night: your actual photos, animated and woven together with the connective tissue of cinema — the montage a filmmaker would cut if they'd been standing next to you. You send it to the group chat. Three people ask how you made it.

Weddings are the archetype, not the boundary: birthdays, graduations, trips, a kid's first year — any life event that produces a burst of photos in sequence is raw material. The pattern this feature serves is *"many photos, rapid succession, one story."*

### Product principles

1. **Zero new interaction cost to start.** The entry point is the multi-select gesture users already know. The magic must begin one tap after a behavior they already have.
2. **Real photos are the anchors, generation is the connective tissue.** The film must be recognizably *their* night. This is a memory product before it is a creativity product.
3. **The constraint is the aesthetic.** Video models generate 3–10 second shots — so the output is a sequence of brief generative shots, stitched. That isn't a workaround; it's exactly the grammar of a montage. The technical ceiling and the creative form converge.
4. **Monetize the compute, never the baseline.** A taste of the feature can be free (as Photo to Video is, quota-capped); the full experience is a flagship reason to hold an AI Plus/Pro/Ultra subscription (as Video Remix already is). At ~$0.10/second of generated video, per-film compute cost (~$2–4) makes subscription gating an economic necessity, not just a strategy — which is precisely why this feature is a *conversion* layer and not another free engagement layer.

### The hard product problem, stated honestly

A generative model *inventing* moments is simultaneously the magic and the liability. Faces that drift, a kiss that didn't happen — for sacred material like a wedding, hallucination is a trust problem, not a quality problem. Face/identity fidelity across generated shots is the make-or-break axis, and the roadmap treats it as such: v0.2 introduces an explicit **authenticity dial** (*Faithful* ↔ *Cinematic*) that lets the user govern how much invention they've licensed, plus a **storyboard checkpoint** so the user approves the narrative before compute is spent. Those are design answers, not disclaimers — see the [architecture doc](prototype_architecture.md).

---

## What this demo is (v0.1)

One surface: **a live mockup of a Google Photos-style library**, deployed on Vercel.

- The library is seeded with **three sample collections** (5–8 photos each), each a different event/theme, clustered chronologically the way real photos land in a camera roll.
- You **multi-select photos** the way you would in Photos (tap-and-drag across a range), then hit the **Gemini button**.
- `gemini-omni-flash-preview` generates the film — your selected photos passed as reference frames, output rendered right in the demo, typically in about a minute.

That's the whole demo. Deliberately: no photo uploads, no library management, no account system. One surface, one magic moment, end to end on the real model.

### A nice touch: generate the camera roll itself

Toward the bottom of the demo, there's one extra flourish. Think of a memorable scene — *a wedding on Catalina Island*, *a road trip through Iceland* — and type it in. A Gemini image model generates a small set of thematically and sequentially coherent photos, dropped into the library as if they were a real camera-roll cluster. Then highlight them and hit the same Gemini button, and watch them become a film. It makes the demo explorable beyond the three seeded collections — any scene you can imagine becomes a testable input — while keeping the core flow identical.

### What's deliberately deferred to v0.2 (planned, not shipped)

Documented in full in [prototype_architecture.md](prototype_architecture.md):

- **Storyboard checkpoint** — an instant "scenes" screen between select and generate (style choice, beat structure, approve-before-spend).
- **Authenticity dial** — *Faithful ↔ Cinematic* control over how much the model may invent.
- **Conversational refinement** — "make the ending slower" edits one shot in place via the Interactions API, instead of regenerating.
- **Beat-synced scoring** — music-aware cut timing.
- **Android / in-Photos concept** — what shipping this inside the actual Google Photos surface would entail.

---

## Under the hood (brief)

Next.js on Vercel. Video generation via the Gemini API's Interactions API (`gemini-omni-flash-preview`) with selected photos passed as tagged reference images; the model natively produces multi-shot output, and longer selections are chunked into sequential generations and stitched. Scene generation uses a Gemini image model. Full design, cost controls, and constraint analysis: [prototype_architecture.md](prototype_architecture.md).

Honest constraints, because they shape the experience: output is 720p / 24fps, 3–10 seconds per generation; video compute is ~$0.10/second with no free tier (the demo has hard spend caps and a pre-generated showcase mode); the model is in public preview and person-generation fidelity is the first thing the build validates.

---

## About this project

This is a portfolio prototype. The product thesis, the feature concept, the UX direction, and the scoping decisions above are mine; the research validation and implementation are done with AI coding agents working from that direction — which is itself part of the point: the job of a PM in 2026 is to supply the judgment, taste, and reasoning that make the build worth doing, and to be able to demonstrate the experience rather than just describe it.
