// Downloads one web image for a user-triggered greeting bake (#7221).
// safeFetch supplies the network guard: http(s) only, every redirect hop
// re-validated, private/loopback/link-local/reserved addresses refused, and the
// checked DNS answer pinned for the connection. Nothing from the user's
// session (cookies, auth, API keys) is forwarded.
import { readImageDimensionsFromBuffer } from "../../utils/image-metadata.js";
import { isAllowedImageBuffer, safeFetch } from "../../utils/security.js";

export const GREETING_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const GREETING_IMAGE_MAX_PIXELS = 40_000_000;
const GREETING_IMAGE_TIMEOUT_MS = 15_000;
const GREETING_IMAGE_MAX_URL_LENGTH = 2048;
const GREETING_IMAGE_TYPES = new Set(["png", "jpg", "gif", "webp"]);

/** PNG, JPEG, GIF or WebP by magic bytes within the size and pixel caps; never SVG, HTML or anything else. */
export function validateGreetingImage(buffer: Buffer) {
  if (buffer.length > GREETING_IMAGE_MAX_BYTES) return null;
  const type = isAllowedImageBuffer(buffer);
  if (!type || !GREETING_IMAGE_TYPES.has(type.ext)) return null;
  const size = readImageDimensionsFromBuffer(buffer);
  if (!size || size.width * size.height > GREETING_IMAGE_MAX_PIXELS) return null;
  return { ext: type.ext, width: size.width, height: size.height };
}

export async function downloadGreetingImage(rawUrl: string) {
  if (rawUrl.length > GREETING_IMAGE_MAX_URL_LENGTH) throw new Error("The image link is too long");
  const url = URL.parse(rawUrl);
  if (!url) throw new Error("The image link is not a valid web address");
  if (url.username || url.password) throw new Error("Image links with a username or password can't be saved");
  const response = await safeFetch(url, {
    policy: { allowedProtocols: ["http:", "https:"], maxRedirects: 3 },
    maxResponseBytes: GREETING_IMAGE_MAX_BYTES,
    headers: { accept: "image/png,image/jpeg,image/gif,image/webp" },
    signal: AbortSignal.timeout(GREETING_IMAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The image host answered ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const image = validateGreetingImage(buffer);
  if (!image) throw new Error("Only PNG, JPEG, GIF or WebP images up to 10 MB and 40 megapixels can be saved");
  return { buffer, ...image };
}
