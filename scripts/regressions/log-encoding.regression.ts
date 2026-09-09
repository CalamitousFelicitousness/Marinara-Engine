import assert from "node:assert/strict";
import { createLogDestination } from "../../packages/server/src/lib/logger.js";

// A pino destination built on file descriptor 1 reaches a Windows console
// through WriteFile, which decodes the bytes with the console's OEM code page
// and turns non-ASCII into mojibake. Routing through process.stdout uses
// WriteConsoleW instead. Both the singleton in lib/logger.ts and the Fastify
// logger in app.ts depend on that, and upstream edits both files, so this pins
// the wiring against a merge restoring the `transport` option.

const SAMPLE = "Uczyń opcje znacząco zróżnicowanymi: odważnymi, ostrożnymi, wrażliwymi.";

async function captureStdout(run: () => void): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = "";

  process.stdout.write = ((chunk: unknown) => {
    captured += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    run();
    // pino-pretty formats on a Transform, so the line lands a few ticks later.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    process.stdout.write = originalWrite;
  }

  return captured;
}

const originalNodeEnv = process.env.NODE_ENV;

try {
  process.env.NODE_ENV = "development";
  const pretty = createLogDestination();
  const devOutput = await captureStdout(() => {
    pretty.write(`${JSON.stringify({ level: 30, time: Date.now(), msg: SAMPLE })}\n`);
  });

  assert.ok(
    devOutput.includes(SAMPLE),
    `pretty log did not reach process.stdout intact. Received: ${JSON.stringify(devOutput)}`,
  );

  process.env.NODE_ENV = "production";
  assert.equal(
    createLogDestination(),
    process.stdout,
    "production logging must write through process.stdout, not a file descriptor",
  );
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}

console.log("log-encoding regression passed.");
