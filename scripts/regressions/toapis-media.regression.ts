import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// All HTTP and DNS are fixtures: no live API, pricing query, upload or paid task.
process.env.TOAPIS_POLL_INTERVAL_MS = "1";
process.env.SEEDANCE_VIDEO_POLL_INTERVAL_MS = "1";
process.env.IMAGE_GEN_TIMEOUT_MS = "1000";
process.env.LOG_LEVEL = "silent";
const originalFetch = globalThis.fetch;
const originalLookup = dns.lookup;
dns.lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as typeof dns.lookup;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d6d703432", "hex");
type Call = { url: string; method: string; headers: Headers; body: unknown };
let calls: Call[] = [];
let mode = "complete";
let transientPolls = 0;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
  calls.push({ url: url.href, method: init?.method || "GET", headers: new Headers(init?.headers), body });
  if (url.hostname === "media.toapis.com") {
    assert.equal(new Headers(init?.headers).has("Authorization"), false, "Never leak Key to storage");
    return new Response(
      mode === "bad-media"
        ? Buffer.from("not media")
        : url.pathname.endsWith(".png")
          ? Buffer.from(png, "base64")
          : mp4,
    );
  }
  assert.ok(
    ["toapis.com", "toapis.cn", "api.openai.com", "api.seedance2.ai"].includes(url.hostname),
    "Unexpected network destination",
  );
  if (url.hostname === "api.openai.com") return json({ data: [{ b64_json: png }] });
  if (url.hostname === "api.seedance2.ai") {
    if (init?.method === "POST") return json({ taskId: "legacy" });
    return json({ status: "completed", output: { url: "https://media.toapis.com/legacy.mp4" } });
  }
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-key");
  if (url.pathname === "/v1/uploads/images") {
    assert.ok(body instanceof FormData);
    assert.equal((body.get("file") as Blob).type, "image/png");
    return json({ data: { url: "https://media.toapis.com/uploaded.png" } });
  }
  const kind = url.pathname.includes("images") ? "images" : "videos";
  if (init?.method === "POST") {
    if (mode === "uncertain") throw new Error("fixture transport lost response");
    if (mode === "missing-id") return json({ status: "queued" });
    if (mode === "rejected") return json({ error: { message: "fixture rejection" } }, 401);
    if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "/v1/replayed" } });
    return json({
      id: `fixture-${kind}`,
      status: mode === "immediate" ? "completed" : "queued",
      result: { data: [{ url: `https://media.toapis.com/output.${kind === "images" ? "png" : "mp4"}` }] },
    });
  }
  if (mode === "stall") return json({ id: `fixture-${kind}`, status: "processing" });
  if (mode === "failed") return json({ id: `fixture-${kind}`, status: "failed" });
  if (mode === "poll-http") return json({ error: "fixture" }, 503);
  if (mode === "poll-once" && transientPolls++ === 0) return json({ error: "fixture" }, 503);
  if (mode === "poll-unauthorized") return json({ error: "fixture" }, 401);
  if (mode === "private-output") {
    return json({ status: "completed", result: { data: [{ url: "https://127.0.0.1/private.png" }] } });
  }
  return json({
    id: `fixture-${kind}`,
    status: "completed",
    result: { data: [{ url: `https://media.toapis.com/output.${kind === "images" ? "png" : "mp4"}` }] },
  });
};

