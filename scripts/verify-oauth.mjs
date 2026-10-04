// End-to-end OAuth 2.1 verification against a throwaway auth database.
// Drives the exact flow a remote client (claude.ai, Claude Code --transport http) performs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { totpCode } from "../dist/auth/totp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");
const PORT = 3838;
const BASE = `http://127.0.0.1:${PORT}`;
const MCP = `${BASE}/mcp`;
const PASSWORD = "correct-horse-battery-staple";
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const REDIRECT = "http://127.0.0.1:9/cb";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-oauth-"));
const env = { ...process.env, BRAIN_MCP_DATA_DIR: dataDir, BRAIN_MCP_AUTH_MODE: "oauth", BRAIN_MCP_PUBLIC_URL: BASE, BRAIN_MCP_PORT: String(PORT) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + String(detail).replace(/\s+/g, " ").slice(0, 110) : ""}`);
  if (!ok) failures++;
};
const form = (o) => new URLSearchParams(o).toString();
const post = (url, body, headers = {}) => fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: form(body) });

// ---------------------------------------------------------------- admin init
const init = spawnSync("node", [ENTRY, "auth", "init", "--password", PASSWORD, "--totp-secret", TOTP_SECRET, "--no-qr"], { cwd: ROOT, env, encoding: "utf8" });
check("auth init configures login", init.status === 0 && init.stdout.includes("Login configured"), init.stderr.trim().split("\n").pop());

// ---------------------------------------------------------------- server
const server = spawn("node", [ENTRY, "--oauth"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
const serverLog = [];
server.stderr.on("data", (d) => serverLog.push(String(d)));
await sleep(2500);

try {
  // discovery
  const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("AS metadata advertises PKCE + registration", asMeta.code_challenge_methods_supported?.includes("S256") && asMeta.registration_endpoint === `${BASE}/register`, JSON.stringify(asMeta).slice(0, 100));
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  check("protected resource metadata points at AS", prm.resource === MCP && new URL(prm.authorization_servers?.[0]).href === new URL(BASE).href, JSON.stringify(prm));

  const unauth = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  check("unauthenticated /mcp is 401 with resource_metadata hint", unauth.status === 401 && (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata"), unauth.headers.get("www-authenticate"));

  // registration
  const bad = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "evil", redirect_uris: ["http://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  check("registration rejects non-https redirect", bad.status === 400, `status ${bad.status}`);
  const regRes = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "verify-oauth", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  const reg = await regRes.json();
  check("dynamic client registration", regRes.status === 201 && !!reg.client_id, reg.client_id);
  const clientId = reg.client_id;

  // authorize → login → consent → code
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const startAuth = async () => {
    const u = new URL(`${BASE}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "brain:read brain:write", resource: MCP })) u.searchParams.set(k, v);
    const r = await fetch(u, { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    return { status: r.status, reqId: new URL(loc, BASE).searchParams.get("req") };
  };
  const a1 = await startAuth();
  check("authorize redirects to login", a1.status === 302 && !!a1.reqId, `req=${a1.reqId}`);
  const loginPage = await fetch(`${BASE}/login?req=${a1.reqId}`);
  check("login page renders", loginPage.status === 200 && (await loginPage.text()).includes("verify-oauth"));
  const wrong = await post(`${BASE}/login`, { req: a1.reqId, password: "nope-nope-nope", code: "000000" });
  check("wrong credentials rejected", wrong.status === 401 && (await wrong.text()).includes("did not match"));
  const good = await post(`${BASE}/login`, { req: a1.reqId, password: PASSWORD, code: totpCode(TOTP_SECRET) });
  const cookie = (good.headers.get("set-cookie") ?? "").split(";")[0];
  const consentHtml = await good.text();
  check("correct login shows consent with cookie", good.status === 200 && consentHtml.includes("Allow verify-oauth") && cookie.startsWith("brain_auth="), cookie.slice(0, 30));
  const noCookie = await post(`${BASE}/consent`, { req: a1.reqId, decision: "allow", scope: "brain:read" });
  check("consent without session cookie refused", noCookie.status === 400);
  const consent = await fetch(`${BASE}/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: "req=" + a1.reqId + "&decision=allow&scope=brain:read&scope=brain:write" });
  const cbUrl = new URL(consent.headers.get("location") ?? "http://x/");
  const code = cbUrl.searchParams.get("code");
  check("consent redirects with code and state", consent.status === 302 && cbUrl.origin + cbUrl.pathname === REDIRECT && !!code && cbUrl.searchParams.get("state") === "xyz", cbUrl.href.slice(0, 80));

  // token exchange
  const badVerifier = await post(`${BASE}/token`, { grant_type: "authorization_code", code, code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier", redirect_uri: REDIRECT, client_id: clientId, resource: MCP });
  check("wrong PKCE verifier rejected", badVerifier.status === 400, (await badVerifier.json()).error);
  const tokRes = await post(`${BASE}/token`, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId, resource: MCP });
  const tok = await tokRes.json();
  check("code exchanged for tokens", tokRes.status === 200 && tok.access_token?.startsWith("bmcp_at_") && tok.refresh_token?.startsWith("bmcp_rt_") && tok.scope === "brain:read brain:write", `expires_in=${tok.expires_in}`);
  const replay = await post(`${BASE}/token`, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId });
  check("authorization code cannot be replayed", replay.status === 400);

  // use the MCP endpoint with the access token
  const connect = async (token) => {
    const t = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const c = new Client({ name: "verify-oauth", version: "0.0.1" });
    await c.connect(t);
    return c;
  };
  const client = await connect(tok.access_token);
  const tools = await client.listTools();
  check("MCP session over OAuth token lists tools", tools.tools.length === 13, tools.tools.map((t) => t.name).join(","));
  const priv = await client.callTool({ name: "brain_read", arguments: { note: "Offer negotiation notes" } });
  check("private note hidden without brain:private scope", priv.isError === true, priv.content[0].text.slice(0, 60));
  const pub = await client.callTool({ name: "brain_read", arguments: { note: "About Ines" } });
  check("public note readable with brain:read", !pub.isError && pub.content[0].text.includes("Tidewell"));
  await client.close();

  // refresh rotation, revocation, reuse detection
  const r1 = await (await post(`${BASE}/token`, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId })).json();
  check("refresh token rotates", r1.access_token && r1.refresh_token && r1.refresh_token !== tok.refresh_token);
  const rev = await post(`${BASE}/revoke`, { token: r1.access_token, client_id: clientId });
  const afterRevoke = await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${r1.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  check("revoked access token is rejected", rev.status === 200 && afterRevoke.status === 401, `revoke ${rev.status}, use ${afterRevoke.status}`);
  const r2 = await (await post(`${BASE}/token`, { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: clientId })).json();
  check("refresh still works after access revoke", !!r2.access_token);
  const reuse = await post(`${BASE}/token`, { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: clientId });
  const afterReuse = await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${r2.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  check("refresh token reuse revokes the whole grant", reuse.status === 400 && afterReuse.status === 401, `reuse ${reuse.status}, newest token ${afterReuse.status}`);

  // lockout
  const a2 = await startAuth();
  for (let i = 0; i < 5; i++) await post(`${BASE}/login`, { req: a2.reqId, password: "bad-bad-bad-bad", code: "111111" });
  const locked = await post(`${BASE}/login`, { req: a2.reqId, password: PASSWORD, code: totpCode(TOTP_SECRET) });
  check("five failures lock out even a correct login", locked.status === 429);

  // admin
  const clients = spawnSync("node", [ENTRY, "auth", "clients"], { cwd: ROOT, env, encoding: "utf8" }).stdout;
  check("auth clients lists the registered client", clients.includes(clientId) && clients.includes("verify-oauth"));
  const revoked = spawnSync("node", [ENTRY, "auth", "revoke-client", clientId], { cwd: ROOT, env, encoding: "utf8" }).stdout;
  check("auth revoke-client", revoked.includes("revoked"));
  const a3 = await startAuth();
  check("revoked client cannot start authorization", a3.status === 400, `status ${a3.status}`);
} catch (e) {
  check("unexpected error", false, e.stack ?? String(e));
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
if (failures) {
  console.log("\nserver log tail:\n" + serverLog.join("").split("\n").slice(-15).join("\n"));
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
