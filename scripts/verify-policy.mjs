// Verifies that notes a connection may not read stay out of its results: hybrid ranking drops them before fusion and
// they never crowd readable notes out of a list, brain_search / brain_context never return them (with the link graph
// on too), spelling corrections never come from their words, and brain_read's links line and the move/delete
// warnings never name them. Throwaway
// vault in the OS temp folder; the models stay in the repository's data/models, so nothing is downloaded again.
// Run after `npm run build`.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-policy-"));
const vault = path.join(ROOT, "vault");
const put = (rel, s) => (fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }), fs.writeFileSync(path.join(vault, rel), s));
put("Notes/Lighthouse.md", "---\ntitle: \"Lighthouse\"\ntype: note\n---\n# Lighthouse\n\nThe lighthouse restoration is planned for spring. The budget is in [[Lighthouse budget]].\n");
put("Private/Lighthouse budget.md", "---\ntitle: \"Lighthouse budget\"\ntype: note\n---\n# Lighthouse budget\n\nThe lighthouse restoration budget is 4,000 euros, paid from the harbour fund.\n");
put("Notes/Harbour.md", "---\ntitle: \"Harbour\"\ntype: note\n---\n# Harbour\n\nThe harbour fund pays for the quay repairs every autumn.\n");
// Links into a writable note from private notes: a path link breaks on a move, both break on a delete.
put("Notes/Plan.md", "---\ntitle: \"Plan\"\ntype: note\n---\n# Plan\n\nThe quay plan for next year.\n");
put("Private/Merger talks.md", "---\ntitle: \"Merger talks\"\ntype: note\n---\n# Merger talks\n\nThe timeline is set out in [[Notes/Plan]] for the board.\n");
put("Private/Layoff list.md", "---\ntitle: \"Layoff list\"\ntype: note\n---\n# Layoff list\n\nThe order follows [[Plan]] as agreed in March.\n");
// One readable note against many private ones on the same words; a word only private notes use.
put("Notes/Bedroom gadgets.md", "---\ntitle: \"Bedroom gadgets\"\ntype: note\n---\n# Bedroom gadgets\n\nThe small tracker on the nightstand measures sleep and logs it to the phone.\n");
for (let i = 1; i <= 60; i++) put(`Private/Journal/Day ${String(i).padStart(2, "0")}.md`, `---\ntitle: "Day ${i}"\ntype: note\n---\n# Day ${i}\n\nSlept badly again; the sleep tracker said 4 hours of sleep.\n`);
put("Private/Falconridge.md", "---\ntitle: \"Falconridge\"\ntype: note\n---\n# Falconridge\n\nThe Falconridge deal closes in May.\n");
put("Private/Falconridge terms.md", "---\ntitle: \"Falconridge terms\"\ntype: note\n---\n# Falconridge terms\n\nFalconridge pays in two parts.\n");
const base = JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8"));
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify({ ...base, vaultPath: "vault", dataDir: "data", privatePaths: ["Private/**"] }));
process.env.BRAIN_MCP_LOG_DIR = path.join(ROOT, "logs");

const cfg = loadConfig(path.join(ROOT, "config.json"));
const index = new VaultIndex(cfg);
index.fullReindex();
if (index.dense) await index.dense.embedMissing();
const policy = new Policy(cfg);
const audit = new Audit(cfg.logDir);
const fullP = fullPrincipal("stdio", "verify");
const readOnlyP = { clientId: "ro", scopes: new Set(["brain:read"]), transport: "http" };
const writerP = { clientId: "rw", scopes: new Set(["brain:read", "brain:write"]), transport: "http" };

async function connect(principal) {
  const server = createBrainServer({ cfg, index, policy, audit, defaultPrincipal: principal });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "verify-policy", version: "0.0.1" });
  await client.connect(b);
  return client;
}
const full = await connect(fullP);
const readOnly = await connect(readOnlyP);
const writer = await connect(writerP);

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failed++;
};
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, t: r.content.map((c) => c.text ?? "").join("\n") };
};

const mode = index.dense && (await index.dense.ready()) ? "hybrid" : "lexical";
console.log(`ranking mode: ${mode}`);

// ---- ranking: an unreadable note never enters the fused list
const q = "lighthouse restoration budget";
const asRead = await index.rankSections(q, { k: 20, readable: (n) => policy.canRead(n, readOnlyP) });
check("ranking drops notes the caller cannot read", !asRead.sections.some((s) => s.note_id.startsWith("Private/")), asRead.sections.map((s) => s.note_id).join(", "));
const asFull = await index.rankSections(q, { k: 20, readable: (n) => policy.canRead(n, fullP) });
check("ranking keeps them for a caller with private scope", asFull.sections.some((s) => s.note_id.startsWith("Private/")), asFull.sections.map((s) => s.note_id).join(", "));

