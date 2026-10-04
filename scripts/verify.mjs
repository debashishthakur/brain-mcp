// Verifies: redaction patterns, the file watcher, and the HTTP transport with bearer auth.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Policy } from "../dist/policy.js";
import { loadConfig } from "../dist/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- redaction
const policy = new Policy(cfg);
// Fake credentials are assembled at runtime so secret scanners do not flag this file.
const fakeAnthropic = ["sk", "ant", "api03"].join("-") + "-" + "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
const fakeGithub = "ghp" + "_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
const fakeAws = "AKIA" + "IOSFODNN7EXAMPLE";
const samples = [
  ["anthropic key", `ANTHROPIC_API_KEY=${fakeAnthropic}`, "api03-abcdef"],
  ["github token", `token ${fakeGithub}`, "ABCDEFGHIJKLMNOP"],
  ["aws key", `aws_access_key_id = ${fakeAws}`, "IOSFODNN7EXAMPLE"],
  ["password assignment", "password: hunter2hunter2", "hunter2hunter2"],
  ["client_secret", 'client_secret="abcd1234efgh5678"', "abcd1234efgh5678"],
  ["url creds", "postgres://user:s3cretpassw0rd@db.example.com/x", "s3cretpassw0rd"],
  ["private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "MIIEvQIBADANBg"],
  ["jwt", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "SflKxwRJ"],
];
for (const [label, input, secret] of samples) {
  const r = policy.redact(input);
  check(`redact ${label}`, !r.text.includes(secret) && r.count > 0, r.text.replace(/\n/g, " ").slice(0, 80));
}
const keep = [
  ["placeholder stays", "client_secret: <your-client-secret>"],
  ["env ref stays", "api_key: ${GOOGLE_MAPS_API_KEY}"],
  ["prose stays", "The password field must be at least 12 characters."],
];
for (const [label, input] of keep) {
  const r = policy.redact(input);
  check(label, r.count === 0, r.text);
}

// ---------------------------------------------------------------- http + watcher
const token = "verify-token-" + "x".repeat(40);
const server = spawn("node", [path.join(ROOT, "dist", "index.js"), "--http"], { cwd: ROOT, env: { ...process.env, BRAIN_MCP_TOKEN: token }, stdio: ["ignore", "ignore", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
await sleep(2500);

const base = `http://${cfg.http.host}:${cfg.http.port}${cfg.http.path}`;
const unauth = await fetch(base, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }) });
check("http rejects missing token", unauth.status === 401, `status ${unauth.status}`);
const badtok = await fetch(base, { method: "POST", headers: { authorization: "Bearer nope" + "y".repeat(40), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
check("http rejects wrong token", badtok.status === 401, `status ${badtok.status}`);

const transport = new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
const client = new Client({ name: "verify", version: "0.0.1" });
await client.connect(transport);
const tools = await client.listTools();
check("http session lists tools", tools.tools.length === 13, tools.tools.map((t) => t.name).join(","));

const probe = "watcher-probe-" + Date.now();
const before = await client.callTool({ name: "brain_search", arguments: { query: probe } });
check("probe absent before write", before.content[0].text.startsWith("No notes"), "");
const probeFile = path.join(cfg.vaultDir, cfg.captureDir, `${probe}.md`);
fs.mkdirSync(path.dirname(probeFile), { recursive: true });
fs.writeFileSync(probeFile, `---\ntitle: "${probe}"\ntype: note\ntags: [captured]\n---\n# ${probe}\n\nWritten outside the MCP to test the watcher.\n`);
await sleep(1500);
const after = await client.callTool({ name: "brain_search", arguments: { query: probe } });
check("watcher indexed external write", after.content[0].text.includes(probe) && !after.content[0].text.startsWith("No notes"), after.content[0].text.split("\n")[0]);
fs.unlinkSync(probeFile);
await sleep(1500);
const gone = await client.callTool({ name: "brain_search", arguments: { query: probe } });
check("watcher removed deleted note", gone.content[0].text.startsWith("No notes"), "");

const ident = await client.callTool({ name: "brain_identity", arguments: {} });
check("identity over http", ident.content[0].text.includes("## Who they are"), `${ident.content[0].text.length} chars`);

await client.close();
server.kill();
await sleep(300);

// ---------------------------------------------------------------- audit log
const auditPath = path.join(cfg.logDir, "audit.jsonl");
const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
const last = JSON.parse(lines[lines.length - 1]);
check("audit log written", last.tool === "brain_identity" && last.client === "local-full" && last.transport === "http", JSON.stringify(last).slice(0, 140));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
