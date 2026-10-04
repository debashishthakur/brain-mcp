// Verifies brain_write / brain_edit / brain_move / brain_delete against a throwaway vault in the OS temp
// folder (the real vault is never touched): path guards, overwrite rules, hub grouping, fence-aware section
// edits, CRLF preservation, trash-not-erase, and refusal for a read-only connection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
import { Policy } from "../dist/policy.js";
import { Audit } from "../dist/audit.js";
import { createBrainServer, fullPrincipal } from "../dist/tools.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-write-"));
const vault = path.join(ROOT, "vault");
const put = (rel, s) => (fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }), fs.writeFileSync(path.join(vault, rel), s));
put("Projects/Gen/Notes/Generated.md", "---\ntitle: \"Generated\"\ntype: note\n---\n# Generated\n\nPipeline output.\n");
put("Captures/Memory.md", "---\ntitle: \"Memory\"\ntype: note\n---\n# Memory\n");
put("Captures/2026-01-01 Draft.md", "---\ntitle: \"Draft\"\ntype: note\nproject: \"[[TestHub]]\"\n---\n# Draft\n\nLinks to [[Target]].\n");
put("Notes/Target.md", "---\ntitle: \"Target\"\ntype: guide\nmodified: 2026-01-01\n---\n# Target\n\n## Setup\n\n```bash\n# not a heading\necho hi\n```\n\n### Detail\n\nold detail\n\n## Next\n\nkeep me\n");
put("Notes/Crlf.md", "---\r\ntitle: \"Crlf\"\r\ntype: note\r\n---\r\n# Crlf\r\n\r\nalpha beta\r\n");
const base = JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8"));
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify({ ...base, vaultPath: "vault" }));
process.env.BRAIN_MCP_DATA_DIR = path.join(ROOT, "data");
process.env.BRAIN_MCP_LOG_DIR = path.join(ROOT, "logs");

const cfg = loadConfig(path.join(ROOT, "config.json"));
const index = new VaultIndex(cfg);
index.fullReindex();
const policy = new Policy(cfg);
const audit = new Audit(cfg.logDir);

