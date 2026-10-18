// Hard-question eval for brain-mcp retrieval: paraphrase, typo, identifier, date, multi-hop, alias and off-topic
// questions with gold note ids, scored on the keyword path and the hybrid path. Cases live in eval-hybrid-cases.json.
//
// For the hybrid path each question is ranked once with tracing on, as the owner (every scope, so only `denyPaths`
// notes are hidden), and every stage is scored from that one pass:
//   search  = the first 5 notes of the top 30 sections (what brain_search returns for limit 5)
//   context = the brain_context pack (packSections over the top 24 sections; with the models off, the keyword
//             pipeline brain_context falls back to)
//   funnel  = for every note an answer needs (`required`): found by a list → in the reranker shortlist → reranked →
//             kept → packed, and where it was lost (not found, below the shortlist, refused, trimmed, past k).
// Evidence groups belong to the question, as in the Brain Retrieval Benchmark: each group lists alternative spans,
// matched like the benchmark does (NFKC, case, Markdown * ` _ and whitespace ignored). A needed note's gold sections
// are the ones holding a span of any group, or all its sections when none does; "evidence in the pack" is the share
// of groups with a span in the packed text.
//
// Run after `npm run build`:
//   node scripts/eval-hybrid.mjs                                   example vault, bundled cases
//   node scripts/eval-hybrid.mjs --config my.json --cases q.json  another vault and case file
// Options:
//   --set key=value      override a retrieval setting (rerankN=8, floor=0.02) or any config path (context.budgetChars=8000)
//   --sweep key=a,b,c    run the hybrid pass once per value, in one process (not for the model names)
//   --split dev|test     only that split of a case file with ids (the Brain Retrieval Benchmark's split rule)
//   --only <class>       only one class      --limit <n>   only the first n cases
//   --repeat <n>         run the hybrid pass n times and exit 1 if any shortlist, cut or score differs
//   --json <file>        write every case's result      --no-keyword   skip the keyword row      --quiet   no per-case lines
// Case files: a JSON array of { cls, q, gold, required?, evidence? }, or the benchmark's { queries: [...] } /
// array of { id, query, category, required, evidence, qrels }. evidence is a list of groups of alternative spans.
import "./use-example-vault.mjs";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
import { buildContextHybrid, packSections } from "../dist/context.js";
import { ALL_SCOPES, Policy } from "../dist/policy.js";
import { floorFor } from "../dist/vault/dense.js";

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = { set: [], sweep: null, config: null, cases: null, json: null, split: "all", only: null, limit: 0, repeat: 1, keyword: true, quiet: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    return argv[++i];
  };
  if (a === "--config") opt.config = next();
  else if (a === "--cases") opt.cases = next();
  else if (a === "--set") opt.set.push(next());
  else if (a === "--sweep") opt.sweep = next();
  else if (a === "--json") opt.json = next();
  else if (a === "--split") opt.split = next();
  else if (a === "--only") opt.only = next();
  else if (a === "--limit") opt.limit = Number(next());
  else if (a === "--repeat") opt.repeat = Math.max(1, Number(next()));
  else if (a === "--no-keyword") opt.keyword = false;
  else if (a === "--quiet") opt.quiet = true;
  else {
    console.error(`unknown option ${a}`);
    process.exit(2);
  }
}
const parseValue = (v) => {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
/** The retrieval field a --set/--sweep key names ("rerankN" or "retrieval.rerankN"), or null for another path. */
const retrievalKey = (key) => (key.startsWith("retrieval.") ? key.slice("retrieval.".length) : key.includes(".") ? null : key);
/** `rerankN` sets cfg.retrieval.rerankN; a dotted path such as `context.budgetChars` is taken from the config root. */
function setPath(cfg, key, value) {
  const parts = key.includes(".") ? key.split(".") : ["retrieval", key];
  let o = cfg;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = value;
}

// ---------------------------------------------------------------- cases
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** Text as the benchmark matches evidence: NFKC, lowercase, Markdown emphasis and code marks dropped, whitespace folded. */
const evNorm = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[*`_]/g, "").replace(/\s+/g, " ").trim();
const raw = JSON.parse(fs.readFileSync(opt.cases ? path.resolve(opt.cases) : new URL("./eval-hybrid-cases.json", import.meta.url), "utf8"));
let CASES = (Array.isArray(raw) ? raw : raw.queries).map((e, i) => {
  const cls = e.cls ?? e.category ?? "other";
  const offtopic = cls === "offtopic" || cls === "abstain";
  const required = e.required ?? [];
  const graded = (min) => Object.entries(e.qrels ?? {}).filter(([, g]) => g >= min).map(([id]) => id);
  let gold = offtopic ? [] : e.gold ?? [...new Set([...required, ...graded(3)])];
  if (!offtopic && !gold.length) gold = graded(2);
  const evidence = Array.isArray(e.evidence)
    ? e.evidence.map((x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : [x]).filter(Boolean).map(evNorm).filter(Boolean)).filter((g) => g.length)
    : [];
  const split = e.id ? (fnv1a(`brb:${e.family ?? e.id}`) % 4 === 0 ? "dev" : "test") : "all";
  return { id: e.id ?? `case-${i + 1}`, cls, q: e.q ?? e.query, gold, required, evidence, offtopic, split };
});
if (opt.split !== "all") CASES = CASES.filter((c) => c.split === opt.split);
if (opt.only) CASES = CASES.filter((c) => c.cls === opt.only);
if (opt.limit > 0) CASES = CASES.slice(0, opt.limit);
if (!CASES.length) {
  console.error("no cases selected");
  process.exit(2);
}

// ---------------------------------------------------------------- index
const cfg = loadConfig(opt.config ? path.resolve(opt.config) : undefined);
for (const s of opt.set) {
  const eq = s.indexOf("=");
  setPath(cfg, s.slice(0, eq), parseValue(s.slice(eq + 1)));
}
// A --set rerankModel takes that model's calibrated floor, as the config loader would, unless a floor is set too.
const rawCfg = JSON.parse(fs.readFileSync(cfg.configPath, "utf8"));
const setKeys = opt.set.map((s) => retrievalKey(s.slice(0, s.indexOf("="))));
if (setKeys.includes("rerankModel") && !setKeys.includes("floor") && rawCfg.retrieval?.floor === undefined) cfg.retrieval.floor = floorFor(cfg.retrieval.rerankModel);
const index = new VaultIndex(cfg);
// The owner's view: every scope, so only denyPaths notes are hidden, as brain_search and brain_context would.
const policy = new Policy(cfg);
const owner = { clientId: "eval", scopes: new Set(ALL_SCOPES) };
const readable = (n) => policy.canRead(n, owner);
const ri = index.fullReindex(); // self-contained: works on a fresh clone without a running server
if (index.dense) {
  const embedded = await index.dense.embedMissing();
  const st = index.dense.stats();
  console.log(`dense: models ${st.loaded ? "loaded" : "UNAVAILABLE"}, ${st.vectors} vectors (${embedded} embedded now)`);
} else console.log("dense: hybrid off, so search and context are the keyword pipeline");
const nSections = index.db.prepare("SELECT COUNT(*) c FROM sections").get().c;
const rc = cfg.retrieval;
const settings = () =>
  `rerank ${rc.rerankModel.split("/").pop()} · rerankN ${rc.rerankN} · floor ${rc.floor} · goodAt ${rc.goodAt} · keepRatio ${rc.keepRatio} · minKeep ${rc.minKeep} · agreeOverride ${rc.agreeOverride} · blend ${rc.blend} · earlyExit ${rc.earlyExit} · firstPicks ${rc.firstPicks}`;
console.log(`vault: ${path.basename(cfg.vaultDir)} · ${ri.indexed} notes · ${nSections} sections · ${CASES.length} cases${opt.split !== "all" ? ` (${opt.split} split)` : ""}`);
console.log(`settings: ${settings()}`);

// ---------------------------------------------------------------- keyword row (unchanged scoring)
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
const CLS_SHORT = { paraphrase: "para", typo: "typo", identifier: "ident", date: "date", multihop: "hop", alias: "alias" };
function classLine(perCls) {
  const keys = Object.keys(perCls);
  const order = [...Object.keys(CLS_SHORT).filter((k) => keys.includes(k)), ...keys.filter((k) => !CLS_SHORT[k]).sort()];
  return order.map((k) => `${(CLS_SHORT[k] ?? k).slice(0, 6)} ${`${perCls[k][0]}/${perCls[k][1]}`.padEnd(6)}`).join(" ");
}
function rankScore(rows, pick) {
  const perCls = {};
  let top1 = 0, r5 = 0, mrr = 0, n = 0, offRef = 0, offN = 0, onRef = 0;
  for (const r of rows) {
    if (r.offtopic) {
      offN++;
      if (r.refused) offRef++;
      continue;
    }
    if (!r.gold.length) continue;
    const ranked = pick(r);
    const i = ranked.findIndex((id) => r.gold.includes(id));
    n++;
    if (r.refused) onRef++;
    if (i === 0) top1++;
    if (i >= 0 && i < 5) r5++;
    if (i >= 0) mrr += 1 / (i + 1);
    perCls[r.cls] ??= [0, 0];
    perCls[r.cls][1]++;
    if (i === 0) perCls[r.cls][0]++;
  }
  return { top1, r5, mrr, n, offRef, offN, onRef, perCls };
}
function printRank(name, s, ms) {
  console.log(
    `  top-1 ${pct(s.top1, s.n)}  recall@5 ${pct(s.r5, s.n)}  MRR ${(s.n ? s.mrr / s.n : 0).toFixed(2)}  | ${classLine(s.perCls)}| off-topic refused ${s.offRef}/${s.offN} · on-topic refused ${s.onRef}/${s.n} | ${ms}`,
  );
}

if (opt.keyword) {
  const rows = [];
  const t0 = Date.now();
  for (const c of CASES) {
    const hits = index.search(c.q, { limit: 5 }).filter((h) => readable(index.get(h.id)));
    rows.push({ ...c, ranked: hits.map((h) => h.id), refused: !hits.length });
  }
  console.log(`\n== keyword (legacy brain_search)`);
  if (!opt.quiet) for (const r of rows) console.log(caseLine(r, r.ranked));
  printRank("keyword", rankScore(rows, (r) => r.ranked), `${((Date.now() - t0) / CASES.length).toFixed(0)} ms/q`);
}

function caseLine(r, ranked, extra = "") {
  if (r.offtopic) return `  ${r.cls.padEnd(10)} ${(r.refused ? "refused" : "ANSWERED").padEnd(9)} ${r.q}`;
  const i = ranked.findIndex((id) => r.gold.includes(id));
  return `  ${r.cls.padEnd(10)} ${(r.refused ? "refused" : "#" + (i + 1 || "-")).padEnd(9)} ${r.q}${extra}`;
}

// ---------------------------------------------------------------- hybrid pass
const distinct = (ids) => [...new Set(ids)];
const ctx = cfg.context;
const packOpts = () => ({ budget: Math.max(2000, Math.min(ctx.budgetChars, 60000)), perNote: Math.max(1, Math.min(ctx.maxSectionsPerNote, 6)), maxSectionChars: ctx.maxSectionChars });
const sectionCache = new Map();
const sectionsOf = (id) => {
  if (!sectionCache.has(id)) sectionCache.set(id, index.sectionsOf(id));
  return sectionCache.get(id);
};
const holds = (text, groups) => {
  const t = evNorm(text);
  return groups.some((g) => g.some((sp) => t.includes(sp)));
};

/**
 * Follow one needed note through the stages of one ranking pass. `kept24`: the sections brain_context gets;
 * `packed`: the packed sections, or null when the keyword pipeline packed (models off), where only `pack` is known.
 */
function trace(note, groups, r, kept24, top5, packed, pack) {
  const secs = sectionsOf(note);
  let keys = groups.length ? secs.filter((s) => holds(s.text, groups)).map((s) => `${note}#${s.ord}`) : [];
  const level = keys.length ? "section" : "note";
  if (!keys.length) keys = secs.map((s) => `${note}#${s.ord}`);
  const G = new Set(keys);
  const d = r.debug;
  const listed = ["lex", "den", "exact", "note"].filter((l) => d.lists[l].some((k) => G.has(k)));
  const fusedRank = d.fused.findIndex((f) => G.has(f.key)) + 1;
  const poolE = d.pool.filter((p) => G.has(p.key));
  const kept = kept24.some((s) => G.has(`${s.note_id}#${s.ord}`));
  // `packed`: a gold section is in the pack (the funnel's last stage); `notePacked`: any section of the note is.
  const packed_ = packed ? packed.some((s) => G.has(`${s.note_id}#${s.ord}`)) : pack.includes(note);
  let lost = null;
  if (!secs.length) lost = "missing from vault";
  else if (!listed.length) lost = "not found";
  else if (!poolE.length) lost = r.coverage === "lexical" ? "past k" : "below shortlist";
  else if (r.coverage === "none") lost = "refused";
  else if (!kept) lost = poolE.some((p) => p.cut === "trim") ? "trimmed" : "past k";
  else if (!packed_) lost = "not packed";
  return {
    note,
    level,
    listed,
    fusedRank: fusedRank || null,
    pool: poolE.length > 0,
    reranked: poolE.some((p) => p.reranked),
    kept,
    top5: top5.includes(note),
    packed: packed_,
    notePacked: pack.includes(note),
    lost,
  };
}
/** Evidence groups with a span in the packed text, as the benchmark's Evidence@budget counts them. */
const evidenceFound = (packText, groups) => {
  const text = evNorm(packText);
  return groups.map((g) => g.some((sp) => text.includes(sp)));
};

async function hybridPass() {
  const rows = [];
  for (const c of CASES) {
    const t0 = Date.now();
    // brain_search(limit 5) ranks 30 sections (searchHybrid with limit 10); brain_context keeps the first 24, the
    // same as ranking 24, because the limit cut comes after the score sort and the trim.
    const r = await index.rankSections(c.q, { k: 30, debug: true, readable });
    const ms = Date.now() - t0;
    const top5 = distinct(r.sections.map((s) => s.note_id)).slice(0, 5);
    const kept24 = r.sections.slice(0, 24);
    let packed = r.coverage === "none" ? [] : packSections(kept24, packOpts());
    let pack = distinct(packed.map((s) => s.note_id));
    let packText = packed.map((s) => s.text).join("\n");
    if (r.coverage === "lexical") {
      // Models off: brain_context answers from the keyword pipeline, not from these sections.
      const lx = await buildContextHybrid(cfg, index, policy, owner, c.q);
      pack = lx.notes;
      packText = lx.text;
      packed = null;
    }
    const need = c.required.map((note) => trace(note, c.evidence, r, kept24, top5, packed, pack));
    const evid = evidenceFound(packText, c.evidence);
    const sig = JSON.stringify([r.coverage, r.debug.pool.map((p) => [p.key, p.cut, p.prob === null ? null : p.prob.toFixed(6), p.score === null ? null : p.score.toFixed(6)])]);
    rows.push({ ...c, refused: r.coverage === "none", coverage: r.coverage, topProb: r.stats.topProb, earlyExit: r.earlyExit, pairs: r.stats.reranked, pool: r.stats.pool, fused: r.stats.fused, ms, top5, pack, need, evid, sig });
  }
  return rows;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : 0;
};

function summarize(label, rows) {
  const ms = rows.map((r) => r.ms);
  const cost = `${median(ms)} ms/q median, ${p95(ms)} p95 · ${(rows.reduce((a, r) => a + r.pairs, 0) / rows.length).toFixed(1)} reranked/q, early exit ${pct(rows.filter((r) => r.earlyExit).length, rows.length)}`;
  console.log(`\n== hybrid search${label ? ` [${label}]` : ""} (brain_search, first 5 notes of the top 30 sections)`);
  if (!opt.quiet)
    for (const r of rows) {
      const needs = r.need.length ? `  [needs ${r.need.filter((n) => n.notePacked).length}/${r.need.length} packed${r.need.some((n) => n.lost) ? `; lost: ${r.need.filter((n) => n.lost).map((n) => n.lost + (n.lost === "below shortlist" && n.fusedRank ? ` #${n.fusedRank}` : "")).join(", ")}` : ""}]` : "";
      console.log(caseLine(r, r.top5, needs));
    }
  printRank("search", rankScore(rows, (r) => r.top5), cost);
  console.log(`== hybrid context${label ? ` [${label}]` : ""} (brain_context pack, first 5 sources)`);
  printRank("context", rankScore(rows, (r) => r.pack.slice(0, 5)), cost);

  const req = rows.filter((r) => r.required.length);
  if (req.length) {
    const all = (key) => req.filter((r) => r.need.every((n) => n[key])).length;
    console.log(`  every needed note (${req.length} questions with required notes): in top 5 ${pct(all("top5"), req.length)} · in the pack ${pct(all("notePacked"), req.length)}`);
    const needs = req.flatMap((r) => r.need);
    const count = (f) => needs.filter(f).length;
    console.log(
      `  funnel over ${needs.length} needed notes: found by a list ${pct(count((n) => n.listed.length), needs.length)} → in the shortlist ${pct(count((n) => n.pool), needs.length)} → reranked ${pct(count((n) => n.reranked), needs.length)} → kept ${pct(count((n) => n.kept), needs.length)} → packed ${pct(count((n) => n.packed), needs.length)}`,
    );
    const lost = {};
    for (const n of needs) if (n.lost) lost[n.lost] = (lost[n.lost] ?? 0) + 1;
    const unplaced = needs.filter((n) => n.level === "note" && rows.find((r) => r.need.includes(n))?.evidence.length).length;
    if (unplaced) console.log(`  (${unplaced} needed note(s) hold no evidence span, so any of their sections counts as gold)`);
    const below = needs.filter((n) => n.lost === "below shortlist" && n.fusedRank).map((n) => n.fusedRank);
    console.log(
      `  lost at: ${Object.keys(lost).length ? Object.entries(lost).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") : "nothing"}${below.length ? ` (below-shortlist fused rank median ${median(below)})` : ""}`,
    );
  }
  const ev = rows.filter((r) => !r.offtopic && r.evidence.length);
  if (ev.length) {
    const groups = ev.flatMap((r) => r.evid);
    console.log(`  evidence in the pack: ${pct(groups.filter(Boolean).length, groups.length)} of ${groups.length} groups · every group for ${pct(ev.filter((r) => r.evid.every(Boolean)).length, ev.length)} of ${ev.length} questions`);
  }
}

const variants = [];
const runVariant = async (label) => {
  const rows = await hybridPass();
  summarize(label, rows);
  variants.push({ label, settings: structuredClone({ ...rc, aliases: undefined }), rows });
  for (let i = 1; i < opt.repeat; i++) {
    const again = await hybridPass();
    again.forEach((r, j) => {
      if (r.sig !== rows[j].sig) {
        mismatch++;
        console.log(`  NONDETERMINISTIC${label ? ` [${label}]` : ""} (run ${i + 1}): ${r.q}`);
      }
    });
  }
  return rows;
};

let mismatch = 0;
if (opt.sweep) {
  const eq = opt.sweep.indexOf("=");
  const key = opt.sweep.slice(0, eq);
  if (["rerankModel", "embedModel"].includes(retrievalKey(key))) {
    console.error(`--sweep cannot change ${key}: the models load once per process; use --set in separate runs`);
    process.exit(2);
  }
  for (const v of opt.sweep.slice(eq + 1).split(",")) {
    setPath(cfg, key, parseValue(v));
    await runVariant(`${key}=${v}`);
  }
} else await runVariant("");
if (opt.repeat > 1) console.log(mismatch ? `\ndeterminism: ${mismatch} case(s) differ across ${opt.repeat} runs` : `\ndeterminism: identical across ${opt.repeat} runs`);

if (opt.json) {
  fs.mkdirSync(path.dirname(path.resolve(opt.json)), { recursive: true });
  fs.writeFileSync(
    path.resolve(opt.json),
    JSON.stringify({ vault: path.basename(cfg.vaultDir), notes: ri.indexed, sections: nSections, cases: CASES.length, split: opt.split, variants: variants.map((v) => ({ ...v, rows: v.rows.map(({ sig, ...r }) => r) })) }, null, 1),
  );
  console.log(`\nwrote ${opt.json}`);
}
await index.close();
process.exit(mismatch ? 1 : 0);
