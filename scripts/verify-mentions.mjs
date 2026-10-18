// Verifies the "unlinked mentions" hint that brain_capture, brain_write and brain_edit return: existing notes the new
// text names without linking, so the caller can link them in the sentence that says how they relate. Throwaway vault
// in the OS temp folder, keyword-only (no models). Run after `npm run build`.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-mentions-"));
const vault = path.join(ROOT, "vault");
const put = (rel, s) => (fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }), fs.writeFileSync(path.join(vault, rel), s));
const note = (title, body, extra = "") => `---\ntitle: "${title}"\ntype: note\n${extra}---\n# ${title}\n\n${body}\n`;
put("Notes/Home server facts.md", note("Home server facts", "The box under the stairs.", "aliases:\n  - pantry box\n"));
put("Notes/Restore the ledger database.md", note("Restore the ledger database", "Steps."));
put("Notes/Kubernetes.md", note("Kubernetes", "Cluster notes."));
put("Notes/Harbor.md", "---\ntitle: \"Harbor Ledger\"\ntype: hub\n---\n# Harbor Ledger\n\nThe hub.\n");
put("Private/Secret garden plan.md", note("Secret garden plan", "Not for everyone."));
put("Captures/Memory.md", "---\ntitle: \"Memory\"\ntype: note\n---\n# Memory\n");
for (let i = 0; i < 30; i++) put(`Notes/Filler ${i}.md`, note(`Filler ${i}`, "Ordinary words about servers and steps."));
const base = JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8"));
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify({ ...base, vaultPath: "vault", dataDir: "data", privatePaths: ["Private/**"], retrieval: { hybrid: false } }));
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
  const client = new Client({ name: "verify-mentions", version: "0.0.1" });
  await client.connect(b);
  return client;
}
const full = await connect(fullPrincipal("stdio", "verify"));
const writer = await connect({ clientId: "writer", scopes: new Set(["brain:read", "brain:write"]), transport: "http" });

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failed++;
};
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: !!r.isError, t: r.content.map((c) => c.text ?? "").join("\n") };
};
const hint = (t) => (t.split("Unlinked mentions of existing notes.")[1] ?? "").trim();

let r = await call(full, "brain_capture", { title: "Backup plan", body: "Nightly dumps go to the home server facts box, and the restore the ledger database runbook covers recovery. We might move it all to Kubernetes later." });
check("names a two-word title in any case", /\[\[Home server facts\]\]/.test(hint(r.t)), r.t);
check("names a long title", /\[\[Restore the ledger database\]\]/.test(hint(r.t)), r.t);
check("names a rare single word written with its capitals", /\[\[Kubernetes\]\]/.test(hint(r.t)), r.t);
check("quotes the sentence of the mention", /"Nightly dumps go to the home server facts box, and the restore the ledger database runbook covers recovery\."/.test(hint(r.t)), r.t);
r = await call(full, "brain_capture", { title: "Cluster idea", body: "maybe kubernetes, all lower case, is just a word here." });
check("a single word in other casing is not a mention", !hint(r.t), r.t);
r = await call(full, "brain_capture", { title: "Linked already", body: "See [[Home server facts]] first; the home server facts note has the paths." });
check("a note the text already links is not suggested", !/Home server facts/.test(hint(r.t)), r.t);
r = await call(full, "brain_capture", { title: "Alias use", body: "The pantry box runs Debian." });
check("an alias counts as the note's name", /"pantry box" → \[\[Home server facts\]\]/.test(hint(r.t)), r.t);
r = await call(full, "brain_capture", { title: "Hub talk", body: "The harbor ledger hub lists everything." });
check("hubs are not suggested", !/Harbor Ledger/.test(hint(r.t)), r.t);
r = await call(full, "brain_capture", { title: "Code only", body: "```\nhome server facts\n```\nRun `restore the ledger database` and see https://example.com/home-server-facts and [x](Home server facts).\n\n## Home server facts" });
check("code, URLs, link targets and headings are not searched", !hint(r.t), r.t);
r = await call(full, "brain_capture", { title: "Windows text", body: "```js\r\nhome server facts\r\n```python\r\nrestore the ledger database\r\n```\r\nThe next sentence names Kubernetes for the cluster.\r\n" });
check(
  "CRLF text: a fence with an info string does not close a block, and the sentence is quoted cleanly",
  /^- "Kubernetes" → \[\[Kubernetes\]\]: "The next sentence names Kubernetes for the cluster\."$/m.test(hint(r.t)) && !/Home server facts|Restore the ledger database/.test(hint(r.t)),
  r.t,
);
r = await call(full, "brain_capture", { title: "Secret mention", body: "Ask about the secret garden plan before spring." });
check("a private note is named for a connection with private scope", /Secret garden plan/.test(hint(r.t)), r.t);
r = await call(writer, "brain_capture", { title: "Secret mention two", body: "Ask about the secret garden plan before spring." });
check("but never for one without it", !/Secret garden plan/i.test(r.t.split("Saved")[1] ?? r.t) && !hint(r.t), r.t);
r = await call(full, "brain_write", { path: "Notes/Backup runbook.md", title: "Backup runbook", body: "Step one: read the backup runbook. Step two: check home server facts." });
check("brain_write names mentions but never the note itself", /Home server facts/.test(hint(r.t)) && !/Backup runbook\]\]/.test(hint(r.t)), r.t);
r = await call(full, "brain_edit", { note: "Notes/Backup runbook.md", append: "Then follow restore the ledger database." });
check("brain_edit names only what the new text mentions", /Restore the ledger database/.test(hint(r.t)) && !/Home server facts/.test(hint(r.t)), r.t);
r = await call(full, "brain_capture", { title: "Memory talk", body: "Write it to memory and to the home server facts note." });
check("the memory file is never suggested", !/\[\[Memory\]\]/.test(hint(r.t)), r.t);
put("Notes/Alpha project notes.md", note("Alpha project notes", "a"));
put("Notes/Beta project notes.md", note("Beta project notes", "b"));
index.fullReindex();
r = await call(full, "brain_capture", { title: "Many", body: "alpha project notes, beta project notes, home server facts, restore the ledger database and Kubernetes." });
check("at most three suggestions, in text order", (hint(r.t).match(/^- /gm) ?? []).length === 3 && /^- "alpha project notes"/m.test(hint(r.t)), r.t);

await full.close();
await writer.close();
await index.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall mention checks passed");
process.exit(failed ? 1 : 0);
