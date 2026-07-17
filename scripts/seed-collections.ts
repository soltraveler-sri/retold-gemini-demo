import { GoogleGenAI } from "@google/genai";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { loadCollections } from "../lib/collections.js";

const IMAGE_MODEL_ID = "gemini-3.1-flash-image" as const;
const IMAGE_PRICE_USD = 0.15;
const MAX_IMAGE_BYTES = 750 * 1024;
const MAX_COLLECTION_ASSET_BYTES = 15 * 1024 * 1024;
const JPEG_QUALITY_STEPS = [82, 76, 70, 64, 58] as const;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");

interface SeedPhoto {
  id: string;
  prompt: string;
}

interface SeedCollection {
  id: string;
  photos: readonly SeedPhoto[];
}

interface ImageInteractionResult {
  id: string;
  output_image?: { data?: string | undefined } | undefined;
  status: string;
}

interface CliOptions {
  collectionId?: string;
  force: boolean;
}

const SHARED_PHOTO_RULES = `Make one clearly synthetic, photorealistic 16:9 landscape event photograph, not a collage or contact sheet. Natural skin texture, documentary camera language, believable available light, and centered-safe composition for responsive cropping. Every person shown must unmistakably be an adult. The people must be entirely fictional with ordinary, unremarkable, everyday features. They must not resemble any real person, celebrity, actor, musician, politician, or public figure, living or dead. Avoid conventionally famous or model-like faces. No children, no text, no captions, no watermarks, no logos, no brand marks.`;

