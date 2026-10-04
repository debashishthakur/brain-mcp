// Trace one query through the hybrid ranker: terms, each candidate list, fusion, reranker probabilities.
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
const cfg = loadConfig();
const index = new VaultIndex(cfg);
index.fullReindex(); // self-contained: works on a fresh clone without a running server
const q = process.argv.slice(2).join(" ");
const short = (id) => id.split("/").pop().replace(/\.md$/, "").slice(0, 42);
// poke at private helpers through the instance (debug only)
const u = index.understand(q);
console.log(`\n### ${q}\nterms: ${u.terms.join(" ")}  corrections: ${u.corrections.join(",") || "-"}`);
const lex = index.bm25Sections(u.terms, {}, 40);
console.log("lex :", lex.slice(0, 6).map((x) => `${short(x.note_id)}#${x.ord}`).join(" | "));
const den = await index.dense.search(q, 40);
console.log("den :", den.slice(0, 6).map((x) => `${short(x.note_id)}#${x.ord} ${x.score.toFixed(2)}`).join(" | "));
const r = await index.rankSections(q, { k: 8 });
console.log(`coverage=${r.coverage} early=${r.earlyExit} ms=${r.ms}`);
for (const s of r.sections) console.log(`  score=${s.score.toFixed(3)} rprob=${isNaN(s.rprob) ? "  -  " : s.rprob.toFixed(3)} ${short(s.note_id)}#${s.ord} [${s.heading.slice(0, 30)}] ${s.why.join(",")}`);
await index.close();
