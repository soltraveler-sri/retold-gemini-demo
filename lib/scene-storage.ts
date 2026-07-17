import { randomBytes } from "node:crypto";

export async function storeSceneImages(
  images: readonly Uint8Array[],
): Promise<readonly string[]> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required for live scene generation.");
  }

  const { del, put } = await import("@vercel/blob");
  const collectionId = randomBytes(9).toString("base64url");
  const urls: string[] = [];
  try {
    for (let index = 0; index < images.length; index += 1) {
      const blob = await put(
        `scenes/${collectionId}/photo-${index + 1}.jpg`,
        Buffer.from(images[index]!),
        {
          access: "public",
          addRandomSuffix: false,
          contentType: "image/jpeg",
          token,
        },
      );
      urls.push(blob.url);
    }
    return urls;
  } catch (error) {
    if (urls.length) {
      await del(urls, { token }).catch(() => undefined);
    }
    throw error;
  }
}
