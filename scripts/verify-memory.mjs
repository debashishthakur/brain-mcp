// Verifies brain_remember deduplication over stdio, then restores Captures/Memory.md byte-for-byte.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../dist/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = loadConfig();
const memPath = path.join(cfg.vaultDir, cfg.memoryFile);
const before = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8") : null;

const transport = new StdioClientTransport({ command: "node", args: [path.join(ROOT, "dist", "index.js"), "--stdio"], stderr: "pipe" });
const client = new Client({ name: "verify-memory", version: "0.0.1" });
await client.connect(transport);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};
const remember = (args) => client.callTool({ name: "brain_remember", arguments: args });
const first = (r) => r.content[0].text.split("\n")[0];

try {
  const fact = "The verify-memory probe prefers PostgreSQL over MongoDB for every new side project because migrations are easier to reason about.";
  const r1 = await remember({ fact, category: "feedback", why: "probe", how_to_apply: "probe" });
  check("first fact stored", !r1.isError, first(r1));

  const r2 = await remember({ fact, category: "feedback" });
  check("exact repeat refused", r2.isError === true && r2.content[0].text.includes("duplicate"), first(r2));

  const r3 = await remember({ fact: "verify-memory probe: prefers PostgreSQL over MongoDB for new side projects, migrations easier to reason about", category: "feedback" });
  check("paraphrase refused", r3.isError === true, first(r3));

  const r4 = await remember({ fact: "The verify-memory probe now prefers SQLite over PostgreSQL for small side projects because there is nothing to operate.", category: "feedback" });
  check("changed preference stored as update", !r4.isError && r4.content[0].text.includes("superseding"), r4.content[0].text.replace(/\n/g, " | ").slice(0, 140));

  const r5 = await remember({ fact, category: "feedback", force: true });
  check("force stores a duplicate", !r5.isError, first(r5));

  const r6 = await remember({ fact: "The verify-memory probe's favourite editor keybinding is ctrl+shift+p for the command palette.", category: "user" });
  check("unrelated fact stored as new", !r6.isError && !r6.content[0].text.includes("superseding"), first(r6));

  const now = fs.readFileSync(memPath, "utf8");
  check("memory file grew by four blocks", (now.match(/^## \d{4}-/gm) || []).length === (before ? (before.match(/^## \d{4}-/gm) || []).length : 0) + 4);

  const ident = await client.callTool({ name: "brain_identity", arguments: { topic: "side project database choice" } });
  check("topic identity includes captured facts", ident.content[0].text.includes("verify-memory probe"), `${ident.content[0].text.length} chars`);
  const full = await client.callTool({ name: "brain_identity", arguments: {} });
  check("topic bundle smaller than full bundle", ident.content[0].text.length < full.content[0].text.length, `${ident.content[0].text.length} < ${full.content[0].text.length}`);

  const ctx = await client.callTool({ name: "brain_context", arguments: { question: "how do I restore the ledger database from a backup" } });
  check("brain_context returns sources", ctx.content[0].text.includes("## Sources") && ctx.content[0].text.includes("Restore the ledger database"), ctx.content[0].text.split("\n")[2]);
} finally {
  await client.close();
  if (before === null) fs.rmSync(memPath, { force: true });
  else fs.writeFileSync(memPath, before, "utf8");
  console.log("memory file restored");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
