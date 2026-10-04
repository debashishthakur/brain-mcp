// Smoke test: drive the server over stdio like a real MCP client would. Restores the vault afterwards.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../dist/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = loadConfig();
const memPath = path.join(cfg.vaultDir, cfg.memoryFile);
const memBefore = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : null;
const capturesBefore = new Set(fs.existsSync(path.join(cfg.vaultDir, cfg.captureDir)) ? fs.readdirSync(path.join(cfg.vaultDir, cfg.captureDir)) : []);
const transport = new StdioClientTransport({ command: "node", args: [path.join(ROOT, "dist", "index.js"), "--stdio"], stderr: "pipe" });
transport.stderr?.on("data", (d) => process.stderr.write("[server] " + d));
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const show = (label, res, max = 1400) => {
  const t = res.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(res);
  console.log(`\n===== ${label} (${t.length} chars${res.isError ? ", ERROR" : ""}) =====\n${t.slice(0, max)}${t.length > max ? "\n[...]" : ""}`);
};

const init = client.getServerCapabilities();
console.log("capabilities:", JSON.stringify(init));
console.log("instructions:", (client.getInstructions() ?? "").slice(0, 200), "...");
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const prompts = await client.listPrompts();
console.log("prompts:", prompts.prompts.map((p) => p.name).join(", "));
const res = await client.listResourceTemplates();
console.log("resource templates:", res.resourceTemplates.map((r) => r.uriTemplate).join(", "));

show("identity", await client.callTool({ name: "brain_identity", arguments: {} }), 2500);
show("identity topic", await client.callTool({ name: "brain_identity", arguments: { topic: "database backups and restores" } }), 1200);
show("context", await client.callTool({ name: "brain_context", arguments: { question: "why did the ledger move from sqlite to postgres" } }), 1800);
show("search", await client.callTool({ name: "brain_search", arguments: { query: "restic backup restore", limit: 5 } }));
show("search filtered", await client.callTool({ name: "brain_search", arguments: { query: "threshold", project: "Kestrel", limit: 5 } }));
show("read", await client.callTool({ name: "brain_read", arguments: { note: "About Ines" } }), 900);
show("read section", await client.callTool({ name: "brain_read", arguments: { note: "Restore the ledger database", section: "Steps" } }), 600);
show("project list", await client.callTool({ name: "brain_project", arguments: {} }), 800);
show("project", await client.callTool({ name: "brain_project", arguments: { project: "Harbor Ledger" } }), 1600);
show("graph concept", await client.callTool({ name: "brain_graph", arguments: { note: "PostgreSQL", limit: 8 } }), 1400);
show("recent", await client.callTool({ name: "brain_recent", arguments: { days: 365, limit: 8 } }), 1000);
show("missing", await client.callTool({ name: "brain_read", arguments: { note: "does not exist" } }));

show("remember", await client.callTool({ name: "brain_remember", arguments: { fact: "Smoke-test fact: the smoke test exercised brain_remember against the example vault.", category: "project", why: "Proves the write path works end to end.", how_to_apply: "Ignore; the smoke test removes this block when it finishes." } }));
show("capture", await client.callTool({ name: "brain_capture", arguments: { title: "Smoke test capture", body: "This note was written by the smoke test. It links [[Raspberry Pi]] and belongs to [[Kestrel]].", kind: "log", project: "Kestrel", topics: ["Raspberry Pi"] } }));
show("read captured memory", await client.callTool({ name: "brain_read", arguments: { note: "Captures/Memory.md" } }), 800);
show("search captured", await client.callTool({ name: "brain_search", arguments: { query: "smoke test", limit: 5 } }));

const r = await client.readResource({ uri: "brain://note/Hubs/Kestrel.md" });
console.log("\n===== resource brain://note/Hubs/Kestrel.md =====\n" + r.contents[0].text.slice(0, 300));
const pr = await client.getPrompt({ name: "assume_persona", arguments: {} });
console.log("\n===== prompt assume_persona: " + pr.messages[0].content.text.length + " chars");

await client.close();
// Restore the vault: drop notes the smoke test captured, put Memory.md back exactly.
for (const f of fs.readdirSync(path.join(cfg.vaultDir, cfg.captureDir))) {
  if (!capturesBefore.has(f) && f !== path.basename(cfg.memoryFile)) fs.rmSync(path.join(cfg.vaultDir, cfg.captureDir, f));
}
if (memBefore === null) fs.rmSync(memPath, { force: true });
else fs.writeFileSync(memPath, memBefore, "utf8");
console.log("\nvault restored");
