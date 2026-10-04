import http from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Streamable HTTP session registry shared by the token transport and the OAuth transport.
 * Each session is bound to the client id that opened it; a token for another client cannot resume it.
 */
export function createSessionHandler(makeServer: () => McpServer) {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; clientId: string }>();

  async function handle(req: http.IncomingMessage & { auth?: AuthInfo }, res: http.ServerResponse, auth: AuthInfo, parsedBody: unknown): Promise<void> {
    req.auth = auth;
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      if (s.clientId !== auth.clientId) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "session belongs to another client" }));
        return;
      }
      await s.transport.handleRequest(req, res, parsedBody);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "missing mcp-session-id" }));
      return;
    }
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, clientId: auth.clientId });
        console.error(`[mcp] session ${id} opened for ${auth.clientId}${auth.extra?.clientName ? ` (${String(auth.extra.clientName)})` : ""}`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        console.error(`[mcp] session ${transport.sessionId} closed`);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  return { handle, count: () => sessions.size };
}
