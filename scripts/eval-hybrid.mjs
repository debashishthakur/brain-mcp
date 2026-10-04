// 35-query hard set (paraphrase, typo, identifier, date, multi-hop, alias, off-topic) with gold note
// ids, scored on the keyword path and the hybrid path. Cases live in eval-hybrid-cases.json.
// Run after `npm run build`:  node scripts/eval-hybrid.mjs
import "./use-example-vault.mjs";
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
import { Policy, ALL_SCOPES } from "../dist/policy.js";
import { buildContext, buildContextHybrid } from "../dist/context.js";

const CASES = JSON.parse(fs.readFileSync(new URL("./eval-hybrid-cases.json", import.meta.url), "utf8"));
const cfg = loadConfig();
const index = new VaultIndex(cfg);
index.fullReindex(); // self-contained: works on a fresh clone without a running server
const policy = new Policy(cfg);
const principal = { clientId: "eval", scopes: new Set(ALL_SCOPES), transport: "stdio" };

if (index.dense) {
  const embedded = await index.dense.embedMissing();
  const st = index.dense.stats();
  console.log(`dense: models ${st.loaded ? "loaded" : "UNAVAILABLE"}, ${st.vectors} vectors (${embedded} embedded now)`);
}

async function score(name, searchFn, refusedFn) {
  const cls = {};
  let top1 = 0, r5 = 0, mrr = 0, n = 0, ref = 0, offN = 0, ms = 0;
  const rows = [];
  for (const e of CASES) {
    const t0 = Date.now();
    const { ranked, refused } = await searchFn(e.q);
    ms += Date.now() - t0;
    if (e.cls === "offtopic") { offN++; if (refused) ref++; rows.push(`  ${e.cls.padEnd(10)} ${(refused ? "refused" : "ANSWERED").padEnd(9)} ${e.q}`); continue; }
    const i = ranked.findIndex((id) => e.gold.includes(id));
    n++; if (i === 0) top1++; if (i >= 0 && i < 5) r5++; if (i >= 0) mrr += 1 / (i + 1);
    cls[e.cls] ??= [0, 0]; cls[e.cls][1]++; if (i === 0) cls[e.cls][0]++;
    rows.push(`  ${e.cls.padEnd(10)} ${("#" + (i + 1 || "-")).padEnd(9)} ${e.q}`);
  }
  console.log(`\n== ${name}`);
  for (const r of rows) console.log(r);
  const pc = (c) => (cls[c] ? `${cls[c][0]}/${cls[c][1]}` : "-").padEnd(7);
  console.log(`  top-1 ${(100 * top1 / n).toFixed(0)}%  recall@5 ${(100 * r5 / n).toFixed(0)}%  MRR ${(mrr / n).toFixed(2)}  | para ${pc("paraphrase")} typo ${pc("typo")} ident ${pc("identifier")} date ${pc("date")} hop ${pc("multihop")} alias ${pc("alias")} | off-topic refused ${ref}/${offN} | ${(ms / CASES.length).toFixed(0)} ms/q`);
}

await score("keyword (legacy brain_search)", async (q) => {
  const hits = index.search(q, { limit: 5 });
  return { ranked: hits.map((h) => h.id), refused: !hits.length };
});
await score("hybrid (searchHybrid)", async (q) => {
  const r = await index.searchHybrid(q, { limit: 5 });
  return { ranked: r.hits.map((h) => h.id), refused: r.coverage === "none" };
});
await score("hybrid context (buildContextHybrid sources)", async (q) => {
  const r = await buildContextHybrid(cfg, index, policy, principal, q);
  return { ranked: r.notes.slice(0, 5), refused: r.coverage === "none" };
});
await index.close();
