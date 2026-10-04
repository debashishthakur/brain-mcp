// Retrieval eval: natural-language questions with the note that should answer them.
// Scores the keyword path (index.search / buildContext) and the hybrid path (index.searchHybrid /
// buildContextHybrid) side by side. Run after `npm run build`. The hybrid rows need the models in
// data/models (downloaded on first use) and section vectors (embedded on first run, hash-keyed).
// Add cases as the vault grows; keep phrasing natural, not keyword-copied.
import "./use-example-vault.mjs";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
import { Policy, ALL_SCOPES } from "../dist/policy.js";
import { buildContext, buildContextHybrid } from "../dist/context.js";

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
index.fullReindex(); // self-contained: works on a fresh clone without a running server
const policy = new Policy(cfg);
const principal = { clientId: "eval", scopes: new Set(ALL_SCOPES), transport: "stdio" };
const hit = (id, expected) => id.toLowerCase().includes(expected.toLowerCase());
const n = CASES.length;
const pct = (x) => `${((100 * x) / n).toFixed(0)}%`;

if (index.dense) {
  const t0 = Date.now();
  const embedded = await index.dense.embedMissing();
  const st = index.dense.stats();
  console.log(`dense: models ${st.loaded ? "loaded" : st.disabled ? "UNAVAILABLE (hybrid rows fall back to keywords)" : "not loaded"}, ${st.vectors} vectors (${embedded} embedded now, ${Date.now() - t0} ms)`);
}

async function run(name, searchFn, contextFn) {
  let s1 = 0, s5 = 0, ctxHit = 0, ctxFirst = 0, ms = 0;
  const misses = [];
  for (const [q, expected] of CASES) {
    const t0 = Date.now();
    const hits = await searchFn(q);
    const ctx = await contextFn(q);
    ms += Date.now() - t0;
    const top1 = hits[0] && hit(hits[0].id, expected);
    const top5 = hits.some((h) => hit(h.id, expected));
    const inCtx = ctx.notes.some((id) => hit(id, expected));
    const firstCtx = ctx.notes[0] && hit(ctx.notes[0], expected);
    s1 += top1 ? 1 : 0;
    s5 += top5 ? 1 : 0;
    ctxHit += inCtx ? 1 : 0;
    ctxFirst += firstCtx ? 1 : 0;
    if (!top1 || !firstCtx) misses.push({ q, expected, search: hits.slice(0, 3).map((h) => h.title), context: ctx.notes.slice(0, 3), coverage: ctx.coverage });
  }
  console.log(`\n${name}: brain_search top-1 ${pct(s1)}  top-5 ${pct(s5)}  |  brain_context first-source ${pct(ctxFirst)}  expected-in-sources ${pct(ctxHit)}  |  ${(ms / n).toFixed(0)} ms/case`);
  for (const m of misses) {
    console.log(`  miss "${m.q}"  expected: ${m.expected}${m.coverage ? `  coverage: ${m.coverage}` : ""}`);
    console.log(`     search:  ${m.search.join(" | ")}`);
    console.log(`     context: ${m.context.join(" | ")}`);
  }
}

console.log(`cases: ${n}`);
await run("keyword (legacy)", async (q) => index.search(q, { limit: 5 }), async (q) => buildContext(cfg, index, policy, principal, q));
await run("hybrid (live)", async (q) => (await index.searchHybrid(q, { limit: 5 })).hits, (q) => buildContextHybrid(cfg, index, policy, principal, q));
await index.close();