const COLLECTIONS: readonly SeedCollection[] = [
  {
    id: "wedding-evening",
    photos: [
      {
        id: "wedding-01",
        prompt: `${SHARED_PHOTO_RULES}\nEstablish a small early-summer wedding in the stone courtyard of an old country inn at 4:40 p.m. Show exactly two recurring newlywed adults walking away from the ceremony: a 34-year-old Black woman with deep brown skin, an oval face, close-cropped natural curls, small gold hoop earrings, and an ivory silk wide-leg jumpsuit; and a 36-year-old East Asian man with warm beige skin, a long face, short black hair brushed back, and a dark forest-green suit with an open-collar cream shirt. They hold hands and look at each other, with terracotta flowers, olive branches, and a few softly defocused adult guests behind them. Soft afternoon light, ivory, clay, green, and honey palette. Both faces clearly visible. This image establishes their exact identity, proportions, wardrobe, jewelry, and setting for a sequential photo chain.`,
      },
      {
        id: "wedding-02",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next photograph from the exact same wedding about 35 minutes later. Preserve the exact facial identity, age, hair, skin tone, body proportions, wedding clothes, and jewelry of both newlyweds from the previous image. Beneath courtyard olive branches, they pause for an unposed medium-wide portrait: she adjusts his lapel while he smiles at her. Change the camera angle but keep the stone inn, terracotta flowers, and adult-only gathering coherent. The sun is lower and warmer, with gentle rim light and long shadows. Both faces clearly visible.`,
      },
      {
        id: "wedding-03",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next chronological photograph from the same wedding during the early-evening toast. Keep the exact same two newlyweds from the previous images, with identical identities, proportions, clothing, hair, and jewelry. They lean together laughing at a long courtyard table while raising coupe glasses; a few adult friends toast around them, never obscuring the couple. Documentary candid framing from across the table, warm window light beginning to mix with the last amber daylight, coherent flowers and stone setting. Both recurring faces clearly visible.`,
      },
      {
        id: "wedding-04",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next chronological photograph from the exact same wedding as the first dance begins. Preserve both newlyweds' exact identity, age, faces, body proportions, clothing, hair, and jewelry. Show them moving into a relaxed first dance beneath warm string lights in the same stone courtyard, surrounded only by softly blurred adult guests. Medium-wide handheld documentary frame with a small sense of motion in fabric, sunset warmth fading toward blue at the courtyard edges. Both faces remain recognizable and unobstructed.`,
      },
      {
        id: "wedding-05",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next photograph later at the exact same wedding during blue hour. The same two newlyweds dance close near the open inn doors; preserve their exact faces, ages, hair, proportions, wedding clothes, and jewelry without redesigning either person. Use a closer candid angle than before, with deep cobalt ambient light outside and honey-colored practical light behind them. Keep the courtyard, flowers, and adult guests coherent. Their expressions are quiet and joyful, both faces clearly visible.`,
      },
      {
        id: "wedding-06",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the final chronological photograph from the exact same wedding at 10 p.m. Preserve the exact identity, faces, age, hair, body proportions, wedding clothing, and jewelry of the same two newlyweds. They stand together at the courtyard gate during an adults-only sparkler send-off, looking back toward the camera with sparklers forming warm points behind them, never crossing their faces. Wide cinematic documentary composition, dark ink-blue sky, warm skin tones, coherent stone inn and flowers. This is unmistakably the final night image of the same event.`,
      },
    ],
  },
  {
    id: "loft-birthday",
    photos: [
      {
        id: "birthday-01",
        prompt: `${SHARED_PHOTO_RULES}\nEstablish an adults-only 42nd birthday supper in a lived-in city loft at 5 p.m. Show exactly two recurring fictional adults setting a long dinner table: the birthday host, a 45-year-old Latino man with olive skin, a broad round face, thick dark hair receding slightly at the temples, heavy black-framed glasses, clean-shaven, and a rust corduroy overshirt over a cream T-shirt; and his 47-year-old Black female partner with deep brown skin, a soft square jaw, close-cropped greying natural hair, a teal satin blouse, and small silver earrings. They arrange blood oranges, coral napkins, candles, and a small citrus cake beneath paper garlands. Broad late-afternoon window light, coral, amber, and teal palette. Both faces clearly visible. This establishes exact identity, proportions, clothing, and setting for a sequential chain.`,
      },
      {
        id: "birthday-02",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next photograph from the exact same loft birthday about 30 minutes later. Preserve the birthday host and his partner's exact facial identities, ages, hair, body proportions, clothing, and accessories. They welcome a pair of adult friends through the loft door, the host mid-laugh and his partner touching his shoulder. Everyone shown is clearly over 25. Change to a candid doorway angle while keeping the long table, paper garlands, cake, and coral-amber-teal palette coherent. Late sunlight still reaches the room; both recurring faces are visible.`,
      },
      {
        id: "birthday-03",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next chronological photograph from the same adults-only birthday as dinner begins. Preserve the exact same birthday host and partner from the previous images—identical faces, ages, hair, body proportions, rust overshirt, teal blouse, and accessories. They sit side by side raising glasses during a toast, surrounded by a small group of softly defocused adult friends. Documentary view down the table with citrus, coral linens, and candles; golden window light now mixes with warm lamps. Keep both recurring faces clearly visible.`,
      },
      {
        id: "birthday-04",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next chronological photograph from the exact same birthday at cake time. The same 42-year-old host leans toward the lit citrus cake while his partner laughs beside him with one hand on his shoulder. Preserve both adults' exact identity, face, age, hair, proportions, clothing, and accessories. Adult friends frame the moment but do not block either recurring face. Close candid composition, candlelight warming their faces, the loft beyond falling into soft amber and teal shadow.`,
      },
      {
        id: "birthday-05",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next photograph later at the exact same adults-only loft birthday. Preserve the host and his partner's exact facial identity, age, hair, body proportions, rust and teal clothing, and accessories. After the toast, they share a quiet amused look at the end of the table while adult friends talk softly in the background. Use an intimate medium shot from a new angle; candles are lower, rain has begun on the dark windows, and coral table details remain coherent. Both faces clearly visible.`,
      },
      {
        id: "birthday-06",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the final chronological photograph from the exact same birthday after dinner. The same host and partner dance together beside rain-dark loft windows while a few unmistakably adult friends move in soft background blur. Preserve the pair's exact faces, ages, hair, body proportions, clothing, and accessories without substitution or redesign. Wide handheld night photograph with reflected city lights, warm lamps, and the established coral-amber-teal palette. Both recurring faces remain recognizable; this reads as the final late-night moment of the same event.`,
      },
    ],
  },
  {
    id: "coastal-road-trip",
    photos: [
      {
        id: "coast-01",
        prompt: `${SHARED_PHOTO_RULES}\nEstablish a one-day winter coastal road trip at 8:15 a.m. Show exactly two recurring adult friends beside a fictional unbranded seafoam-green vintage station wagon at a misty overlook: a 31-year-old Filipina woman with warm tan skin, a heart-shaped face, long black hair in a low braid, a sage field jacket, cream fisherman sweater, and rust scarf; and a 33-year-old Black woman with deep brown skin, a round face, short natural coils, a navy wool coat, faded denim shirt, and small brass stud earrings. They unfold a paper map across the hood and smile at each other. Sea-salt blue, fog, sage, rust, and charcoal palette; both faces clearly visible. This establishes exact identity, proportions, wardrobe, vehicle, and landscape for a sequential chain.`,
      },
      {
        id: "coast-02",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next photograph from the exact same coastal road trip about 80 minutes later. Preserve both adult friends' exact facial identities, ages, hair, body proportions, layered clothing, scarf, and earrings, plus the same unbranded seafoam wagon. At a brighter roadside turnout, one friend leans against the open passenger door while the other holds the folded map; they look toward the camera in a spontaneous laugh. New camera angle, silver morning light, receding fog, coherent rugged coastline. Both faces clearly visible.`,
      },
      {
        id: "coast-03",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next chronological photograph from the same road trip near noon. Preserve the exact identities, faces, age, hair, proportions, clothing, and accessories of the same two adult friends. They walk shoulder to shoulder across a windswept cliff path, turning back toward the camera; their jackets and scarf move naturally in the salt wind. The same seafoam wagon is small in the distant turnout. Wide documentary landscape, crisp pewter-blue sea and pale sky, both faces still recognizable.`,
      },
      {
        id: "coast-04",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next chronological photograph from the exact same coastal day in mid-afternoon. Keep both friends' exact facial identity, age, hair, body proportions, layered clothing, scarf, and earrings. They share enamel mugs of coffee outside a weathered, unbranded roadside stop while sitting on the seafoam wagon's open tailgate. No other people are prominent. Medium-wide candid framing, softened overcast light with the first hint of warmth, coherent misty coast, sage, rust, and blue palette. Both faces clearly visible.`,
      },
      {
        id: "coast-05",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the next photograph later on the exact same coastal road trip at golden hour. Preserve the exact same two adult friends, including their faces, ages, hair, proportions, clothing, accessories, and the same seafoam wagon. They stand beside the hood at a high cliff turnout, one pointing down the road while the other watches her, both caught in warm side light. Wide cinematic documentary composition, long shadows, rust-colored grass, blue sea, no prominent strangers. Their identities remain clear.`,
      },
      {
        id: "coast-06",
        prompt: `${SHARED_PHOTO_RULES}\nCreate the final chronological photograph from the exact same road trip at blue hour. Preserve both adult friends' exact facial identities, ages, hair, body proportions, layered clothing, scarf, earrings, and the same unbranded seafoam wagon. They stand close beside the parked wagon above the ocean, looking back toward the camera as the last peach line fades from the horizon. Wide, quiet documentary frame with cool sea-salt blue light and a subtle warm glow from the car interior. Both faces recognizable; unmistakably the closing image of the same day.`,
      },
    ],
  },
];

