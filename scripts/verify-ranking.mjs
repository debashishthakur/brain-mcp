// Verifies the hybrid ranker without the models: a stand-in dense index scores sections and passages by rule, so each
// case sets up exactly the lists and reranker scores it needs. Covers the last step (a shortlist with nothing to
// rerank, a note with no sections, agreeOverride) and the link graph in the ranker (retrieval.graph): linked sections
// taking reranker places, what they may never displace, the early-exit shortcut, hubs, privacy and filters, the
// coverage guard, cuts, the linking-sentence prefix, the linked keep, and repeatability. Needs no models.
// Run after `npm run build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failed++;
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-ranking-"));
const vault = path.join(ROOT, "vault");
const put = (rel, s) => (fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }), fs.writeFileSync(path.join(vault, rel), s));
const note = (title, body) => `---\ntitle: "${title}"\ntype: note\n---\n# ${title}\n\n${body}\n`;
put("Notes/Lantern.md", note("Lantern", "## Brass\n\nThe brass lantern hangs on the quay by the old harbour wall.\n\n## Oil\n\nIt burns lamp oil, refilled on Sundays."));
put("Notes/Harbour.md", note("Harbour", "## Walls\n\nThe harbour wall was rebuilt in stone after the storm."));
put("Notes/Tides.md", note("Tides", "## Tables\n\nTide tables for the harbour are printed every month."));
put("Notes/Dentist appointments.md", "---\ntitle: Dentist appointments\ntags: [health]\n---\n");
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8")), vaultPath: "vault", dataDir: "data", retrieval: { hybrid: false } }));
process.env.BRAIN_MCP_LOG_DIR = path.join(ROOT, "logs");
const cfg = loadConfig(path.join(ROOT, "config.json"));
const index = new VaultIndex(cfg);
index.fullReindex();
const keys = index.db.prepare("SELECT note_id, ord FROM sections ORDER BY note_id, ord").all();

// The stand-in: cos[key] for meaning search (0.05 otherwise), prob(passage) for the reranker.
const fake = {
  cos: {},
  prob: () => 0.001,
  passages: [],
  ready: async () => true,
  correct: () => null,
  schedule() {},
  forget() {},
  stop() {},
  async scoreAll() {
    const hits = keys.map((k) => ({ ...k, score: this.cos[`${k.note_id}#${k.ord}`] ?? 0.05 }));
    return hits.sort((a, b) => b.score - a.score || (a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : a.ord - b.ord));
  },
  async search(q, k = 40) {
    return (await this.scoreAll(q)).slice(0, k);
  },
  async rerank(_q, ps) {
    this.passages.push(...ps);
    return ps.map((p) => this.prob(p));
  },
};
index.dense = fake;
const rc = cfg.retrieval;
const run = async (q, set = {}) => {
  const saved = { ...rc };
  Object.assign(rc, set);
  fake.passages = [];
  try {
    return await index.rankSections(q, { k: 24, debug: true });
  } catch (e) {
    return { error: e.message };
  } finally {
    Object.assign(rc, saved);
  }
};

// Nothing to rerank: rerankN 0 without first picks. Refused, whatever agreeOverride says, never a crash.
fake.cos = { "Notes/Lantern.md#1": 0.9 };
for (const agree of [false, true]) {
  const r = await run("brass lantern quay", { rerankN: 0, firstPicks: false, agreeOverride: agree });
  check(`an empty shortlist is refused, not a crash (agreeOverride ${agree})`, !r.error && r.coverage === "none" && r.sections.length === 0, r.error ?? `${r.coverage} ${r.sections?.length}`);
}

// A note with no sections: its title alone would score high, but it has nothing to return.
fake.cos = {};
fake.prob = (p) => (p.trim() === "Dentist appointments" ? 0.99 : 0.001);
const empty = await run("when are my dentist appointments");
check(
  "a note with no sections never reaches the reranker, so it cannot win coverage for unrelated hits",
  empty.coverage === "none" && empty.sections.length === 0 && !fake.passages.some((p) => p.startsWith("Dentist appointments")),
  JSON.stringify({ coverage: empty.coverage, n: empty.sections.length, note: empty.debug?.lists.note }),
);

