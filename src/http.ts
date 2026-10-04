import http from "node:http";
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ResolvedConfig } from "./config.js";
import { createSessionHandler } from "./sessions.js";

export interface TokenGrant {
  clientId: string;
  scopes: string[];
}

/**
 * Interim bearer-token transport for local or Tailscale use only. Binds to loopback by default.
 * The public deployment uses remote.ts (OAuth 2.1) instead.
 */
export function startHttp(cfg: ResolvedConfig, makeServer: () => McpServer, grants: Map<string, TokenGrant>): http.Server {
  if (!grants.size) throw new Error("refusing to start HTTP transport with no tokens configured (set BRAIN_MCP_TOKEN)");
  const sessions = createSessionHandler(makeServer);

  const authenticate = (req: http.IncomingMessage): AuthInfo | null => {
    const header = req.headers.authorization ?? "";
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    const presented = Buffer.from(m[1]);
    for (const [token, grant] of grants) {
      const expected = Buffer.from(token);
      if (expected.length === presented.length && crypto.timingSafeEqual(expected, presented)) {
        return { token, clientId: grant.clientId, scopes: grant.scopes };
      }
    }
    return null;
  };

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) reject(new Error("body too large"));
        else chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, sessions: sessions.count(), auth: "token" }));
      return;
    }
    if (url.pathname !== cfg.http.path) {
      res.writeHead(404).end();
      return;
    }
    const auth = authenticate(req);
    if (!auth) {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="second-brain"', "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await sessions.handle(req, res, auth, body);
    } catch (e) {
      console.error(`[http] ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal" }));
    }
  });

  srv.listen(cfg.http.port, cfg.http.host, () => {
    console.error(`[http] second-brain MCP (token) listening on http://${cfg.http.host}:${cfg.http.port}${cfg.http.path}`);
  });
  return srv;
}

export function grantsFromEnv(): Map<string, TokenGrant> {
  const grants = new Map<string, TokenGrant>();
  const full = process.env.BRAIN_MCP_TOKEN?.trim();
  const ro = process.env.BRAIN_MCP_TOKEN_RO?.trim();
  if (full && full.length >= 32) grants.set(full, { clientId: "local-full", scopes: ["brain:read", "brain:write", "brain:private"] });
  if (ro && ro.length >= 32) grants.set(ro, { clientId: "local-readonly", scopes: ["brain:read"] });
  return grants;
}
