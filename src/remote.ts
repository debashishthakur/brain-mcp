import express from "express";
import type http from "node:http";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "./config.js";
import { AuthStore } from "./auth/store.js";
import { BrainOAuthProvider } from "./auth/provider.js";
import { createLoginRouter } from "./auth/login.js";
import { createSessionHandler } from "./sessions.js";
import { ALL_SCOPES } from "./policy.js";

/**
 * Public-facing transport: OAuth 2.1 authorization server + protected MCP endpoint.
 * Meant to sit behind Cloudflare Tunnel (or any TLS-terminating proxy) on loopback.
 */
export function startRemote(cfg: ResolvedConfig, makeServer: () => McpServer, store: AuthStore): http.Server {
  if (!cfg.auth.publicUrl) throw new Error("auth.publicUrl must be set for oauth mode");
  const issuer = new URL(cfg.auth.publicUrl);
  const mcpUrl = new URL(cfg.http.path, issuer);
  const provider = new BrainOAuthProvider(store, cfg);
  const sessions = createSessionHandler(makeServer);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // cloudflared connects from 127.0.0.1 and forwards the visitor IP

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, sessions: sessions.count(), auth: "oauth", configured: !!store.getSetting("password_hash") });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: mcpUrl,
      resourceName: "second-brain",
      scopesSupported: [...ALL_SCOPES],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.use(createLoginRouter(cfg, store, provider));

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.all(cfg.http.path, bearer, express.json({ limit: "4mb" }), async (req, res) => {
    try {
      await sessions.handle(req, res, req.auth!, req.method === "POST" ? req.body : undefined);
    } catch (e) {
      console.error(`[mcp] ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: "internal" });
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  const server = app.listen(cfg.http.port, cfg.http.host, () => {
    console.error(`[remote] second-brain MCP (oauth) listening on http://${cfg.http.host}:${cfg.http.port}${cfg.http.path}`);
    console.error(`[remote] public URL ${mcpUrl.href}; login configured: ${!!store.getSetting("password_hash")}`);
  });
  setInterval(() => store.purgeExpired(), 3600_000).unref();
  return server;
}
