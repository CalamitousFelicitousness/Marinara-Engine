import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "../../packages/server/src/utils/security.js";

// #7513: a host whose resolver maps `localhost` to `::1` only, with llama.cpp on 127.0.0.1.
// `localhost` must reach a server on either loopback address, with and without PROVIDER_LOCAL_URLS_ENABLED.

async function listen(host: string): Promise<Server | null> {
  const server = createServer((_req, res) => res.end(`hello from ${host}`));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    return server;
  } catch {
    return null; // No IPv6 loopback on this machine.
  }
}

const originalLookup = dns.lookup;
(dns as { lookup: unknown }).lookup = async (hostname: string, options: unknown) =>
  hostname === "localhost" ? [{ address: "::1", family: 6 }] : originalLookup(hostname, options as never);

const policies = {
  "local URLs off": { allowLoopback: true, allowedProtocols: ["http:"] },
  "local URLs on": { allowLocal: true, allowLoopback: true, allowedProtocols: ["http:"] },
};

try {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = await listen(host);
    if (!server) {
      console.log(`skip: cannot listen on ${host}`);
      continue;
    }
    try {
      const { port } = server.address() as AddressInfo;
      for (const [name, policy] of Object.entries(policies)) {
        const response = await safeFetch(`http://localhost:${port}/`, { policy });
        assert.equal(await response.text(), `hello from ${host}`, `${name}: localhost reaches ${host}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
} finally {
  (dns as { lookup: unknown }).lookup = originalLookup;
}

console.log("localhost loopback fetch regression passed");
