// ──────────────────────────────────────────────
// Routes: owner-only access status
// ──────────────────────────────────────────────
// Tells the owner who can open this install without a password. Configuration
// facts only: a bind address or HTTPS does not prove what the network or a proxy
// lets through, so reachability stays the owner's call. Never returns secrets.

import type { FastifyInstance } from "fastify";
import {
  clearStoredLogin,
  consumeLoginSetupCode,
  getLoginConfig,
  isLoginSetupCode,
  MIN_LOGIN_PASSWORD_LENGTH,
  setStoredLogin,
} from "../config/login-credential.js";
import { getHost, getIpAllowlist } from "../config/runtime-config.js";
import { logger } from "../lib/logger.js";
import {
  createPairingCode,
  describeSessions,
  endOtherSessions,
  endSession,
  hasBrowserSession,
  rememberLoginInBrowser,
} from "../middleware/basic-auth.js";
import {
  getAccessPolicy,
  getPasswordlessPeers,
  getTrustedAuthProxies,
  isLoopbackBind,
  isProxiedRequest,
} from "../middleware/ip-allowlist.js";
import { requirePrivilegedAccess } from "../middleware/privileged-gate.js";
import { ACCESS_LOGIN_RATE_LIMIT, RUNTIME_DIAGNOSTICS_RATE_LIMIT } from "../middleware/rate-limit.js";
import { listRefusals } from "../middleware/refused-devices.js";

const ENV_MANAGED = { error: "The login is set in .env (BASIC_AUTH_USER and BASIC_AUTH_PASS). Change it there." };

export async function accessStatusRoutes(app: FastifyInstance) {
  app.get("/status", { config: { rateLimit: RUNTIME_DIAGNOSTICS_RATE_LIMIT } }, async (request, reply) => {
    if (!requirePrivilegedAccess(request, reply, { feature: "Access status" })) return;
    const policy = getAccessPolicy(request);
    // The address the server really listens on; HOST in .env can change without a restart.
    const bound = request.server.server.address();
    const host = bound && typeof bound === "object" ? bound.address : getHost();
    return {
      loopbackOnly: isLoopbackBind(host),
      host,
      basicAuth: policy.basicAuthConfigured,
      loginSource: getLoginConfig()?.source ?? null,
      loginUser: getLoginConfig()?.user ?? null,
      adminSecret: policy.adminSecretConfigured,
      allowlist: getIpAllowlist() !== null,
      trustedAuthProxy: getTrustedAuthProxies().length > 0,
      passwordlessPeers: getPasswordlessPeers(host),
      loginKeepsOpen: getPasswordlessPeers(host, undefined, true),
      viaProxy: isProxiedRequest(request),
    };
  });

  // Sets or changes the app login. The caller is already privileged, so the old password is not asked.
  app.put<{ Body: { user?: unknown; password?: unknown; setupCode?: unknown } | undefined }>(
    "/login",
    { config: { rateLimit: ACCESS_LOGIN_RATE_LIMIT } },
    async (request, reply) => {
      const body = request.body ?? {};
      const user = typeof body.user === "string" ? body.user.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!user || user.length > 128 || user.includes(":")) {
        return reply.status(400).send({ error: "Enter a username of up to 128 characters, without a colon." });
      }
      if (password.length < MIN_LOGIN_PASSWORD_LENGTH || password.length > 1024) {
        return reply
          .status(400)
          .send({ error: `Enter a password of at least ${MIN_LOGIN_PASSWORD_LENGTH} characters.` });
      }

      const current = getLoginConfig();
      const setupCode = !current && isLoginSetupCode(body.setupCode);
      if (
        !requirePrivilegedAccess(request, reply, { feature: "Remote login", oneTimeCapabilityAuthorized: setupCode })
      ) {
        return;
      }
      if (current?.source === "env") return reply.status(409).send(ENV_MANAGED);
      if (setupCode) consumeLoginSetupCode();

      await setStoredLogin(user, password);
      logger.info('[login] Remote login %s for user "%s"', current ? "changed" : "set", user);
      rememberLoginInBrowser(request, reply);
      return { loginSource: "app" };
    },
  );

  app.delete("/login", { config: { rateLimit: ACCESS_LOGIN_RATE_LIMIT } }, async (request, reply) => {
    if (!requirePrivilegedAccess(request, reply, { feature: "Remote login" })) return;
    if (getLoginConfig()?.source === "env") return reply.status(409).send(ENV_MANAGED);
    clearStoredLogin();
    logger.info("[login] Remote login removed");
    return reply.status(204).send();
  });

  // Signed-in browsers, for the owner to review and sign out.
  app.get("/sessions", { config: { rateLimit: RUNTIME_DIAGNOSTICS_RATE_LIMIT } }, async (request, reply) => {
    if (!requirePrivilegedAccess(request, reply, { feature: "Signed-in browsers" })) return;
    return { sessions: describeSessions(request) };
  });

  app.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    { config: { rateLimit: ACCESS_LOGIN_RATE_LIMIT } },
    async (request, reply) => {
      if (!requirePrivilegedAccess(request, reply, { feature: "Signed-in browsers" })) return;
      if (!endSession(request.params.id)) return reply.status(404).send({ error: "Session not found" });
      return reply.status(204).send();
    },
  );

  // Signs out every other browser; the caller's own session stays.
  app.delete("/sessions", { config: { rateLimit: ACCESS_LOGIN_RATE_LIMIT } }, async (request, reply) => {
    if (!requirePrivilegedAccess(request, reply, { feature: "Signed-in browsers" })) return;
    endOtherSessions(request);
    logger.info("[login] Every other browser was signed out");
    return reply.status(204).send();
  });

  // "Add a device": a one-time code a new browser types on /login instead of the password.
  app.post("/pairing-codes", { config: { rateLimit: ACCESS_LOGIN_RATE_LIMIT } }, async (request, reply) => {
    if (!hasBrowserSession(request) && !requirePrivilegedAccess(request, reply, { feature: "Add a device" })) return;
    const pairing = createPairingCode(request);
    if (!pairing) return reply.status(409).send({ error: "Set a remote login first." });
    logger.info("[login] A pairing code was created for a new device");
    return pairing;
  });

  // Devices the access gates refused lately, for the banner on this computer.
  app.get("/refusals", { config: { rateLimit: RUNTIME_DIAGNOSTICS_RATE_LIMIT } }, async (request, reply) => {
    if (!requirePrivilegedAccess(request, reply, { loopbackOnly: true, feature: "Refused devices" })) return;
    // Once a login exists, "no login yet" is old news.
    const hasLogin = getLoginConfig() !== null;
    return { refusals: listRefusals().filter((device) => !hasLogin || device.reason !== "noLogin") };
  });
}
