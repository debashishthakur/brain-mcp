// Trace one query through the hybrid ranker: terms, each candidate list, the reranker shortlist (where each entry
// came from, its probability and why it was cut), what the link graph added, and the final sections.
// Run after `npm run build`:  node scripts/debug-rank.mjs [--config file] [--set key=value ...] <question>
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { floorFor } from "../dist/vault/dense.js";
import { VaultIndex } from "../dist/vault/index.js";
import { ALL_SCOPES, Policy } from "../dist/policy.js";

const argv = process.argv.slice(2);
let configPath;
const sets = [];
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--config") configPath = path.resolve(argv[++i]);
  else if (argv[i] === "--set") sets.push(argv[++i]);
  else words.push(argv[i]);
}
const cfg = loadConfig(configPath);
// As in eval-hybrid.mjs: a bare key is a retrieval setting, a dotted one a path from the config root, and a new
// reranker takes its calibrated floor unless a floor is set too.
const retrievalKey = (key) => (key.startsWith("retrieval.") ? key.slice("retrieval.".length) : key.includes(".") ? null : key);
const keys = [];
for (const s of sets) {
  const eq = s.indexOf("=");
  const key = s.slice(0, eq);
  let v = s.slice(eq + 1);
  try {
    v = JSON.parse(v);
  } catch {}
  const parts = key.includes(".") ? key.split(".") : ["retrieval", key];
  let o = cfg;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = v;
  keys.push(retrievalKey(key));
}
if (keys.includes("rerankModel") && !keys.includes("floor") && JSON.parse(fs.readFileSync(cfg.configPath, "utf8")).retrieval?.floor === undefined) cfg.retrieval.floor = floorFor(cfg.retrieval.rerankModel);
const index = new VaultIndex(cfg);
index.fullReindex(); // self-contained: works on a fresh clone without a running server
if (index.dense) await index.dense.embedMissing();
const q = words.join(" ");
const short = (key) => {
  const [id, ord] = key.split("#");
  return `${id.split("/").pop().replace(/\.md$/, "").slice(0, 40)}#${ord}`;
};
// As the owner sees it, like brain_search and brain_context: every scope, so only denyPaths notes are hidden.
const policy = new Policy(cfg);
const owner = { clientId: "debug", scopes: new Set(ALL_SCOPES) };
const r = await index.rankSections(q, { k: 24, debug: true, readable: (n) => policy.canRead(n, owner) });
const d = r.debug;
console.log(`\n### ${q}\nterms: ${r.terms.join(" ")}  corrections: ${r.corrections.join(",") || "-"}`);
for (const [name, list] of Object.entries(d.lists)) if (list.length) console.log(`${name.padEnd(5)}: ${list.slice(0, 6).map(short).join(" | ")}${list.length > 6 ? ` … (${list.length})` : ""}`);
console.log(`rerank ${cfg.retrieval.rerankModel.split("/").pop()} · rerankN ${cfg.retrieval.rerankN} · floor ${cfg.retrieval.floor} · goodAt ${cfg.retrieval.goodAt} · minKeep ${cfg.retrieval.minKeep} · agreeOverride ${cfg.retrieval.agreeOverride}`);
console.log(`fused ${r.stats.fused} · shortlist ${r.stats.pool} · reranked ${r.stats.reranked} · best prob ${r.stats.topProb === null ? "-" : r.stats.topProb.toFixed(3)} · coverage=${r.coverage} early=${r.earlyExit} ms=${r.ms}`);
console.log("shortlist (fused rank, source, reranker probability, blended score, cut):");
for (const p of d.pool) {
  const via = p.graph ? `  ← ${p.graph.dir === "out" ? "linked from" : "links to"} ${p.graph.seed.replace(/\.md$/, "").split("/").pop()} (${p.graph.kind}, strength ${p.graph.strength.toFixed(2)}, fit ${p.graph.fit.toFixed(2)}${p.graph.prefixed ? ", prefixed" : ""})` : "";
  const partner = p.partnerOf ? `  ← link partner of ${p.partnerOf.replace(/\.md$/, "").split("/").pop()}` : "";
  console.log(`  #${String(p.fusedRank).padEnd(3)} ${p.src.padEnd(5)} prob=${p.prob === null ? "  -  " : p.prob.toFixed(3)} score=${p.score === null ? "  -  " : p.score.toFixed(3)} ${p.cut.padEnd(5)} ${short(p.key)}${via}${partner}`);
}
if (d.graph) {
  const g = r.stats.graph;
  console.log(`graph: ${g.ran ? "ran" : r.earlyExit ? "skipped (early exit)" : "skipped (no place to give)"} · seeds ${d.graph.seeds.map((x) => short(x.key)).join(", ") || "-"} · ${g.candidates} worth a place, ${g.admitted} admitted, ${g.displaced} displaced, ${g.partners} partner(s) · ${g.ms} ms`);
  for (const c of d.graph.candidates.slice(0, 20))
    console.log(`  ${c.status.padEnd(10)} ${short(c.key ?? `${c.note}#?`)} ${c.dir === "out" ? "from" : "to"} ${c.seed.replace(/\.md$/, "").split("/").pop()} (${c.kind}, strength ${c.strength.toFixed(2)}${c.fit === undefined ? "" : `, fit ${c.fit.toFixed(2)}, score ${c.score.toFixed(3)}`})`);
  for (const x of d.graph.displaced) console.log(`  displaced #${x.fusedRank} ${short(x.key)} by ${short(x.by)}`);
}
console.log("result:");
for (const s of r.sections) console.log(`  score=${s.score.toFixed(3)} rprob=${isNaN(s.rprob) ? "  -  " : s.rprob.toFixed(3)} ${short(`${s.note_id}#${s.ord}`)} [${s.heading.slice(0, 30)}] ${s.why.join(",")}`);
await index.close();