function parseArgs(args: readonly string[]): CliOptions {
  let collectionId: string | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--collection") {
      collectionId = args[index + 1];
      if (!collectionId) {
        throw new Error("--collection requires a collection id.");
      }
      index += 1;
      continue;
    }
    if (arg?.startsWith("--collection=")) {
      collectionId = arg.slice("--collection=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    ...(collectionId === undefined ? {} : { collectionId }),
    force,
  };
}

function requireApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to seed collection images.");
  }
  return apiKey;
}

function imageBytes(
  interaction: ImageInteractionResult,
  label: string,
): Buffer {
  if (interaction.status !== "completed") {
    throw new Error(
      `${label} interaction ${interaction.id} ended with status ${interaction.status}.`,
    );
  }
  const data = interaction.output_image?.data;
  if (!data) {
    throw new Error(
      `${label} interaction ${interaction.id} completed without output_image.data.`,
    );
  }
  return Buffer.from(data, "base64");
}

async function optimizedJpeg(input: Buffer, label: string): Promise<Buffer> {
  for (const quality of JPEG_QUALITY_STEPS) {
    const output = await sharp(input)
      .rotate()
      .resize(1024, 576, { fit: "cover", position: "attention" })
      .jpeg({ mozjpeg: true, progressive: true, quality })
      .toBuffer();
    if (output.byteLength <= MAX_IMAGE_BYTES) return output;
  }
  throw new Error(
    `${label} could not be compressed below ${MAX_IMAGE_BYTES} bytes at 1024x576.`,
  );
}