let passed = 0;
async function check(name: string, run: () => void | Promise<void>) {
  calls = [];
  mode = "complete";
  transientPolls = 0;
  await run();
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}
try {
  const { generateImage } = await import("../../packages/server/src/services/image/image-generation.js");
  const { generateVideo } = await import("../../packages/server/src/services/video/video-generation.js");
  const { isToAPIsMediaUrl } = await import("../../packages/server/src/services/media/toapis-media.js");
  const { DATA_DIR } = await import("../../packages/server/src/utils/data-dir.js");
  const image = (patch = {}) =>
    generateImage("openai", "https://toapis.com/v1", "fixture-key", "openai", {
      model: "gpt-image-2",
      prompt: "library",
      width: 1024,
      height: 576,
      ...patch,
    });
  const video = (patch = {}) =>
    generateVideo("seedance", "https://toapis.com/v1", "fixture-key", "seedance", {
      model: "seedance-2-mini",
      prompt: "gentle motion",
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "480p",
      referenceImage: { base64: png, mimeType: "image/png" },
      ...patch,
    });
  const submissions = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/generations"));
  const imageFallback = {
    connectionId: "fallback-image",
    connectionName: "Fallback image",
    source: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "legacy-key",
    serviceHint: "openai",
    model: "gpt-image-2",
  };
  const videoFallback = {
    connectionId: "fallback-video",
    connectionName: "Fallback video",
    source: "seedance",
    baseUrl: "https://api.seedance2.ai",
    apiKey: "legacy-key",
    serviceHint: "seedance",
    model: "seedance-2-0",
  };
  await check("strict origin selection", () => {
    for (const url of ["https://toapis.com", "https://toapis.cn/v1/"]) assert.ok(isToAPIsMediaUrl(url));
    for (const url of [
      "https://toapis.com.attacker.org/v1",
      "http://toapis.com",
      "https://toapis.com:8443",
      "https://user@toapis.com",
      "https://toapis.com/other",
      "https://toapis.com/?x=1",
    ])
      assert.equal(isToAPIsMediaUrl(url), false);
  });
  await check("image async creation, exact parameters and pixels", async () => {
    assert.deepEqual(await image({ negativePrompt: "people" }), { base64: png, mimeType: "image/png", ext: "png" });
    assert.deepEqual(submissions()[0]!.body, {
      model: "gpt-image-2",
      prompt: "library\n\nDo not include: people.",
      size: "16:9",
      resolution: "1k",
      n: 1,
    });
    assert.equal(submissions().length, 1);
    assert.ok(calls.some((c) => c.url.endsWith("images/generations/fixture-images")));
  });
  await check("reference edit uploads image instead of dropping it", async () => {
    await image({ referenceImage: png });
    assert.deepEqual((submissions()[0]!.body as Record<string, unknown>).reference_images, [
      "https://media.toapis.com/uploaded.png",
    ]);
  });
  await check("first-frame video uses ToAPIs upload and task route", async () => {
    assert.equal((await video()).base64, mp4.toString("base64"));
    assert.deepEqual(submissions()[0]!.body, {
      model: "seedance-2-mini",
      prompt: "gentle motion",
      duration: 4,
      resolution: "480p",
      aspect_ratio: "16:9",
      generate_audio: false,
      image_with_roles: [{ url: "https://media.toapis.com/uploaded.png", role: "first_frame" }],
    });
    assert.ok(calls.some((c) => c.url.endsWith("videos/generations/fixture-videos")));
    assert.equal(
      calls.some((c) => c.url.includes("/tasks/") || c.url.includes("catbox")),
      false,
    );
  });
  await check("text-only Test Video route", async () => {
    await video({ referenceImage: null });
    assert.equal(
      calls.some((c) => c.url.endsWith("uploads/images")),
      false,
    );
  });
  await check("unsupported image model fails before upload or POST", async () => {
    await assert.rejects(image({ model: "gpt-image-2-vip", referenceImage: png }), /ordinary gpt-image-2/);
    assert.equal(calls.length, 0);
  });
  await check("unmapped quality, transparency, ratio and multiple references fail early", async () => {
    for (const patch of [
      { quality: "high" },
      { transparentBackground: true },
      { width: 500, height: 1000 },
      { referenceImages: [png, png] },
    ])
      await assert.rejects(image(patch));
    assert.equal(calls.length, 0);
  });
  await check("invalid video inputs fail before upload or POST", async () => {
    for (const patch of [
      { durationSeconds: 3 },
      { durationSeconds: 5 },
      { durationSeconds: 15 },
      { resolution: "720p" },
      { resolution: "1080p" },
      { aspectRatio: "9:16" },
      { model: "seedance-2" },
      { lastFrameImage: { base64: png, mimeType: "image/png" } },
      { referenceImage: { base64: "bad-data", mimeType: "image/png" } },
    ])
      await assert.rejects(video(patch));
    assert.equal(calls.length, 0);
  });
  await check("failed task does not trigger legacy automatic retry", async () => {
    mode = "failed";
    await assert.rejects(video(), /no replacement/);
    assert.equal(submissions().length, 1);
  });
  await check("lost submission response is not retried", async () => {
    mode = "uncertain";
    await assert.rejects(image(), /submission unconfirmed/);
    assert.equal(submissions().length, 1);
  });
  await check("missing task ID is not retried", async () => {
    mode = "missing-id";
    await assert.rejects(image(), /no task ID/);
    assert.equal(submissions().length, 1);
  });
  await check("polling HTTP failure is not a new generation", async () => {
    mode = "poll-http";
    await assert.rejects(image(), /HTTP 503/);
    assert.equal(submissions().length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 30);
  });
  await check("a transient polling error is retried without a new paid job", async () => {
    mode = "poll-once";
    assert.equal((await image()).base64, png);
    assert.equal(submissions().length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("fixture-images")).length, 2);
  });
  await check("definite polling rejection fails immediately without a new job", async () => {
    mode = "poll-unauthorized";
    await assert.rejects(video({ fallback: videoFallback }), /HTTP 401/);
    assert.equal(submissions().length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 1);
  });
  await check("definite submission rejection retains the HTTP status", async () => {
    mode = "rejected";
    await assert.rejects(image(), /HTTP 401/);
    assert.equal(submissions().length, 1);
  });
  await check("validation before any paid submission can use the configured fallback", async () => {
    assert.equal((await image({ model: "unsupported", fallback: imageFallback })).base64, png);
    await video({ model: "unsupported", referenceImage: null, fallback: videoFallback });
    assert.equal(
      calls.some((call) => new URL(call.url).hostname === "toapis.com"),
      false,
    );
    assert.equal(submissions().length, 2);
  });
  await check("ambiguous and completed submissions never activate a paid fallback", async () => {
    for (const failure of ["uncertain", "missing-id", "poll-http", "bad-media", "failed"]) {
      mode = failure;
      await assert.rejects(image({ fallback: imageFallback }), { retryable: false });
      await assert.rejects(video({ fallback: videoFallback }), { retryable: false });
    }
    assert.equal(submissions().length, 10);
    assert.equal(
      calls.some((call) => ["api.openai.com", "api.seedance2.ai"].includes(new URL(call.url).hostname)),
      false,
    );
  });
  await check("API redirects cannot replay a paid POST or activate fallback", async () => {
    mode = "redirect";
    await assert.rejects(image({ fallback: imageFallback }), /submission unconfirmed/);
    assert.equal(submissions().length, 1);
    assert.equal(calls.length, 1);
  });
  await check("private output URLs are rejected before download", async () => {
    mode = "private-output";
    await assert.rejects(image());
    assert.equal(
      calls.some((call) => call.url.includes("127.0.0.1")),
      false,
    );
  });
  await check("cancellation before submission buys no task", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(image({ signal: controller.signal }));
    await assert.rejects(video({ signal: controller.signal }));
    assert.equal(calls.length, 0);
  });
  await check("caller cancellation stops polling, preserves receipt", async () => {
    mode = "stall";
    const started = Date.now();
    await assert.rejects(video({ signal: AbortSignal.timeout(100) }));
    assert.ok(Date.now() - started < 1500);
    assert.equal(submissions().length, 1);
  });
  await check("invalid media rejected", async () => {
    mode = "bad-media";
    await assert.rejects(video(), /non-MP4/);
  });
  await check("image deadline never submits a paid fallback", async () => {
    mode = "stall";
    await assert.rejects(image({ fallback: imageFallback }), { message: /timed out/, retryable: false });
    assert.equal(submissions().length, 1);
    assert.equal(
      calls.some((call) => new URL(call.url).hostname === "api.openai.com"),
      false,
    );
  });
  await check("default compatible image deadline is nonretryable too", async () => {
    mode = "stall";
    await assert.rejects(
      generateImage("custom", "https://toapis.com/v1", "fixture-key", "custom", {
        model: "gpt-image-2",
        prompt: "library",
        fallback: imageFallback,
      }),
      { message: /timed out/, retryable: false },
    );
    assert.equal(submissions().length, 1);
    assert.equal(
      calls.some((call) => new URL(call.url).hostname === "api.openai.com"),
      false,
    );
  });
  await check("ordinary OpenAI path preserved", async () => {
    assert.equal(
      (
        await generateImage("openai", "https://api.openai.com/v1", "legacy-key", "openai", {
          model: "gpt-image-2",
          prompt: "library",
        })
      ).base64,
      png,
    );
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/images/generations");
  });
  await check("ordinary Seedance path preserved", async () => {
    await generateVideo("seedance", "https://api.seedance2.ai", "legacy-key", "seedance", {
      prompt: "motion",
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "480p",
    });
    assert.ok((submissions()[0]!.body as Record<string, unknown>).input);
    assert.ok(calls.some((c) => c.url === "https://api.seedance2.ai/v1/tasks/legacy"));
  });
  await check("private receipts retain task identity without Key", async () => {
    const dir = join(DATA_DIR, "toapis-tasks");
    const receipts = await Promise.all((await readdir(dir)).map((file) => readFile(join(dir, file), "utf8")));
    assert.ok(receipts.some((text) => JSON.parse(text).status === "interrupted"));
    assert.ok(receipts.some((text) => JSON.parse(text).status === "submission_uncertain"));
    assert.ok(receipts.some((text) => JSON.parse(text).taskId === "fixture-videos"));
    assert.ok(receipts.every((text) => !text.includes("fixture-key")));
    assert.ok(receipts.every((text) => !text.includes("library") && !text.includes("gentle motion")));
    if (process.platform !== "win32") {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      for (const file of await readdir(dir)) assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
    }
  });

  const { createRequire } = await import("node:module");
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { connectionsRoutes } = await import("../../packages/server/src/routes/connections.routes.js");
  const app = Fastify();
  app.decorate("db", await getDB());
  await app.register(connectionsRoutes, { prefix: "/api/connections" });
  let imageId = "",
    videoId = "";
  try {
    await check("real HTTP connection save, reload and Key masking", async () => {
      for (const kind of ["image", "video"]) {
        const saved = await app.inject({
          method: "POST",
          url: "/api/connections/",
          payload: {
            name: `ToAPIs fixture ${kind}`,
            provider: `${kind}_generation`,
            baseUrl: "https://toapis.com/v1",
            apiKey: "fixture-key",
            model: kind === "image" ? "gpt-image-2" : "seedance-2-mini",
            ...(kind === "image"
              ? { imageService: "openai", imageGenerationSource: "openai", defaultForAgents: true }
              : {
                  videoService: "seedance",
                  videoGenerationSource: "seedance",
                  defaultForAgents: true,
                }),
          },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        const id = saved.json().id;
        assert.ok(id);
        if (kind === "image") imageId = id;
        else {
          videoId = id;
          const defaults = await app.inject({
            method: "PUT",
            url: `/api/connections/${id}/default-parameters`,
            payload: {
              videoGeneration: { service: "seedance", durationSeconds: 4, aspectRatio: "16:9", resolution: "480p" },
            },
          });
          assert.equal(defaults.statusCode, 200, defaults.body);
        }
        const loaded = await app.inject(`/api/connections/${id}`);
        assert.equal(loaded.statusCode, 200);
        assert.equal(loaded.json().baseUrl, "https://toapis.com/v1");
        assert.equal(loaded.body.includes("fixture-key"), false);
      }
    });
    await check("real HTTP Test Image button route", async () => {
      const response = await app.inject({ method: "POST", url: `/api/connections/${imageId}/test-image`, payload: {} });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().success, true, response.body);
      assert.equal(response.json().base64, png);
      assert.equal(submissions().length, 1);
    });
    await check("real HTTP Test Video button route", async () => {
      const response = await app.inject({ method: "POST", url: `/api/connections/${videoId}/test-video`, payload: {} });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().success, true, response.body);
      assert.equal(response.json().base64, mp4.toString("base64"));
      assert.equal(submissions().length, 1);
    });
    const { galleryRoutes } = await import("../../packages/server/src/routes/gallery.routes.js");
    const galleryApp = Fastify();
    galleryApp.decorate("db", app.db);
    await galleryApp.register(galleryRoutes, { prefix: "/api/gallery" });
    try {
      const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
      const { createChatSchema } = await import("../../packages/shared/src/schemas/chat.schema.js");
      const chats = createChatsStorage(app.db);
      const chat = await chats.create(
        createChatSchema.parse({
          name: "ToAPIs offline acceptance",
          mode: "roleplay",
        }),
      );
      await chats.updateMetadata(chat!.id, { sceneVideoConnectionId: videoId, illustratorImageConnectionId: imageId });
      let imageRow: { id: string; url: string };
      await check("real Gallery image generation and file download", async () => {
        const response = await galleryApp.inject({
          method: "POST",
          url: `/api/gallery/${chat!.id}/generate-image`,
          payload: { prompt: "library", promptOverride: "library" },
        });
        assert.equal(response.statusCode, 200, response.body);
        imageRow = response.json();
        assert.ok(imageRow.id && imageRow.url, response.body);
        const file = await galleryApp.inject(imageRow.url);
        assert.equal(file.statusCode, 200, file.body);
        assert.deepEqual(file.rawPayload, Buffer.from(png, "base64"));
      });
      await check("real Gallery first-frame video generation", async () => {
        const response = await galleryApp.inject({
          method: "POST",
          url: "/api/gallery/generate-scene-video",
          payload: {
            chatId: chat!.id,
            galleryImageId: imageRow!.id,
            promptOverride: "gentle motion",
            durationSeconds: 4,
            aspectRatio: "16:9",
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(submissions().length, 1);
        assert.ok((submissions()[0]!.body as Record<string, unknown>).image_with_roles);
        const list = await galleryApp.inject(`/api/gallery/scene-videos/${chat!.id}`);
        assert.equal(list.statusCode, 200, list.body);
        assert.ok(list.body.includes("seedance-2-mini"), list.body);
      });
    } finally {
      await galleryApp.close();
    }
  } finally {
    await app.close();
    await closeDB();
  }
} finally {
  globalThis.fetch = originalFetch;
  dns.lookup = originalLookup;
}
process.stdout.write(`${passed} offline integration checks passed; 0 live tasks.\n`);