// ---- tools
let r = await call(readOnly, "brain_search", { query: q });
check("brain_search hides private notes", !r.t.includes("Private/") && !r.t.includes("4,000"), r.t);
r = await call(readOnly, "brain_context", { question: "How much is the lighthouse restoration budget?" });
check("brain_context hides private notes", !r.t.includes("Private/") && !r.t.includes("4,000"), r.t.slice(0, 400));
r = await call(readOnly, "brain_read", { note: "Notes/Lighthouse.md" });
check("brain_read's links line does not name a private note", !/^links:.*Lighthouse budget/m.test(r.t), r.t.split("\n").slice(0, 3).join(" | "));
r = await call(full, "brain_read", { note: "Notes/Lighthouse.md" });
check("brain_read's links line names it for a caller with private scope", /^links:.*Lighthouse budget/m.test(r.t), r.t.split("\n").slice(0, 3).join(" | "));
r = await call(readOnly, "brain_read", { note: "Private/Lighthouse budget.md" });
check("brain_read refuses the private note itself", r.err, r.t);

// ---- many private matches do not push the readable note out of the lists
// Keyword-only ranking shows it plainly: with the private notes taking every place, nothing would be left.
const dense = index.dense;
index.dense = null;
const crowd = await index.rankSections("sleep tracker", { k: 10, readable: (n) => policy.canRead(n, readOnlyP) });
index.dense = dense;
check(
  "60 stronger private matches do not push the readable note out of the keyword lists",
  crowd.sections.some((x) => x.note_id === "Notes/Bedroom gadgets.md") && !crowd.sections.some((x) => x.note_id.startsWith("Private/")),
  JSON.stringify(crowd.sections.map((x) => x.note_id)),
);
r = await call(readOnly, "brain_search", { query: "sleep tracker" });
check("brain_search finds the readable note among them", r.t.includes("Bedroom gadgets") && !r.t.includes("Private/") && !/Coverage: none/.test(r.t), r.t.slice(0, 300));

// ---- spelling corrections come only from words the caller may read
r = await call(full, "brain_search", { query: "falconridgr deal" });
const corrected = /spelling read as falconridgr/.test(r.t);
check("(control) a caller with private scope gets the correction", corrected, r.t.slice(0, 200));
r = await call(readOnly, "brain_search", { query: "falconridgr deal" });
check("a word only private notes use is never offered as a correction", !/falconridg/i.test(r.t.replace(/falconridgr/gi, "")), r.t.slice(0, 200));

// ---- move and delete warnings name only notes the caller may read
const planText = fs.readFileSync(path.join(vault, "Notes/Plan.md"), "utf8");
r = await call(full, "brain_delete", { note: "Notes/Plan.md" });
check("(control) a caller with private scope is told which notes' links broke", /Private\/Layoff list\.md/.test(r.t), r.t);
put("Notes/Plan.md", planText);
index.upsertFile(path.join(vault, "Notes/Plan.md"));
r = await call(writer, "brain_move", { note: "Notes/Plan.md", to: "Notes/Archive/Plan.md" });
check("brain_move's warning does not name private notes", !r.err && !r.t.includes("Private/"), r.t);
await call(writer, "brain_move", { note: "Notes/Archive/Plan.md", to: "Notes/Plan.md" });
r = await call(writer, "brain_delete", { note: "Notes/Plan.md" });
check("brain_delete's warning does not name private notes", !r.err && !r.t.includes("Private/"), r.t);

// ---- the same with the link graph on, linked sections forced in and partners kept on the weakest link
cfg.retrieval.graph = { ...cfg.retrieval.graph, enabled: true, slots: 10, swapWeight: 100, keepLinked: 1, keepMinWeight: 0.01 };
const gq = await index.rankSections(q, { k: 20, debug: true, readable: (n) => policy.canRead(n, readOnlyP) });
check("with the graph on, ranking never shows a private note anywhere", !JSON.stringify([gq.sections.map((x) => [x.note_id, x.why]), gq.debug?.pool, gq.debug?.graph]).includes("Private/"), JSON.stringify(gq.debug?.graph?.candidates ?? []).slice(0, 300));
r = await call(readOnly, "brain_search", { query: q });
check("with the graph on, brain_search hides private notes", !r.t.includes("Private/") && !r.t.includes("4,000"), r.t.slice(0, 300));
r = await call(readOnly, "brain_context", { question: "How much is the lighthouse restoration budget?" });
check("with the graph on, brain_context hides private notes", !r.t.includes("Private/") && !r.t.includes("4,000"), r.t.slice(0, 300));
const gFull = await index.rankSections(q, { k: 20, readable: (n) => policy.canRead(n, fullP) });
check("with the graph on, a caller with private scope still sees the private note", gFull.sections.some((x) => x.note_id.startsWith("Private/")), gFull.sections.map((x) => x.note_id).join(", "));

await full.close();
await readOnly.close();
await writer.close();
await index.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall policy checks passed");
process.exit(failed ? 1 : 0);
