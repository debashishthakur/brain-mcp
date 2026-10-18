// Link graph report for a vault: link occurrences by where they sit, resolved note pairs, content links (a sentence,
// explained list item or embed with no hub or concept page at either end), the most-linked notes, and names that do
// not resolve or resolve to several notes. Run it now and then to watch written links grow. Needs no models.
// Run after `npm run build`:  node scripts/graph-stats.mjs [--config file]
import "./use-example-vault.mjs";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";

const argv = process.argv.slice(2);
const at = argv.indexOf("--config");
const cfg = loadConfig(at >= 0 ? path.resolve(argv[at + 1]) : undefined);
cfg.retrieval.hybrid = false; // the graph needs no embeddings
const index = new VaultIndex(cfg);
index.fullReindex();
const s = index.graph.stats();
const order = ["sentence", "list_explained", "embed", "short", "heading", "table", "list_bare", "fm", "trailer"];
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
const short = (id) => id.replace(/\.md$/, "");
console.log(`vault: ${path.basename(cfg.vaultDir)} · ${s.notes} notes`);
console.log(`link occurrences: ${order.filter((k) => s.occurrences[k]).map((k) => `${k} ${s.occurrences[k]}`).join(" · ")}`);
console.log(`resolved note pairs: ${s.pairs}`);
console.log(`content links (sentence, explained list item or embed; no hub or concept page at either end): ${s.contentPairs} pairs from ${s.contentNotes} notes (${pct(s.contentNotes, s.notes)} of notes)`);
console.log(`most linked: ${s.topIn.map(([id, n]) => `${short(id).split("/").pop()} ${n}`).join(" · ")}`);
console.log(`unresolved (${s.unresolved.length} shown): ${s.unresolved.map(([t, n]) => `${t} ${n}`).join(" · ") || "none"}`);
console.log(`names shared by several notes (${s.ambiguous.length}): ${s.ambiguous.slice(0, 10).map(([k, ids]) => `"${k}" → ${ids.map(short).join(" | ")}`).join("; ") || "none"}`);
await index.close();