function outputPath(file: string): string {
  const path = resolve(PUBLIC_DIR, file.replace(/^\/+/, ""));
  if (!path.startsWith(`${PUBLIC_DIR}${sep}`)) {
    throw new Error(`Collection file escapes public/: ${file}`);
  }
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function redactError(error: unknown, secret: string | undefined): string {
  const raw = error instanceof Error ? error.stack ?? error.message : String(error);
  return secret ? raw.split(secret).join("[REDACTED]") : raw;
}

async function totalAssetBytes(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) {
    if (await exists(path)) total += (await stat(path)).size;
  }
  return total;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const jobs = options.collectionId
    ? COLLECTIONS.filter((collection) => collection.id === options.collectionId)
    : COLLECTIONS;
  if (jobs.length === 0) {
    throw new Error(`Unknown collection id: ${options.collectionId}`);
  }

  const manifest = loadCollections();
  const requestedImageCount = jobs.reduce(
    (total, collection) => total + collection.photos.length,
    0,
  );
  console.log(
    `Preparing ${requestedImageCount} images with ${IMAGE_MODEL_ID}; estimated image cost $${(
      requestedImageCount * IMAGE_PRICE_USD
    ).toFixed(2)}.`,
  );

  const apiKey = requireApiKey();
  const ai = new GoogleGenAI({ apiKey });
  const allAssetPaths = manifest.flatMap((collection) =>
    collection.photos.map((photo) => outputPath(photo.file)),
  );

  for (const job of jobs) {
    const collection = manifest.find((candidate) => candidate.id === job.id);
    if (!collection) {
      throw new Error(`Generation job ${job.id} is missing from data/collections.json.`);
    }
    if (
      collection.photos.length !== job.photos.length ||
      job.photos.some((photo, index) => collection.photos[index]?.id !== photo.id)
    ) {
      throw new Error(
        `Generation job ${job.id} does not match the manifest photo order.`,
      );
    }

    const paths = collection.photos.map((photo) => outputPath(photo.file));
    const present = await Promise.all(paths.map(exists));
    if (!options.force && present.every(Boolean)) {
      console.log(`Skipped ${job.id}: all ${paths.length} images already exist.`);
      continue;
    }
    if (!options.force && present.some(Boolean)) {
      throw new Error(
        `${job.id} is only partially seeded. Re-run with --force so the full identity chain is regenerated together.`,
      );
    }

    console.log(`Generating ${job.id} as one ${job.photos.length}-image interaction chain.`);
    let previousInteractionId: string | undefined;
    for (let index = 0; index < job.photos.length; index += 1) {
      const seedPhoto = job.photos[index]!;
      const manifestPhoto = collection.photos[index]!;
      const interaction = await ai.interactions.create({
        model: IMAGE_MODEL_ID,
        input: seedPhoto.prompt,
        ...(previousInteractionId === undefined
          ? {}
          : { previous_interaction_id: previousInteractionId }),
        store: true,
        background: false,
        stream: false,
        response_format: {
          type: "image",
          mime_type: "image/jpeg",
          aspect_ratio: "16:9",
          image_size: "1K",
        },
      });
      const bytes = await optimizedJpeg(
        imageBytes(interaction, seedPhoto.id),
        seedPhoto.id,
      );
      const path = outputPath(manifestPhoto.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      previousInteractionId = interaction.id;
      console.log(
        `  Wrote ${manifestPhoto.file} (${(bytes.byteLength / 1024).toFixed(0)} KiB; interaction ${interaction.id}).`,
      );
    }
  }

  const totalBytes = await totalAssetBytes(allAssetPaths);
  if (totalBytes > MAX_COLLECTION_ASSET_BYTES) {
    throw new Error(
      `Collection assets total ${(totalBytes / 1_048_576).toFixed(2)} MiB, over the 15 MiB cap.`,
    );
  }
  console.log(
    `Collection assets present: ${(totalBytes / 1_048_576).toFixed(2)} MiB (15 MiB cap).`,
  );
}

main().catch((error: unknown) => {
  console.error("Collection seeding failed.");
  console.error(redactError(error, process.env.GEMINI_API_KEY));
  process.exitCode = 1;
});
