import assert from 'node:assert/strict';
import { regressionTimeoutMs } from '../run-regressions.mjs';

assert.equal(regressionTimeoutMs('scripts/regressions/server-signal-shutdown.regression.ts'), 270_000);
assert.equal(regressionTimeoutMs('scripts/regressions/restart-supervisor.regression.ts'), 90_000);
assert.equal(regressionTimeoutMs('scripts/regressions/prompt.regression.ts'), 30_000);

console.log('Scoped regression timeout selection passed.');