async function connect(principal) {
  const server = createBrainServer({ cfg, index, policy, audit, defaultPrincipal: principal });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "verify-write", version: "0.0.1" });
  await client.connect(b);
  return client;
}
const full = await connect(fullPrincipal("stdio", "verify"));
const readOnly = await connect({ clientId: "ro", scopes: new Set(["brain:read"]), transport: "http" });

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failed++;
};
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, t: r.content.map((c) => c.text ?? "").join("\n") };
};
const read = (rel) => fs.readFileSync(path.join(vault, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(vault, rel));

// ---- brain_write
let r = await call(full, "brain_write", { path: "Notes/TestHub.md", title: "TestHub", type: "hub", body: "Hub body.", summary: "A test hub", order: 1 });
check("write creates a hub in Notes/", !r.err && exists("Notes/TestHub.md") && /type: hub/.test(read("Notes/TestHub.md")) && /order: 1/.test(read("Notes/TestHub.md")), r.t);
r = await call(full, "brain_project", { project: "TestHub" });
check("brain_project groups notes under the new hub", !r.err && r.t.includes("Draft"), r.t);
r = await call(full, "brain_write", { path: "Notes/TestHub.md", title: "TestHub", type: "hub", body: "x" });
check("write refuses to overwrite without overwrite=true", r.err && /already exists/.test(r.t), r.t);
const capturedBefore = /captured: (.*)/.exec(read("Notes/TestHub.md"))[1];
r = await call(full, "brain_write", { path: "Notes/TestHub.md", title: "TestHub", type: "hub", body: "Replaced body.", overwrite: true });
check("write replaces with overwrite=true and keeps captured", !r.err && read("Notes/TestHub.md").includes("Replaced body.") && read("Notes/TestHub.md").includes(`captured: ${capturedBefore}`), r.t);
for (const [label, p] of [
  ["a generated folder", "Projects/Gen/Notes/New.md"],
  ["outside the vault", "../escape.md"],
  ["the memory file", "Captures/Memory.md"],
  ["a hidden folder", "Notes/.hidden/x.md"],
  ["a non-markdown file", "Notes/x.txt"],
]) {
  r = await call(full, "brain_write", { path: p, title: "X", body: "y", overwrite: true });
  check(`write refuses ${label}`, r.err, r.t);
}
check("nothing escaped the vault", !fs.existsSync(path.join(ROOT, "escape.md")));

// ---- brain_edit
r = await call(full, "brain_edit", { note: "Target", section: "Setup", content: "new setup text" });
let t = read("Notes/Target.md");
check("edit replaces a section and its subsections, fence-aware", !r.err && t.includes("## Setup\n\nnew setup text\n\n## Next") && !t.includes("old detail") && !t.includes("not a heading"), r.t + "\n" + t);
check("edit bumps modified", !/modified: 2026-01-01/.test(t));
r = await call(full, "brain_edit", { note: "Target", old_text: "keep me", new_text: "kept" });
check("edit replaces unique old_text", !r.err && read("Notes/Target.md").includes("kept"), r.t);
await call(full, "brain_edit", { note: "Target", append: "dup\n\ndup" });
r = await call(full, "brain_edit", { note: "Target", old_text: "dup", new_text: "x" });
check("edit refuses ambiguous old_text", r.err && /occurs 2 times/.test(r.t), r.t);
r = await call(full, "brain_edit", { note: "Target", old_text: "absent", new_text: "x" });
check("edit refuses missing old_text", r.err && /not found/.test(r.t), r.t);
r = await call(full, "brain_edit", { note: "Target", section: "Nope", content: "x" });
check("edit refuses an unknown section", r.err && /No section/.test(r.t), r.t);
r = await call(full, "brain_edit", { note: "Target", old_text: "kept", new_text: "x", append: "y" });
check("edit refuses two modes at once", r.err && /exactly one/.test(r.t), r.t);
r = await call(full, "brain_edit", { note: "Generated", append: "x" });
check("edit refuses a generated note", r.err && /regenerated/.test(r.t), r.t);
r = await call(full, "brain_edit", { note: "Crlf", old_text: "alpha", new_text: "gamma" });
t = read("Notes/Crlf.md");
check("edit keeps CRLF line endings", !r.err && t.includes("gamma beta\r\n") && !/[^\r]\n/.test(t), JSON.stringify(t));

// ---- brain_move
r = await call(full, "brain_move", { note: "Captures/2026-01-01 Draft.md", to: "Notes/Draft.md" });
check("move promotes a capture into Notes/", !r.err && exists("Notes/Draft.md") && !exists("Captures/2026-01-01 Draft.md"), r.t);
r = await call(full, "brain_read", { note: "Captures/2026-01-01 Draft.md" });
check("move drops the old path from the index", r.err || /not found/i.test(r.t), r.t);
r = await call(full, "brain_move", { note: "Draft", to: "Notes/Target.md" });
check("move refuses to overwrite", r.err && /already exists/.test(r.t), r.t);
r = await call(full, "brain_move", { note: "Target", to: "Notes/Renamed.md" });
check("move that keeps the title raises no false broken-link warning", !r.err && !/resolve to nothing/.test(r.t), r.t);
r = await call(full, "brain_move", { note: "Renamed", to: "Projects/Gen/Notes/Renamed.md" });
check("move refuses a generated destination", r.err, r.t);

// ---- brain_delete
r = await call(full, "brain_delete", { note: "Notes/Renamed.md" });
const trashed = exists(".trash") ? fs.readdirSync(path.join(vault, ".trash")) : [];
check("delete moves the note into .trash/", !r.err && !exists("Notes/Renamed.md") && trashed.some((f) => f.endsWith(" Renamed.md")), r.t);
check("delete names the note whose link it broke", /resolve to nothing: `Notes\/Draft\.md`/.test(r.t), r.t);
r = await call(full, "brain_search", { query: "setup text" });
check("deleted notes leave the index", !r.t.includes("Renamed"), r.t);
r = await call(full, "brain_delete", { note: "Captures/Memory.md" });
check("delete refuses the memory file", r.err && /append-only/.test(r.t), r.t);
r = await call(full, "brain_delete", { note: "Generated" });
check("delete refuses a generated note", r.err && exists("Projects/Gen/Notes/Generated.md"), r.t);

// ---- read-only connection
for (const [tool, args] of [
  ["brain_write", { path: "Notes/Ro.md", title: "Ro", body: "x" }],
  ["brain_edit", { note: "Draft", append: "x" }],
  ["brain_move", { note: "Draft", to: "Notes/Ro.md" }],
  ["brain_delete", { note: "Draft" }],
]) {
  r = await call(readOnly, tool, args);
  check(`${tool} refused without write scope`, r.err && /no write scope/.test(r.t), r.t);
}
check("read-only calls changed nothing", exists("Notes/Draft.md") && !exists("Notes/Ro.md") && !read("Notes/Draft.md").trimEnd().endsWith("x"));

const audited = fs.readFileSync(path.join(cfg.logDir, "audit.jsonl"), "utf8").split("\n").filter((l) => /brain_(write|edit|move|delete)/.test(l)).length;
check("every write-tool call is in the audit log", audited >= 25, `${audited} entries`);

await full.close();
await readOnly.close();
await index.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
