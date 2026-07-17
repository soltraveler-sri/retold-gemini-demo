import { loadCollections } from "../lib/collections";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatClusterDate(timestamp: string): string {
  const dateKey = timestamp.slice(0, 10);
  return dateFormatter.format(new Date(`${dateKey}T12:00:00Z`));
}

function RetoldMark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 place-items-center rounded-[12px] bg-[#25231f] font-editorial text-[19px] italic text-white shadow-[0_5px_16px_rgba(37,35,31,0.12)]"
    >
      R
    </span>
  );
}

function PlaceholderTile({
  alt,
  index,
}: {
  alt: string;
  index: number;
}) {
  return (
    <div
      aria-label={alt}
      className="placeholder-tile relative aspect-[4/5] min-w-0 overflow-hidden rounded-[14px]"
      data-tone={index % 5}
      role="img"
    >
      <span
        aria-hidden="true"
        className="absolute right-2.5 top-2.5 size-[18px] rounded-full border border-white/75 bg-black/[0.05] shadow-[0_1px_5px_rgba(40,37,32,0.14)]"
      />
      <span className="absolute inset-x-3 bottom-3 flex items-end justify-between text-[10px] font-medium tracking-[0.12em] text-[#3f3b35]/55">
        <span>PHOTO</span>
        <span>{String(index + 1).padStart(2, "0")}</span>
      </span>
    </div>
  );
}

export default function Home() {
  const collections = loadCollections();
  const photoCount = collections.reduce(
    (total, collection) => total + collection.photos.length,
    0,
  );

  return (
    <main className="min-h-screen bg-[#fbfaf7] text-[#25231f]">
      <header className="sticky top-0 z-20 border-b border-[#25231f]/[0.08] bg-[#fbfaf7]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <RetoldMark />
            <div className="flex items-baseline gap-2.5">
              <span className="font-editorial text-[26px] leading-none tracking-[-0.03em]">
                Retold
              </span>
              <span className="hidden text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6e6961] sm:inline">
                Gemini demo
              </span>
            </div>
          </div>

          <div className="hidden shrink-0 rounded-full border border-[#25231f]/10 bg-white/70 px-4 py-1.5 text-[11px] font-medium tracking-[0.01em] text-[#6e6961] shadow-[0_1px_2px_rgba(37,35,31,0.03)] sm:block">
            Concept demo — not affiliated with Google
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 pb-20 pt-12 sm:px-7 sm:pt-16">
        <section className="mb-14 flex flex-col justify-between gap-7 border-b border-[#25231f]/10 pb-9 sm:flex-row sm:items-end">
          <div>
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.19em] text-[#8c5746]">
              Your library
            </p>
            <h1 className="max-w-3xl font-editorial text-[clamp(2.75rem,6vw,5.4rem)] font-normal leading-[0.94] tracking-[-0.055em]">
              Moments, waiting
              <br />
              to move again.
            </h1>
          </div>
          <div className="max-w-xs sm:pb-1 sm:text-right">
            <p className="text-sm leading-6 text-[#6e6961]">
              The camera-roll structure is ready. Seed photographs arrive in
              the next build.
            </p>
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#3f3b35]">
              {collections.length} moments · {photoCount} placeholders
            </p>
          </div>
        </section>

        <div className="space-y-16 sm:space-y-20">
          {collections.map((collection) => (
            <section key={collection.id} aria-labelledby={`${collection.id}-date`}>
              <div className="mb-4 flex items-end justify-between gap-5 sm:mb-5">
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8c5746]">
                    {collection.title}
                  </p>
                  <h2
                    className="font-editorial text-[clamp(1.6rem,3vw,2.25rem)] tracking-[-0.025em]"
                    id={`${collection.id}-date`}
                  >
                    {formatClusterDate(collection.photos[0]!.timestamp)}
                  </h2>
                </div>
                <span className="pb-1 text-[11px] font-medium text-[#8a857d]">
                  {collection.photos.length} photos
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6 lg:gap-2">
                {collection.photos.map((photo, index) => (
                  <PlaceholderTile alt={photo.alt} index={index} key={photo.id} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="mt-20 border-t border-[#25231f]/10 pt-10 sm:mt-28 sm:flex sm:items-start sm:justify-between">
          <p className="font-editorial text-2xl tracking-[-0.02em]">
            The roll begins here.
          </p>
          <p className="mt-3 max-w-sm text-sm leading-6 text-[#777169] sm:mt-0 sm:text-right">
            Selection and film generation are intentionally reserved for the
            next layers of the prototype.
          </p>
        </section>
      </div>

      <div className="fixed bottom-3 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-[#25231f]/10 bg-[#fbfaf7]/95 px-3.5 py-2 text-[10px] font-medium text-[#6e6961] shadow-[0_4px_18px_rgba(37,35,31,0.10)] backdrop-blur sm:hidden">
        Concept demo — not affiliated with Google
      </div>
    </main>
  );
}
