// Voice discovery against an OpenAI-compatible speech server.
//
// The "OpenAI-compatible" source is the lane every local engine arrives
// through, and its whole catalogue comes from one call. Three things about that
// call are invisible in a type and cheap to break:
//
// - The path. vLLM Omni publishes GET /v1/audio/voices, so the request has to
//   be baseUrl + /audio/voices and nothing else. A stray /v1 or a renamed
//   segment reads as "this engine has no voices" rather than as a 404.
// - Cloned voices. vLLM Omni returns them in a separate `uploaded_voices` array
//   and its example also mirrors the names into `voices`. Reading only `voices`
//   therefore passes against that example and loses every cloned voice on a
//   build that does not mirror.
// - Provenance. When the endpoint does not answer, the response falls back to
//   OpenAI's own six names. That is correct for api.openai.com, which publishes
//   no listing, and misleading anywhere else, so `fromProvider` has to tell the
//   two apart. The editor renders a different hint from it.
//
// Drives a real socket rather than stubbing fetch: the request goes through
// safeFetch and its outbound URL policy, which is where a loopback engine would
// be refused.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ttsConfigSchema } from "../../../packages/shared/src/types/tts.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-tts-voice-discovery-"));

let provider: ReturnType<typeof createServer> | null = null;
let respond: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;
const requestedPaths: string[] = [];

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
};

try {
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = join(dataDir, "file-storage");
  process.env.MARINARA_FILE_STORAGE_DIR = join(dataDir, "file-storage");
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";
  // Deliberately NOT set: a loopback engine must be reachable without it.
  delete process.env.TTS_LOCAL_URLS_ENABLED;

  provider = createServer((req, res) => {
    requestedPaths.push(req.url ?? "");
    respond(req, res);
  });
  await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;

  const { fetchProviderVoices } = await import("../../../packages/server/src/routes/tts.routes.ts");

  const discover = () =>
    fetchProviderVoices(
      ttsConfigSchema.parse({
        source: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "",
        model: "tts-1",
        voice: "aiden",
      }),
    );

  // ── The documented vLLM Omni payload ──
  respond = (_req, res) =>
    json(res, 200, {
      voices: ["aiden", "dylan", "eric", "custom_voice_1"],
      uploaded_voices: [
        {
          name: "custom_voice_1",
          consent: "user_consent_id",
          created_at: 1738660000,
          file_size: 1024000,
          mime_type: "audio/wav",
          ref_text: "The exact transcript of the audio sample.",
          speaker_description: "warm narrator",
        },
      ],
    });

  const omni = await discover();
  assert.equal(requestedPaths.at(-1), "/v1/audio/voices", "the request is the path vLLM Omni documents");
  assert.equal(omni.fromProvider, true, "the endpoint answered, so these are its voices");
  assert.deepEqual(omni.voices, ["aiden", "dylan", "eric", "custom_voice_1"], "every published name is offered once");

  const cloned = omni.voiceOptions.find((option) => option.id === "custom_voice_1");
  assert.equal(cloned?.description, "warm narrator", "a cloned voice keeps the description that identifies it");
  assert.equal(cloned?.category, "Uploaded", "and is grouped apart from the built-in names");

  // ── A build that does not mirror uploads into `voices` ──
  // Reading `voices` alone passes the case above and silently loses these.
  respond = (_req, res) =>
    json(res, 200, {
      voices: ["aiden"],
      uploaded_voices: [{ name: "cloned_only", speaker_description: "gravelly" }],
    });

  const unmirrored = await discover();
  assert.deepEqual(unmirrored.voices, ["aiden", "cloned_only"], "a cloned voice is offered even when unmirrored");

  // ── Nothing to list ──
  // api.openai.com publishes no voice endpoint, so falling back to its six names
  // is right; saying they came from the server is not.
  respond = (_req, res) => json(res, 404, { error: "not found" });
  const missing = await discover();
  assert.equal(missing.fromProvider, false, "a 404 must not pass built-in names off as the server's");
  assert.ok(missing.voices.includes("alloy"), "the built-in names still populate the picker");

  respond = (_req, res) => json(res, 200, { voices: [] });
  const empty = await discover();
  assert.equal(empty.fromProvider, false, "and an empty listing counts as no answer");

  console.info("TTS voice discovery regression passed.");
} finally {
  await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