// agreeOverride: keyword and meaning search agree on a section, the reranker scores everything under the floor.
fake.cos = { "Notes/Lantern.md#1": 0.9 };
fake.prob = () => 0.001;
const pre = await run("brass lantern quay");
const agreed = pre.debug.lists.lex[0] === "Notes/Lantern.md#1" && pre.debug.lists.den[0] === "Notes/Lantern.md#1";
check("(setup) both searches put Lantern's brass section first", agreed, JSON.stringify({ lex: pre.debug.lists.lex.slice(0, 3), den: pre.debug.lists.den.slice(0, 3) }));
check("agreeOverride off (the default): refused", pre.coverage === "none" && pre.sections.length === 0, `${pre.coverage} ${pre.sections.length}`);
const on = await run("brass lantern quay", { agreeOverride: true });
check(
  "agreeOverride on: thin, with the agreed note's sections only",
  on.coverage === "thin" && on.sections.length > 0 && on.sections.every((s) => s.note_id === "Notes/Lantern.md"),
  JSON.stringify({ coverage: on.coverage, notes: on.sections.map((s) => s.note_id) }),
);
fake.cos = { "Notes/Lantern.md#2": 0.9 };
const sameNote = await run("brass lantern quay", { agreeOverride: true });
check("agreeOverride on, same note but another section: refused", sameNote.coverage === "none", `${sameNote.coverage} lex ${sameNote.debug.lists.lex[0]} den ${sameNote.debug.lists.den[0]}`);

await index.close();
fs.rmSync(ROOT, { recursive: true, force: true });

