import type { FastifyStaticOptions } from "@fastify/static";
import { basename, resolve, sep } from "node:path";

const REVALIDATE_FILES = new Set(["index.html"]);
const NO_STORE_FILES = new Set(["manifest.json", "sw.js", "registerSW.js"]);

/**
 * Prefixes that must 404 rather than fall back to the SPA shell.
 *
 * `wildcard: false` makes @fastify/static enumerate dist at registration, so a
 * file written afterwards -- an auto-update, or a rebuild under a running server
 * -- has no route and lands on the not-found handler. Answering a hashed chunk
 * request with 200 + index.html makes the browser reject it as
 * "Expected a JavaScript-or-Wasm module script but the server responded with a
 * MIME type of text/html", which reads as a broken app rather than a stale tab.
 * A plain 404 is the truth, and it lets the client's `vite:preloadError`
 * recovery clear the service worker and reload.
 */
const NON_SPA_PREFIXES = ["/api/", "/assets/"] as const;

export function isNonSpaRequest(url: string | undefined | null) {
  if (typeof url !== "string") return false;
  return NON_SPA_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function createClientStaticOptions(clientDist: string): FastifyStaticOptions {
  const immutableAssetPrefix = `${resolve(clientDist, "assets")}${sep}`;

  return {
    root: clientDist,
    prefix: "/",
    wildcard: false,
    decorateReply: false,
    // @fastify/static applies its generated Cache-Control header after
    // setHeaders. Disable that default so the update-safe policies below win.
    cacheControl: false,
    setHeaders(res, filePath) {
      const fileName = basename(filePath);

      if (REVALIDATE_FILES.has(fileName)) {
        res.header("Cache-Control", "no-cache, must-revalidate");
        res.header("Pragma", "no-cache");
        res.header("Expires", "0");
        return;
      }

      if (NO_STORE_FILES.has(fileName)) {
        res.header("Cache-Control", "no-store, no-cache, must-revalidate");
        res.header("Pragma", "no-cache");
        res.header("Expires", "0");
        return;
      }

      // Vite fingerprints every file emitted beneath dist/assets, including
      // lazy JS chunks, CSS, and fonts. Those URLs are safe to cache forever.
      if (filePath.startsWith(immutableAssetPrefix)) {
        res.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  };
}
