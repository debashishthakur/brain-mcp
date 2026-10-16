// Verifies brain_remember deduplication over stdio, then restores Captures/Memory.md byte-for-byte.
import "./use-example-vault.mjs";
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

const transport = new StdioClientTransport({ command: "node", args: [path.join(ROOT, "dist", "index.js"), "--stdio"], stderr: "pipe", env: { ...process.env } });
const client = new Client({ name: "verify-memory", version: "0.0.1" });
await client.connect(transport);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};
const remember = (args) => client.callTool({ name: "brain_remember", arguments: args });
const first = (r) => r.content[0].text.split("\n")[0];
/** The id brain_remember reports: "Remembered (feedback) as 2026-10-16 09:10 #2." */
const idOf = (r) => r.content[0].text.match(/ as (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: #\d+)?)\./)?.[1];

try {
  const fact = "The verify-memory probe prefers PostgreSQL over MongoDB for every new side project because migrations are easier to reason about.";
  const r1 = await remember({ fact, category: "feedback", why: "probe", how_to_apply: "probe" });
  check("first fact stored", !r1.isError, first(r1));

  const r2 = await remember({ fact, category: "feedback" });
  check("exact repeat refused", r2.isError === true && r2.content[0].text.includes("duplicate"), first(r2));

  const r3 = await remember({ fact: "verify-memory probe: prefers PostgreSQL over MongoDB for new side projects, migrations easier to reason about", category: "feedback" });
  check("paraphrase refused", r3.isError === true, first(r3));

  // A changed fact is held back until the caller says whether it replaces the old one.
  const changed = "The verify-memory probe now prefers SQLite over PostgreSQL for small side projects because there is nothing to operate.";
  const r4 = await remember({ fact: changed, category: "feedback" });
  check("changed preference held back", r4.isError === true && r4.content[0].text.includes("replaces=["), first(r4));
  const id1 = idOf(r1);
  const r4b = await remember({ fact: changed, category: "feedback", replaces: [id1] });
  check("stored with replaces", !r4b.isError && r4b.content[0].text.includes(`Replaced ${id1}`), r4b.content[0].text.replace(/\n/g, " | ").slice(0, 160));
  const id4 = idOf(r4b);

  const r5 = await remember({ fact: changed, category: "feedback", force: true });
  check("force stores a duplicate", !r5.isError, first(r5));

  const r6 = await remember({ fact: "The verify-memory probe's favourite editor keybinding is ctrl+shift+p for the command palette.", category: "user" });
  check("unrelated fact stored as new", !r6.isError && !r6.content[0].text.includes("Replaced"), first(r6));

  // Same subject and attribute: the later fact replaces the earlier one with no ids passed. Both are backdated.
  const d1 = await remember({ fact: "The verify-memory probe dashboard is hosted on Fly.io.", category: "project", subject: "probe dashboard", attribute: "host", valid_from: "2026-01-05" });
  check("keyed fact stored", !d1.isError, first(d1));
  const d2 = await remember({ fact: "The verify-memory probe dashboard is hosted on the home server.", category: "project", subject: "Probe Dashboard", attribute: "host", valid_from: "2026-03-01" });
  check("same key replaces on its own", !d2.isError && d2.content[0].text.includes("same subject and attribute"), d2.content[0].text.replace(/\n/g, " | ").slice(0, 160));

  // Temporary facts: one already over, one far in the future.
  const e1 = await remember({ fact: "The verify-memory probe was travelling and answering slowly.", category: "user", valid_from: "2026-01-01", valid_until: "2026-01-31" });
  check("past temporary fact stored", !e1.isError && e1.content[0].text.includes("through 2026-01-31"), e1.content[0].text.replace(/\n/g, " | ").slice(0, 160));
  const e2 = await remember({ fact: "The verify-memory probe pays for a VPN subscription until the end of the century.", category: "project", valid_until: "2099-12-31" });
  check("future expiry stored", !e2.isError, first(e2));

  const bad = await Promise.all([
    remember({ fact: "The verify-memory probe replaces something that does not exist.", category: "project", replaces: ["1999-01-01 00:00"] }),
    remember({ fact: "The verify-memory probe has a subject but no attribute.", category: "project", subject: "probe" }),
    remember({ fact: "The verify-memory probe has an impossible end date.", category: "project", valid_until: "2026-02-30" }),
    remember({ fact: changed, category: "feedback", replaces: [id1] }),
  ]);
  check("unknown replaces id refused", bad[0].isError === true && bad[0].content[0].text.includes("No fact has the id"), first(bad[0]));
  check("subject without attribute refused", bad[1].isError === true, first(bad[1]));
  check("impossible date refused", bad[2].isError === true && bad[2].content[0].text.includes("not a date"), first(bad[2]));
  check("replacing a replaced fact refused", bad[3].isError === true && bad[3].content[0].text.includes(`already replaced by ${id4}`), first(bad[3]));

  const now = fs.readFileSync(memPath, "utf8");
  check("memory file grew by eight blocks", (now.match(/^## \d{4}-/gm) || []).length === (before ? (before.match(/^## \d{4}-/gm) || []).length : 0) + 8);
  const oldBlock = now.split(/\n(?=## \d{4}-)/).find((b) => b.startsWith(`## ${id1} · `)) ?? "";
  check("old fact left untouched in the file", oldBlock.includes(fact) && !/\*\*(Replaces|Valid until):/.test(oldBlock), oldBlock.split("\n")[0]);

  const ident = await client.callTool({ name: "brain_identity", arguments: { topic: "side project database choice" } });
  check("topic identity includes captured facts", ident.content[0].text.includes("verify-memory probe"), `${ident.content[0].text.length} chars`);
  const full = await client.callTool({ name: "brain_identity", arguments: {} });
  const bundle = full.content[0].text;
  check("topic bundle smaller than full bundle", ident.content[0].text.length < bundle.length, `${ident.content[0].text.length} < ${bundle.length}`);
  check("identity drops the replaced fact", !bundle.includes(fact) && bundle.includes(changed));
  check("identity drops the replaced keyed fact", !bundle.includes("hosted on Fly.io") && bundle.includes("hosted on the home server"));
  check("identity drops the expired fact", !bundle.includes("travelling and answering slowly") && bundle.includes("end of the century"));
  check("identity says history is kept", /\d+ replaced, expired or not-yet-valid fact\(s\)/.test(bundle));
  check("identity lists user facts before feedback", bundle.indexOf("favourite editor keybinding") < bundle.indexOf(changed));

  const facts = (args) => client.callTool({ name: "brain_facts", arguments: args });
  const nowF = await facts({ subject: "probe dashboard" });
  check("brain_facts now: current host only", nowF.content[0].text.includes("home server") && !nowF.content[0].text.includes("Fly.io"), nowF.content[0].text.split("\n")[0]);
  const febF = await facts({ subject: "probe dashboard", as_of: "2026-02-01" });
  check("brain_facts as_of: earlier host", febF.content[0].text.includes("Fly.io") && !febF.content[0].text.includes("home server"), febF.content[0].text.split("\n")[0]);
  const histF = await facts({ subject: "probe dashboard", history: true });
  check("brain_facts history: both, with the switch date", histF.content[0].text.includes("Fly.io") && histF.content[0].text.includes("replaced by") && histF.content[0].text.includes("on 2026-03-01"), histF.content[0].text.replace(/\n/g, " | ").slice(0, 200));
  const janF = await facts({ query: "travelling", as_of: "2026-01-15" });
  check("brain_facts as_of: temporary fact inside its window", janF.content[0].text.includes("travelling"), janF.content[0].text.split("\n")[0]);
  const qF = await facts({ query: "SQLite PostgreSQL side projects", history: true });
  check("brain_facts history: replaced preference shown as replaced", qF.content[0].text.includes(`replaced by ${id4}`), qF.content[0].text.replace(/\n/g, " | ").slice(0, 200));

  const old = await client.callTool({ name: "brain_context", arguments: { question: "verify-memory probe prefers PostgreSQL over MongoDB migrations" } });
  check("brain_context flags the outdated fact", old.content[0].text.includes(`Outdated: replaced by ${id4}`), old.content[0].text.split("\n")[2]);

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
