// The owner-only access status: anonymous remote and proxied callers learn nothing, the
// owner gets configuration facts without secret values, and the "who gets in without a
// password" list follows the same policy the hooks enforce.
import assert from "node:assert/strict";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { accessStatusRoutes } from "../../packages/server/src/routes/access-status.routes.js";

const ENV_KEYS = [
  "ADMIN_SECRET",
  "ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK",
  "ALLOW_UNAUTHENTICATED_REMOTE",
  "BASIC_AUTH_PASS",
  "BASIC_AUTH_USER",
  "BYPASS_AUTH_DOCKER",
  "BYPASS_AUTH_TAILSCALE",
  "HOST",
  "IP_ALLOWLIST",
  "MARINARA_DOCKER",
  "MARINARA_DOCKER_GROUP",
  "MARINARA_DOCKER_USER",
  "MARINARA_REQUIRE_ADMIN_SECRET_ON_LOOPBACK",
  "REQUIRE_AUTH_FOR_LOOPBACK_PROXY",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const SECRETS = { BASIC_AUTH_PASS: "pass-value-must-not-leak", ADMIN_SECRET: "admin-value-must-not-leak" };

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

const app = Fastify();
await app.register(accessStatusRoutes, { prefix: "/api/access" });

const status = (remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url: "/api/access/status",
    remoteAddress,
    headers: { host: "127.0.0.1:7860", ...headers },
  });

try {
  // Owner on loopback: facts only, never the values behind them.
  setEnv({ BASIC_AUTH_USER: "owner", ...SECRETS, HOST: "0.0.0.0", IP_ALLOWLIST: "192.168.1.0/24" });
  const owner = await status("127.0.0.1");
  assert.equal(owner.statusCode, 200);
  assert.deepEqual(owner.json(), {
    loopbackOnly: false,
    host: "0.0.0.0",
    basicAuth: true,
    adminSecret: true,
    allowlist: true,
    passwordlessPeers: [],
    viaProxy: false,
  });
  for (const secret of Object.values(SECRETS)) assert.ok(!owner.body.includes(secret), "status must not leak secrets");

  // Anonymous remote, proxied, and remote-with-password-but-no-admin-secret callers are refused.
  assert.equal((await status("203.0.113.5")).statusCode, 403);
  assert.equal((await status("127.0.0.1", { "x-forwarded-for": "203.0.113.5" })).statusCode, 403);
  const basic = `Basic ${Buffer.from(`owner:${SECRETS.BASIC_AUTH_PASS}`).toString("base64")}`;
  const refused = await status("192.168.1.20", { authorization: basic });
  assert.equal(refused.statusCode, 403);
  assert.ok(!refused.body.includes("passwordlessPeers"), "refused callers learn nothing about the posture");

  // An open install: a remote visitor without the admin secret still learns nothing.
  setEnv({ ALLOW_UNAUTHENTICATED_REMOTE: "true", ADMIN_SECRET: SECRETS.ADMIN_SECRET });
  assert.equal((await status("203.0.113.5")).statusCode, 403);
  // The owner reaching it through a proxy with the admin secret sees the open doors and the proxy.
  const proxied = await status("127.0.0.1", {
    "x-forwarded-for": "203.0.113.5",
    "x-admin-secret": SECRETS.ADMIN_SECRET,
  });
  assert.equal(proxied.statusCode, 200);
  assert.deepEqual(proxied.json().passwordlessPeers, ["internet", "privateNetwork", "tailscale", "docker", "proxy"]);
  assert.equal(proxied.json().viaProxy, true);
  assert.equal(proxied.json().loopbackOnly, true);

  // The list follows the enforced policy for each kind of visitor.
  const peers = async (env: Parameters<typeof setEnv>[0]) => {
    setEnv(env);
    return (await status("127.0.0.1")).json().passwordlessPeers;
  };
  assert.deepEqual(await peers({}), []);
  assert.deepEqual(await peers({ ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK: "true" }), [
    "privateNetwork",
    "tailscale",
    "docker",
  ]);
  assert.deepEqual(await peers({ BYPASS_AUTH_TAILSCALE: "true" }), ["tailscale"]);
  assert.deepEqual(await peers({ BYPASS_AUTH_DOCKER: "true" }), ["docker"]);
  assert.deepEqual(await peers({ REQUIRE_AUTH_FOR_LOOPBACK_PROXY: "false" }), ["proxy"]);
  // Docker's automatic trust stands down once a password is set.
  assert.deepEqual(await peers({ MARINARA_DOCKER: "true" }), ["docker"]);
  assert.deepEqual(await peers({ MARINARA_DOCKER: "true", BASIC_AUTH_USER: "owner", ...SECRETS }), []);
  // A password wins over the unauthenticated opt-ins; an allowlist keeps everyone else out.
  assert.deepEqual(await peers({ ALLOW_UNAUTHENTICATED_REMOTE: "true", BASIC_AUTH_USER: "owner", ...SECRETS }), []);
  assert.deepEqual(await peers({ ALLOW_UNAUTHENTICATED_REMOTE: "true", IP_ALLOWLIST: "192.168.1.0/24" }), []);
} finally {
  await app.close();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

console.log("access-status regression passed");