// ================================================================ the link graph in the ranker
const G_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-ranking-graph-"));
const gv = path.join(G_ROOT, "vault");
const gput = (rel, s) => (fs.mkdirSync(path.dirname(path.join(gv, rel)), { recursive: true }), fs.writeFileSync(path.join(gv, rel), s));
const lnote = (title, body, extra = "", type = "note") => `---\ntitle: "${title}"\ntype: ${type}\nproject: "[[Ledger hub]]"\n${extra}---\n# ${title}\n\n${body}\n`;
const S = "Notes/Ledger backups.md";
const T = "Notes/Restore runbook.md";
const R = "Notes/Retention policy.md";
const L = "Notes/Linker.md";
const M = "Notes/Ledger member.md";
const HUB = "Hubs/Ledger hub.md";
gput(S, lnote("Ledger backups", "The ledger backup schedule runs nightly. The restore steps for the ledger live in [[Restore runbook]] and nowhere else.\n\n## Retention\n\nOld copies are pruned; see the [[Backups]] concept, the [[Vault keys]] and the [[Off note]] for more on this.", 'related: ["[[Retention policy]]"]\n'));
gput(T, `---\ntitle: "Restore runbook"\ntype: runbook\n---\n# Restore runbook\n\nStop the importer, load the dump, start it again.\n`);
gput(R, `---\ntitle: "Retention policy"\ntype: note\n---\n# Retention policy\n\nCopies older than ninety days are pruned.\n`);
gput(L, lnote("Linker", "## Intro\n\nUnrelated opening words here.\n\n## Builds\n\nThis builds on [[Ledger backups]] for the nightly restore."));
gput(HUB, `---\ntitle: "Ledger hub"\ntype: hub\n---\n# Ledger hub\n\n- [[Ledger backups]]\n- [[Ledger member]]\n`);
gput("Concepts/Backups.md", `---\ntitle: "Backups"\ntype: concept\n---\n# Backups\n\nA concept page.\n`);
gput(M, lnote("Ledger member", "A note that mentions the ledger once."));
gput("Private/Vault keys.md", lnote("Vault keys", "Secret key material lives here."));
gput("Other/Off note.md", `---\ntitle: "Off note"\ntype: note\nproject: "[[Other hub]]"\n---\n# Off note\n\nSomething in another project.\n`);
for (let i = 1; i <= 40; i++) gput(`Filler/F${String(i).padStart(2, "0")}.md`, `---\ntitle: "Filler ${i}"\ntype: note\n---\n# Filler ${i}\n\nUnrelated filler text number ${i}.\n`);
fs.writeFileSync(path.join(G_ROOT, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8")), vaultPath: "vault", dataDir: "data", privatePaths: ["Private/**"], retrieval: { hybrid: false, rerankN: 10 } }));
const gcfg = loadConfig(path.join(G_ROOT, "config.json"));
const gi = new VaultIndex(gcfg);
gi.fullReindex();
const gkeys = gi.db.prepare("SELECT note_id, ord FROM sections ORDER BY note_id, ord").all();
// Meaning search: the 40 fillers fill most of its top 40 (F01 first, so keyword #1 is not meaning #1: no early
// exit). The runbook shares no word with the question: only meaning search finds it, below the shortlist.
const baseCos = () => {
  const c = { [T]: 0.55 };
  for (let i = 1; i <= 40; i++) c[`Filler/F${String(i).padStart(2, "0")}.md`] = i === 1 ? 0.95 : 0.6 - (i - 2) * (0.19 / 38);
  return c;
};
const gfake = {
  ...fake,
  cos: baseCos(),
  prob: () => 0.5,
  passages: [],
  async scoreAll() {
    const hits = gkeys.map((k) => ({ ...k, score: this.cos[`${k.note_id}#${k.ord}`] ?? this.cos[k.note_id] ?? 0.05 }));
    return hits.sort((a, b) => b.score - a.score || (a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : a.ord - b.ord));
  },
};
gi.dense = gfake;
const grc = gcfg.retrieval;
const Q = "ledger backup schedule";
const grun = async (set = {}, graph = {}, o = {}) => {
  const saved = { ...grc, graph: { ...grc.graph } };
  Object.assign(grc, set);
  grc.graph = { ...grc.graph, ...graph };
  gfake.passages = [];
  try {
    return await gi.rankSections(o.q ?? Q, { k: 24, debug: true, ...o });
  } finally {
    Object.assign(grc, saved);
  }
};
const ON = { enabled: true };
const strip = (r) => JSON.stringify({ ...r, ms: 0, stats: { ...r.stats, graph: undefined }, debug: { ...r.debug, graph: undefined } });
const keysOf = (r, src) => r.debug.pool.filter((p) => p.src === src).map((p) => p.key);

// 1. identity: off, and on with no places and no keep, give the same ranking; off leaves no trace of the graph
const off = await grun();
const zero = await grun({}, { ...ON, slots: 0, keepLinked: 0 });
check("graph off, and on with slots 0 and keepLinked 0, rank the same", strip(off) === strip(zero), "differs");
check("graph off leaves no graph fields anywhere", !off.stats.graph && !off.debug.graph && !JSON.stringify(off.debug.pool).includes('"graph"') && !JSON.stringify(off).includes("partnerOf"), JSON.stringify(off.stats));

// 2. admission: the runbook (no list finds it) is linked in a sentence from the top hit and fits the question
const adm = await grun({}, ON);
const tRow = adm.debug.pool.find((p) => p.key.startsWith(T));
check(
  "(setup) only meaning search finds the runbook, below the shortlist",
  !off.debug.pool.some((p) => p.key.startsWith(T)) && off.debug.lists.den.some((k) => k.startsWith(T)) && !["lex", "exact", "note"].some((l) => off.debug.lists[l].some((k) => k.startsWith(T))),
  JSON.stringify({ pool: off.debug.pool.map((p) => p.key), den: off.debug.lists.den.indexOf(`${T}#0`) }),
);
check("a linked section takes a reranker place", tRow?.src === "graph" && adm.sections.some((x) => x.note_id === T && x.why.includes("graph: linked from Ledger backups")), JSON.stringify(adm.debug.pool.map((p) => [p.src, p.key, p.cut])));
check(
  "the reranker reads the linking sentence first",
  gfake.passages.some((p) => p.startsWith("Linked from Ledger backups: The restore steps for the ledger live in Restore runbook and nowhere else.\nRestore runbook")),
  gfake.passages.filter((p) => p.includes("Restore runbook\n")).join(" || "),
);
const offHead = keysOf(off, "head");
check(
  "it replaces the weakest unprotected entry, and the pairs stay the same",
  adm.debug.graph.displaced.length === 1 && adm.debug.graph.displaced[0].key === offHead.at(-1) && adm.stats.pool === off.stats.pool && adm.stats.reranked === off.stats.reranked,
  JSON.stringify({ displaced: adm.debug.graph.displaced, pool: [adm.stats.pool, off.stats.pool], pairs: [adm.stats.reranked, off.stats.reranked] }),
);
gfake.cos = { ...baseCos(), [T]: 0.2 };
const weak = await grun({}, ON);
check("a linked section that fits the question less than the place it would take is beaten", keysOf(weak, "graph").length === 0 && weak.debug.graph.candidates.some((c) => c.note === T && c.status === "beaten") && strip(weak) === strip(await grun()), JSON.stringify(weak.debug.graph.candidates.map((c) => [c.note, c.status])));
gfake.cos = baseCos();

// 3. protection: even forced in, linked sections never displace the top 3, seeds, a list's top 3, or both-list hits
const forced = await grun({}, { ...ON, swapWeight: 100, slots: 10, linksPerSeed: 10 });
const lists = forced.debug.lists;
const seedKeys = forced.debug.graph.seeds.map((x) => x.key);
const top3 = off.debug.fused.slice(0, 3).map((f) => f.key);
const rankIn = (l, k) => (l.indexOf(k) < 0 ? Infinity : l.indexOf(k) + 1);
const bad = forced.debug.graph.displaced.filter(
  (x) => top3.includes(x.key) || seedKeys.includes(x.key) || [lists.lex, lists.den, lists.exact, lists.note].some((l) => l.slice(0, 3).includes(x.key)) || lists.exact.includes(x.key) || (Math.min(rankIn(lists.lex, x.key), rankIn(lists.note, x.key)) <= 10 && rankIn(lists.den, x.key) <= 10),
);
check("forced in, linked sections still never displace a protected entry, and the pool keeps its size", forced.debug.graph.displaced.length > 0 && !bad.length && forced.stats.pool === off.stats.pool, JSON.stringify({ displaced: forced.debug.graph.displaced, bad }));

// 4. the early-exit shortcut: keyword and meaning search agree, so only the top 3 are reranked, and the graph stays out
gfake.cos = { ...baseCos(), [`${S}#0`]: 0.99 };
const ex = await grun({}, ON);
check("on the early-exit shortcut the graph adds nothing and the reranker sees 3 passages", ex.earlyExit && gfake.passages.length === 3 && !keysOf(ex, "graph").length && ex.stats.graph.ran === false && !ex.debug.pool.some((p) => p.partnerOf), JSON.stringify({ early: ex.earlyExit, n: gfake.passages.length, g: ex.stats.graph }));
gfake.cos = baseCos();

// 5. structural notes: a hub or concept page may seed, but is never a linked section or a partner
check(
  "hubs and concept pages are never linked sections or partners",
  ![forced, adm].some((r) => r.debug.pool.some((p) => (p.src === "graph" || p.partnerOf) && /^(Hubs|Concepts)\//.test(p.key))) && forced.debug.graph.candidates.some((c) => c.note === "Concepts/Backups.md" && ["structural", "listed"].includes(c.status)),
  JSON.stringify(forced.debug.graph.candidates.filter((c) => /^(Hubs|Concepts)\//.test(c.note))),
);

// 6. privacy and filters: an unreadable note is never considered, traced or quoted; a filtered one only traced
const pol = await grun({}, { ...ON, swapWeight: 100, linksPerSeed: 10 }, { readable: (n) => !n.id.startsWith("Private/") });
const seen = JSON.stringify(pol.debug.pool) + JSON.stringify(pol.debug.graph) + gfake.passages.join("\n") + JSON.stringify(pol.sections.map((x) => x.why));
// (Its name may appear inside a readable note's own sentence, which the caller can read anyway.)
check("a note the caller may not read never shows up in the graph step", !seen.includes("Private/") && !seen.includes("Secret key material"), seen.match(/.{40}(Private\/|Secret key).{40}/)?.[0] ?? "");
const proj = await grun({}, { ...ON, swapWeight: 100, linksPerSeed: 10 }, { project: "Ledger hub" });
check("a note outside the search's filters is only traced as filtered", !proj.debug.pool.some((p) => p.key.startsWith("Other/")) && proj.debug.graph.candidates.some((c) => c.note === "Other/Off note.md" && c.status === "filtered"), JSON.stringify(proj.debug.graph.candidates.map((c) => [c.note, c.status])));

// 7. coverage: linked sections never turn "none" into an answer, or "thin" into "good"
gfake.prob = (p) => (p.startsWith("Linked from") ? 0.9 : 0.001);
const none = await grun({}, ON);
check("a refused question stays refused, however well a linked section scores", none.coverage === "none" && none.sections.length === 0, `${none.coverage} ${none.sections.length}`);
gfake.cos = { ...baseCos(), [`${S}#0`]: 0.99 };
const ov = await grun({ agreeOverride: true, earlyExit: false }, on);
check("on the agreeOverride path linked sections are cut at the floor", ov.coverage === "thin" && ov.debug.pool.filter((p) => p.src === "graph").every((p) => p.cut === "floor") && !ov.sections.some((x) => x.note_id === T), JSON.stringify({ c: ov.coverage, g: ov.debug.pool.filter((p) => p.src === "graph") }));
gfake.cos = baseCos();
gfake.prob = (p) => (p.startsWith("Linked from") ? 0.99 : 0.2);
const thin = await grun({}, ON);
check("coverage and the best probability come from the lists' rows", thin.coverage === "thin" && thin.stats.topProb === 0.2 && thin.stats.graph.topProb === 0.99, JSON.stringify({ c: thin.coverage, p: thin.stats.topProb, g: thin.stats.graph }));

// 8. cuts: a linked section under the floor is cut there without cutting later rows, and never uses up minKeep
gfake.prob = (p) => (p.startsWith("Linked from") ? 0.015 : 0.5);
const fl = await grun({}, ON);
const cutsOff = Object.fromEntries((await grun()).debug.pool.map((p) => [p.key, p.cut]));
check(
  "a linked section under the floor is cut at the floor; the lists' rows keep their cuts",
  fl.debug.pool.find((p) => p.src === "graph")?.cut === "floor" && fl.debug.pool.filter((p) => p.src !== "graph").every((p) => p.cut === cutsOff[p.key] || p.key === adm.debug.graph.displaced[0].key),
  JSON.stringify(fl.debug.pool.map((p) => [p.src, p.cut])),
);
gfake.prob = (p) => (p.startsWith("Linked from") ? 0.9 : p.startsWith("Filler") ? 0.001 : 0.6);
const mk = await grun({}, ON);
const keptBase = mk.debug.pool.filter((p) => p.src !== "graph" && p.cut === "kept").length;
const keptBaseOff = (await grun()).debug.pool.filter((p) => p.cut === "kept").length;
check("a kept linked section does not use up minKeep", keptBase >= Math.min(grc.minKeep, keptBaseOff), `${keptBase} vs ${keptBaseOff}`);

// 9. the prefix: none for a frontmatter-only link, none at all with prefix off
gfake.prob = () => 0.5;
gfake.cos = { ...baseCos(), [T]: 0.01, [R]: 0.555 };
const fmOnly = await grun({}, { ...ON, swapWeight: 100, minWeight: 0.2 });
const rRow = fmOnly.debug.pool.find((p) => p.key.startsWith(R));
check("a link only in frontmatter gives the reranker no linking sentence", rRow?.src === "graph" && rRow.graph.prefixed === false, JSON.stringify(rRow));
gfake.cos = baseCos();
await grun({}, { ...ON, prefix: false });
check("with prefix off no passage gets a linking sentence", !gfake.passages.some((p) => /^(Linked from|Links to) /.test(p)), gfake.passages.find((p) => /^Link/.test(p)) ?? "");

// 10. link selection: the link floor, the per-seed cap, and no note twice
const mw = await grun({}, { ...ON, swapWeight: 100, minWeight: 0.35, linksPerSeed: 10 });
check("links under minWeight are not followed", !mw.debug.graph.candidates.some((c) => c.note === R), JSON.stringify(mw.debug.graph.candidates.map((c) => [c.note, c.strength])));
const cap = await grun({}, { ...ON, swapWeight: 100, linksPerSeed: 1 });
const perSeed = {};
for (const c of cap.debug.graph.candidates.filter((c) => c.status !== "cap" && c.score !== undefined)) perSeed[c.seed] = (perSeed[c.seed] ?? 0) + 1;
check("linksPerSeed caps the links taken from each seed", Object.values(perSeed).every((n) => n <= 1), JSON.stringify(perSeed));
const noteOfKey = (k) => k.slice(0, k.lastIndexOf("#"));
check(
  "a note already in the shortlist is never added again",
  forced.debug.pool.some((p) => p.src === "graph") && !forced.debug.pool.some((p, i, a) => p.src === "graph" && a.some((q, j) => j !== i && noteOfKey(q.key) === noteOfKey(p.key))),
  JSON.stringify(forced.debug.pool.map((p) => [p.src, p.key])),
);

// 11. the linked keep: a trimmed section a kept hit links to is kept last
gfake.cos = { ...baseCos(), [T]: 0.01 };
gfake.prob = (p) => (p.startsWith("Ledger member") ? 0.001 : p.startsWith("Filler") ? 0.001 : 0.6);
const keepOff = await grun();
const mRowOff = keepOff.debug.pool.find((p) => p.key.startsWith(M));
check("(setup) the member note is trimmed with the graph off", mRowOff?.cut === "trim", JSON.stringify(keepOff.debug.pool.map((p) => [p.key, p.cut])));
const keep = await grun({}, ON);
const last = keep.sections.at(-1);
check("a trimmed section a kept hit links to is kept last, as its link partner", last?.note_id === M && last.why.includes("link partner of Ledger hub") && keep.debug.pool.find((p) => p.key.startsWith(M))?.partnerOf === HUB && keep.coverage === keepOff.coverage, JSON.stringify({ last: last?.note_id, why: last?.why, cov: [keep.coverage, keepOff.coverage] }));
const noKeep = [await grun({}, { ...ON, keepLinked: 0 }), await grun({}, { ...ON, keepMinWeight: 0.35 })];
check("no partner with keepLinked 0, or a link weaker than keepMinWeight", noKeep.every((r) => !r.sections.some((x) => x.note_id === M)), JSON.stringify(noKeep.map((r) => r.sections.map((x) => x.note_id))));
gfake.cos = baseCos();
gfake.prob = () => 0.5;

// 12. models unavailable: keyword ranking, the same with the graph on or off
gfake.ready = async () => false;
const lexOff = await grun();
const lexOn = await grun({}, ON);
check("with the models off the graph changes nothing", lexOn.coverage === "lexical" && JSON.stringify(lexOn.sections) === JSON.stringify(lexOff.sections), lexOn.coverage);
gfake.ready = async () => true;

// 13. repeatability: forced in, twice, identical
const once = await grun({}, { ...ON, swapWeight: 100 });
const twice = await grun({}, { ...ON, swapWeight: 100 });
const noMs = (r) => JSON.stringify({ ...r, ms: 0, stats: { ...r.stats, graph: { ...r.stats.graph, ms: 0 } } });
check("two runs with the graph on are identical", noMs(once) === noMs(twice), "differs");

await gi.close();
fs.rmSync(G_ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall ranking checks passed");
process.exit(failed ? 1 : 0);
