// ──────────────────────────────────────────────
// Routes: owner-only access status
// ──────────────────────────────────────────────
// Tells the owner who can open this install without a password. Configuration
// facts only: a bind address or HTTPS does not prove what the network or a proxy
// lets through, so reachability stays the owner's call. Never returns secrets.

import type { FastifyInstance } from "fastify";
import { getHost, getIpAllowlist } from "../config/runtime-config.js";
import { getAccessPolicy, getPasswordlessPeers, isLoopbackIp, isProxiedRequest } from "../middleware/ip-allowlist.js";
import { requirePrivilegedAccess } from "../middleware/privileged-gate.js";

export async function accessStatusRoutes(app: FastifyInstance) {
  app.get("/status", async (request, reply) => {
    if (!requirePrivilegedAccess(request, reply, { feature: "Access status" })) return;
    const host = getHost();
    const policy = getAccessPolicy(request);
    return {
      loopbackOnly: host === "localhost" || isLoopbackIp(host),
      host,
      basicAuth: policy.basicAuthConfigured,
      adminSecret: policy.adminSecretConfigured,
      allowlist: getIpAllowlist() !== null,
      passwordlessPeers: getPasswordlessPeers(),
      viaProxy: isProxiedRequest(request),
    };
  });
}
