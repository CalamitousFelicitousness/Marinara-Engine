import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const requireFromServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { Agent, getGlobalDispatcher, setGlobalDispatcher } = requireFromServer("undici");

const previousImageTimeout = process.env.IMAGE_GEN_TIMEOUT_MS;
const previousComfyTimeout = process.env.COMFYUI_GEN_TIMEOUT;
process.env.IMAGE_GEN_TIMEOUT_MS = "80";
process.env.COMFYUI_GEN_TIMEOUT = "1";

const originalDispatcher = getGlobalDispatcher();
const shortGlobalDispatcher = new Agent({ headersTimeout: 40, bodyTimeout: 40 });
setGlobalDispatcher(shortGlobalDispatcher);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const server = createServer((request, response) => {
  if (request.url === "/API/GetNewSession") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ session_id: "regression-session" }));
    return;
  }
  if (request.url === "/API/GenerateText2Image") {
    setTimeout(() => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ images: ["View/generated.png"] }));
    }, 120);
    return;
  }
  if (request.url === "/View/generated.png") {
    response.setHeader("Content-Type", "image/png");
    response.end(png);
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { generateImage, resolveComfyUiImageGenerationTimeoutMs } =
    await import("../../packages/server/src/services/image/image-generation.js");

  assert.equal(
    resolveComfyUiImageGenerationTimeoutMs(1_800_000, 2400),
    2_400_000,
    "SwarmUI and ComfyUI share the longer configured image-generation deadline",
  );
  const result = await generateImage("swarmui", `http://127.0.0.1:${address.port}`, "", "swarmui", {
    prompt: "timeout regression",
  });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.base64, png.toString("base64"));
} finally {
  setGlobalDispatcher(originalDispatcher);
  await shortGlobalDispatcher.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousImageTimeout === undefined) delete process.env.IMAGE_GEN_TIMEOUT_MS;
  else process.env.IMAGE_GEN_TIMEOUT_MS = previousImageTimeout;
  if (previousComfyTimeout === undefined) delete process.env.COMFYUI_GEN_TIMEOUT;
  else process.env.COMFYUI_GEN_TIMEOUT = previousComfyTimeout;
}

console.info("SwarmUI timeout regression passed.");
