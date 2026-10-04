// Retrieval eval: natural-language questions with the note that should answer them.
// Scores brain_search (top-1 / top-5) and brain_context (expected note among sources).
// Run after `npm run build`. The cases target the bundled example-vault; when you point the server at your
// own vault, replace them with questions about your notes. Keep phrasing natural, not keyword-copied.
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
import { Policy, ALL_SCOPES } from "../dist/policy.js";
import { buildContext } from "../dist/context.js";

const CASES = [
  ["why is the finance importer on postgres and not sqlite", "Use PostgreSQL for the ledger"],
  ["how do I bring the ledger back after the disk died", "Restore the ledger database"],
  ["importing the same bank statement twice doubled the totals", "Harbor Ledger progress"],
  ["why doesn't the garden microphone upload audio to a cloud service", "Run bird detection on the device"],
  ["wind gusts causing false bird detections", "Kestrel progress"],
  ["the raspberry pi overheating in the sun", "Kestrel progress"],
  ["how should an assistant change code in my repositories", "Code review preferences"],
  ["where do the nightly database backups end up", "Home server facts"],
  ["format for git commit messages", "Commit message skill"],
  ["rules for writing documentation and messages", "Writing style"],
  ["which tool should I use for python environments", "Captures/Memory"],
  ["who am I and where do I work", "About Ines"],
];

const cfg = loadConfig();
const index = new VaultIndex(cfg);
const policy = new Policy(cfg);
const principal = { clientId: "eval", scopes: new Set(ALL_SCOPES), transport: "stdio" };
const hit = (id, expected) => id.toLowerCase().includes(expected.toLowerCase());

let s1 = 0, s5 = 0, ctxHit = 0, ctxFirst = 0;
const misses = [];
for (const [q, expected] of CASES) {
  const hits = index.search(q, { limit: 5 });
  const top1 = hits[0] && hit(hits[0].id, expected);
  const top5 = hits.some((h) => hit(h.id, expected));
  const ctx = buildContext(cfg, index, policy, principal, q);
  const inCtx = ctx.notes.some((id) => hit(id, expected));
  const firstCtx = ctx.notes[0] && hit(ctx.notes[0], expected);
  s1 += top1 ? 1 : 0;
  s5 += top5 ? 1 : 0;
  ctxHit += inCtx ? 1 : 0;
  ctxFirst += firstCtx ? 1 : 0;
  if (!top1 || !firstCtx) misses.push({ q, expected, search: hits.slice(0, 3).map((h) => h.title), context: ctx.notes.slice(0, 3) });
}
const n = CASES.length;
const pct = (x) => `${((100 * x) / n).toFixed(0)}%`;
console.log(`cases: ${n}`);
console.log(`brain_search  top-1 ${pct(s1)}   top-5 ${pct(s5)}`);
console.log(`brain_context first-source ${pct(ctxFirst)}   expected-in-sources ${pct(ctxHit)}`);
if (misses.length) {
  console.log("\nmisses (top-1 or first context source wrong):");
  for (const m of misses) {
    console.log(`- "${m.q}"  expected: ${m.expected}`);
    console.log(`    search:  ${m.search.join(" | ")}`);
    console.log(`    context: ${m.context.join(" | ")}`);
  }
}
await index.close();
