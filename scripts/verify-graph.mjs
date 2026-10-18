// Verifies the link graph on a throwaway vault in the OS temp folder: where each link sits (sentence, list, table,
// heading, frontmatter, generated trailer, also with CRLF line ends), code and attachments skipped (fences closed the
// CommonMark way), every way of writing a target resolving ([[Folder/Note]], [[Note.md]], [[Note#H]], [[a\|b]] in a
// table, [[github-account]] for "github account", odd whitespace, code in a title), duplicate names resolving the same
// way every time in the graph and in the tools, links re-pointing after a note changes, links landing in the window
// that holds them (repeated lines, code copies, hard cuts), and link names like "constructor". Needs no models.
// Run after `npm run build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";
import { extractLinks, parseNote } from "../dist/vault/parse.js";
import { fairSwap, graphPrefix, linkedPartners, protectedKeys, selectGraphPicks } from "../dist/vault/graph-select.js";
import { clampGraph, GRAPH_DEFAULTS } from "../dist/vault/graph.js";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- where a link sits
const kinds = (body, fm = {}) => extractLinks(body, fm).map((o) => `${o.kind}${o.fmKey ? ":" + o.fmKey : ""}=${o.target}`).join(" ");
check("a sentence with words around the link", kinds("Part of [[Alpha]]; used by [[Beta]] every night.") === "sentence=Alpha sentence=Beta", kinds("Part of [[Alpha]]; used by [[Beta]] every night."));
check("a short line", kinds("See [[Alpha]].") === "short=Alpha", kinds("See [[Alpha]]."));
check("an explained list item", kinds("- The restore steps are in [[Alpha]].") === "list_explained=Alpha", kinds("- The restore steps are in [[Alpha]]."));
check("a bare list item", kinds("- [[Alpha]] — 2026-01-01 · [[Beta]]") === "list_bare=Alpha list_bare=Beta", kinds("- [[Alpha]] — 2026-01-01 · [[Beta]]"));
check("three links in a row are a generated enumeration", kinds("It draws on [[A]], [[B]] and [[C]].") === "list_bare=A list_bare=B list_bare=C", kinds("It draws on [[A]], [[B]] and [[C]]."));
check("a heading", kinds("## Built on [[Alpha]]") === "heading=Alpha");
check("a table row, escaped pipe", kinds("| x | [[Alpha\\|the alpha]] |") === "table=Alpha", kinds("| x | [[Alpha\\|the alpha]] |"));
check("code and attachments are not links", kinds("```\n[[Ghost]]\n```\nUse `[[Inline]]` and ![[pic.png]] but ![[Alpha]] in this long sentence here.") === "embed=Alpha", kinds("```\n[[Ghost]]\n```\nUse `[[Inline]]` and ![[pic.png]] but ![[Alpha]] in this long sentence here."));
check("the generated trailer", kinds("Body links [[A]] in a sentence of words.\n\n---\n\n## Connections\n\nThis is a note in [[Hub]].") === "sentence=A trailer=Hub");
check(
  "frontmatter: any key with [[links]], plain strings for the link keys",
  kinds("x", { topics: ["[[Python]]"], related: ["Plain One"], project: "[[Hub]]", "appears-in": ["[[X]]"], tags: ["t"] }) === "fm:topics=Python fm:related=Plain One fm:project=Hub fm:appears-in=X",
  kinds("x", { topics: ["[[Python]]"], related: ["Plain One"], project: "[[Hub]]", "appears-in": ["[[X]]"], tags: ["t"] }),
);
const ctx = extractLinks("The fingerprint check described in [[Harbor Ledger progress|the progress note]] makes it safe. Next sentence.", {})[0].ctx;
check("the sentence is kept, link shown as its alias", ctx === "The fingerprint check described in the progress note makes it safe.", ctx);
const trailerBody = (eol) => [...Array.from({ length: 40 }, (_, i) => `Line ${i} of plain text.`), "", "---", "", "## Connections", "", "This is a note in [[Hub]]. Related: [[A]], [[B]] and [[C]].", ""].join(eol);
check("CRLF line ends: the generated trailer is still the trailer", kinds(trailerBody("\r\n")) === "trailer=Hub trailer=A trailer=B trailer=C" && kinds(trailerBody("\n")) === kinds(trailerBody("\r\n")), kinds(trailerBody("\r\n")));
check(
  "code inside a link's brackets is part of the name; a link inside code is not a link",
  kinds("- [[`brain_search` tool]] — 2026-10-01\nThe [[v2 `--force` flag notes]] explain it, unlike `[[Inline]]` here.") === "list_bare=`brain_search` tool sentence=v2 `--force` flag notes",
  kinds("- [[`brain_search` tool]] — 2026-10-01\nThe [[v2 `--force` flag notes]] explain it, unlike `[[Inline]]` here."),
);
const fmKinds = (yaml) => kinds("x", parseNote("Notes/F.md", `---\n${yaml}\n---\nx\n`, new Date()).frontmatter);
check("frontmatter: unquoted [[X]] in the link keys still links", fmKinds("related: [[Alpha]]\ntopics:\n  - [[Python]]\nproject: [[Brain MCP]]") === "fm:related=Alpha fm:topics=Python fm:project=Brain MCP", fmKinds("related: [[Alpha]]\ntopics:\n  - [[Python]]\nproject: [[Brain MCP]]"));
check("frontmatter: a mixed string and numbers, as before", kinds("x", { topics: "[[Python]], FastAPI", related: [2026] }) === "fm:topics=Python fm:topics=FastAPI fm:related=2026", kinds("x", { topics: "[[Python]], FastAPI", related: [2026] }));
const parsedLinks = parseNote("Notes/F.md", "---\nrelated: [[Alpha]]\ntopics: \"[[Python]], FastAPI\"\n---\nBody.\n", new Date()).links;
check("frontmatter links reach brain_graph's link list", JSON.stringify(parsedLinks) === JSON.stringify(["Alpha", "Python", "FastAPI"]), JSON.stringify(parsedLinks));
const strayFence = "Intro links [[Alpha]] in a sentence.\n\n```js\ncode\n```\n```\n\n## Next\n\n```python\nprint(1)\n```\n\n## Last\n\nThe restore steps live in [[Gamma]] for everyone.\n\n---\n\n## Connections\n\nThis is a note in [[Hub]].";
check("a fence with an info string does not close a block (one stray fence hides nothing after it)", kinds(strayFence) === "sentence=Alpha sentence=Gamma trailer=Hub", kinds(strayFence));
check("nested fences: a shorter or different fence inside a block stays code", kinds("````\n```\n[[Ghost]]\n```\n````\n~~~\n```\n[[Ghost2]]\n~~~\nAfter the blocks [[Alpha]] is linked in a sentence.") === "sentence=Alpha", kinds("````\n```\n[[Ghost]]\n```\n````\n~~~\n```\n[[Ghost2]]\n~~~\nAfter the blocks [[Alpha]] is linked in a sentence."));
const headed = extractLinks("| a | [[Beta#Setup\\|b]] |", {})[0];
check("a table link to a heading, escaped pipe: the heading has no backslash", headed?.target === "Beta" && headed?.heading === "Setup", JSON.stringify(headed));
const embedLine = `${Array.from({ length: 50 }, (_, i) => `[[Some Long Target Name ${i}|t${i}]]`).join(" ")} see ![[Restore Flow]]${" and then a long explanation follows".repeat(12)}`;
const embed = extractLinks(embedLine, {}).find((o) => o.kind === "embed");
check("an embed's sentence on a long line holds the embed", embed?.ctx?.includes("Restore Flow"), embed?.ctx);

// ---------------------------------------------------------------- choosing linked sections for the ranker
const mkNb = (id, strength, dir = "out", occs = [{ pos: 0, ord: 0, kind: "sentence", weight: 1 }], kind = "sentence") => ({ id, dir, strength, kind, from: dir === "out" ? "S" : id, pos: 0, fromOrd: 0, heading: null, occs });
const seed = (note, score = 1, title = note) => ({ note, key: `${note}#0`, title, score });
const pick = (note, score, extra = {}) => ({ note, key: `${note}#0`, ord: 0, fit: 1, score, seed: seed("S"), nb: mkNb(note, 1), ...extra });
{
  const head = [1, 0.9, 0.8, 0.5, 0.4, 0.3].map((sc, i) => ({ key: `H${i}`, score: sc }));
  const sw = fairSwap({ head, picks: [pick("A", 0.35), pick("B", 0.3)], fusedTop: 1, protect: new Set(), swapWeight: 1 });
  check("fair swap: a pick takes the weakest place it beats; the next, weaker than the next place, is beaten", sw.admitted.map((g) => g.note).join() === "A" && sw.displaced[0].fusedRank === 6 && sw.beaten.map((g) => g.note).join() === "B", JSON.stringify(sw));
  check("fair swap: a pick equal to the place is beaten", fairSwap({ head, picks: [pick("A", 0.3)], fusedTop: 1, protect: new Set(), swapWeight: 1 }).admitted.length === 0);
  const prot = fairSwap({ head, picks: [pick("A", 0.45)], fusedTop: 1, protect: new Set(["H5"]), swapWeight: 1 });
  check("fair swap: a protected place is skipped, so the pick meets the next one up", prot.displaced[0]?.key === "H4", JSON.stringify(prot.displaced));
  const all = fairSwap({ head, picks: [pick("A", 9), pick("B", 8), pick("C", 7), pick("D", 6)], fusedTop: 1, protect: new Set(), swapWeight: 100 });
  check("fair swap: the top 3 places are never taken", all.displaced.every((d) => d.fusedRank > 3) && all.admitted.length === 3 && all.noSlot.map((g) => g.note).join() === "D", JSON.stringify(all.displaced));
  const none = fairSwap({ head, picks: [pick("A", 9)], fusedTop: 1, protect: new Set(["H3", "H4", "H5"]), swapWeight: 1 });
  check("fair swap: with every place protected the picks get no slot", none.noSlot.length === 1 && !none.admitted.length);
}
{
  const nbs = { S1: [mkNb("A", 0.9), mkNb("Hidden", 0.8), mkNb("Listed", 0.7), mkNb("Hub", 0.6), mkNb("Off", 0.5), mkNb("NoVec", 0.45), mkNb("B", 0.4), mkNb("C", 0.3), mkNb("Weak", 0.1)], S2: [mkNb("A", 1), mkNb("D", 0.5)] };
  const access = (id) => (id === "Hidden" ? "hidden" : id === "Off" ? "filtered" : "ok");
  const sel = selectGraphPicks({ seeds: [seed("S1", 1), seed("S2", 0.5)], neighbours: (id) => nbs[id] ?? [], isStructural: (id) => id === "Hub", access, listed: new Set(["Listed"]), bestWindow: (id) => (id === "NoVec" ? undefined : { ord: 0, cos: 0.5 }), minWeight: 0.2, linksPerSeed: 2, max: 2 });
  const st = (note) => sel.trace.filter((t) => t.note === note).map((t) => t.status).join();
  check(
    "selection: the link floor, hidden notes untraced, listed / structural / filtered / no-vector traced, the per-seed cap",
    !sel.trace.some((t) => t.note === "Hidden" || t.note === "Weak") && st("Listed") === "listed" && st("Hub") === "structural" && st("Off") === "filtered" && st("NoVec") === "no-vector" && st("C") === "cap",
    JSON.stringify(sel.trace.map((t) => [t.note, t.status])),
  );
  check("selection: a note reached twice keeps its best score (the earlier seed on a tie), best first, then no-slot", sel.picks.map((g) => `${g.note}:${g.seed.note}`).join() === "A:S1,B:S1" && sel.overflow.map((g) => g.note).join() === "D" && st("D") === "no-slot", JSON.stringify({ picks: sel.picks.map((g) => [g.note, g.seed.note, g.score]), over: sel.overflow.map((g) => g.note) }));
}
{
  const p = protectedKeys({ lex: ["a", "b", "c", "d"], den: ["e", "f", "g", "d"], exact: ["x"], note: ["h"] }, ["s"], ["a", "d", "z", "x"]);
  check("protected: each list's top 3, exact-date hits, seeds, and entries both kinds of list rank in the top 10", ["a", "b", "c", "e", "f", "g", "h", "x", "s", "d"].every((k) => p.has(k)) && !p.has("z"), JSON.stringify([...p]));
}
{
  const ctx = (from, pos) => ({ "S:0": "The restore steps live in Restore runbook and nowhere else.", "S:3": "Second mention of Restore runbook here.", "N:1": "This builds on Seed for the nightly restore." })[`${from}:${pos}`] ?? null;
  const heading = (note, ord) => ({ "S:0": "Seed", "S:2": "Retention" })[`${note}:${ord}`] ?? null;
  const occs = [{ pos: 0, ord: 0, kind: "sentence", weight: 1 }, { pos: 3, ord: 2, kind: "sentence", weight: 1 }];
  const out = (cos) => graphPrefix({ ...pick("T", 1), seed: seed("S", 1, "Seed"), nb: mkNb("T", 1, "out", occs) }, { windowCos: cos, ctx, heading });
  check("prefix: an out-link from the seed's title window", out((k) => (k === "S#0" ? 0.9 : 0.1)) === "Linked from Seed: The restore steps live in Restore runbook and nowhere else.", out((k) => (k === "S#0" ? 0.9 : 0.1)));
  check("prefix: an out-link from a headed window, chosen by the window closest to the question", out((k) => (k === "S#2" ? 0.9 : 0.1)) === "Linked from Seed / Retention: Second mention of Restore runbook here.", out((k) => (k === "S#2" ? 0.9 : 0.1)));
  const inl = (ord) => graphPrefix({ ...pick("N", 1), ord, seed: seed("S", 1, "Seed"), nb: mkNb("N", 1, "in", [{ pos: 1, ord: 1, kind: "sentence", weight: 1 }]) }, { windowCos: () => 0, ctx, heading });
  check("prefix: an in-link, and none when the chosen window already holds the sentence", inl(0) === "Links to Seed: This builds on Seed for the nightly restore." && inl(1) === null, `${inl(0)} | ${inl(1)}`);
  check("prefix: none for a frontmatter-only link", graphPrefix({ ...pick("R", 1), seed: seed("S"), nb: mkNb("R", 0.3, "out", [{ pos: 5, ord: null, kind: "fm:related", weight: 0.3 }], "fm:related") }, { windowCos: () => 0, ctx, heading }) === null);
  const long = graphPrefix({ ...pick("T", 1), seed: seed("S", 1, "Seed"), nb: mkNb("T", 1, "out", [{ pos: 0, ord: 0, kind: "sentence", weight: 1 }]) }, { windowCos: () => 0, ctx: () => "x".repeat(300), heading: () => null });
  check("prefix: a long sentence is cut to 200 characters", long.length - "Linked from Seed: ".length === 200 && long.endsWith("…"), String(long?.length));
}
{
  const nbs = { K1: [mkNb("P", 0.5), mkNb("Hubby", 0.4), mkNb("Q", 0.3)], K2: [mkNb("P", 0.5), mkNb("Q", 0.35)] };
  const order = [
    { i: 0, note: "K1", cut: "kept", reranked: true, graph: false },
    { i: 1, note: "Q", cut: "trim", reranked: true, graph: false },
    { i: 2, note: "Hubby", cut: "trim", reranked: true, graph: false },
    { i: 3, note: "P", cut: "trim", reranked: true, graph: false },
    { i: 4, note: "P", cut: "trim", reranked: true, graph: false },
    { i: 5, note: "G", cut: "trim", reranked: true, graph: true },
  ];
  const lp = linkedPartners({ order, kept: ["K1", "K2"], neighbours: (id) => nbs[id] ?? [], isStructural: (id) => id === "Hubby", minWeight: 0.2, max: 5, room: 5 });
  check("partners: trimmed rows a kept note links to, in score order, the strongest anchor, structural notes and graph rows left out, each note once", JSON.stringify(lp.map((x) => [x.i, x.anchor])) === JSON.stringify([[1, "K2"], [3, "K1"]]), JSON.stringify(lp));
  check("partners: at most min(max, room)", linkedPartners({ order, kept: ["K1", "K2"], neighbours: (id) => nbs[id] ?? [], isStructural: () => false, minWeight: 0.2, max: 5, room: 1 }).length === 1);
}
{
  const c = clampGraph({ ...GRAPH_DEFAULTS, enabled: true, slots: Number("x"), seeds: -3, linksPerSeed: 99, swapWeight: 1e9, keepMinWeight: 0, prefix: undefined });
  check("graph settings out of range fall back or are clamped", c.slots === GRAPH_DEFAULTS.slots && c.seeds === 1 && c.linksPerSeed === 10 && c.swapWeight === 1000 && c.keepMinWeight === 0.01 && c.prefix === true && c.enabled === true, JSON.stringify(c));
}

// ---------------------------------------------------------------- resolution on a throwaway vault
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-graph-"));
const vault = path.join(ROOT, "vault");
const put = (rel, s) => (fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }), fs.writeFileSync(path.join(vault, rel), s));
const note = (title, body, extra = "") => `---\ntitle: "${title}"\ntype: note\n${extra}---\n# ${title}\n\n${body}\n`;
put("Notes/Alpha.md", note("Alpha", "The plan is in [[Folder/Gamma]] and the old one in [[Gamma.md]], see the setup in [[Beta#Setup]] for details. My account notes live in [[github-account]] today.\n\n| col | link |\n| --- | --- |\n| a | [[Beta\\|b]] |\n\nWaiting on [[Zeta Title]] before anything else happens here."));
put("Notes/Beta.md", note("Beta", "## Setup\n\nSteps go here."));
put("Folder/Gamma.md", note("Gamma", "In the folder."));
put("Other/Gamma.md", note("Gamma", "A second note with the same title."));
put("Folder/Delta.md", note("Delta", "This note in Folder links [[Gamma]] in a sentence of its own."));
put("Projects/X/Notes/github account.md", note("github account", "Handle and scopes."));
const filler = "word ".repeat(300).trim();
put("Notes/Long.md", note("Long", `${filler} and then [[Beta]] appears near the cut ${filler}`));
// A cut that lands on the space inside a link, and one at a block with no spaces where the link's "]]" sits at the cut.
put("Notes/Long2.md", note("Long2", `${"word ".repeat(238)}[[Beta Gamma]] ${"word ".repeat(200).trim()}`));
put("Notes/Long3.md", note("Long3", `${"y".repeat(1193)}[[Beta]]${"z".repeat(700)}`));
put("Notes/Beta Gamma.md", note("Beta Gamma", "Two words."));
// Windows: a repeated line, a copy of a link line inside code earlier in the note.
put("Notes/Week.md", note("Week", "## Monday\n\n- [[Standup]]\n\n## Tuesday\n\n- [[Standup]]\n\n## Notes\n\n```\n[[Runbook]] example\n```\n\n## Real\n\n[[Runbook]]"));
put("Notes/Standup.md", note("Standup", "Daily."));
put("Notes/Runbook.md", note("Runbook", "Steps."));
// The tools follow the same rules: a path that is a suffix of another note's path, a folder-qualified link to the
// copy that is not the default, a same-folder name, a slug.
put("Notes/Plan.md", note("Plan", "The current plan.", "modified: 2026-01-01\n"));
put("Archive/Notes/Plan.md", note("Old plan", "An archived copy.", "modified: 2026-10-01\n"));
put("Notes/Linker.md", note("Linker", "The current plan is written up in [[Notes/Plan]] for the whole team to read."));
put("Notes/Epsilon.md", note("Epsilon", "The second copy is [[Other/Gamma]], kept for the record by the team."));
put("Projects/Alpha/Overview.md", note("Overview", "We sign in with [[github-account]] first. Then follow [[Setup]] for the alpha box itself."));
put("Projects/Alpha/Setup.md", note("Setup", "Alpha setup.", "modified: 2026-01-01\n"));
put("Projects/Beta/Setup.md", note("Setup", "Beta setup.", "modified: 2026-09-01\n"));
// Names with odd whitespace next to their slug twins; link names that are Object.prototype keys; a trailer-only pair.
put("Notes/Foo  Bar.md", note("Foo  Bar", "Two spaces in the name."));
put("Notes/Foo-Bar.md", note("Foo-Bar", "A hyphen in the name."));
put("Notes/Menu\u00a0Plan.md", note("Menu\u00a0Plan", "A no-break space in the name."));
put("Notes/Menu_Plan.md", note("Menu_Plan", "An underscore in the name."));
put("Notes/Whitespace.md", note("Whitespace", "Links to [[Foo  Bar]] and to [[Menu\u00a0Plan]] and to [[Notes/Foo  Bar]] in one sentence."));
put("Notes/Proto.md", note("Proto", "The class has a [[constructor]] that runs first, and [[__proto__]] is not a note.", "topics: [Constructor]\nrelated: [\"[[__proto__]]\"]\n"));
put("Notes/Trail.md", note("Trail", "Body without links here.\n\n---\n\n## Connections\n\nThis is a note in [[Standup]]."));
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8")), vaultPath: "vault", dataDir: "data", retrieval: { hybrid: false } }));
process.env.BRAIN_MCP_LOG_DIR = path.join(ROOT, "logs");
const cfg = loadConfig(path.join(ROOT, "config.json"));
const index = new VaultIndex(cfg);
index.fullReindex();
const g = index.graph;
const res = (from, t) => g.resolve(from, t);
check("[[Folder/Gamma]] resolves by path", res("Notes/Alpha.md", "Folder/Gamma") === "Folder/Gamma.md", res("Notes/Alpha.md", "Folder/Gamma"));
const mdTarget = extractLinks("The old one is in [[Gamma.md]] for now.", {})[0]?.target;
check("[[Gamma.md]] resolves without the extension", mdTarget === "Gamma" && ["Folder/Gamma.md", "Other/Gamma.md"].includes(res("Notes/Alpha.md", mdTarget)), String(mdTarget));
check("[[github-account]] resolves to \"github account\"", res("Notes/Alpha.md", "github-account") === "Projects/X/Notes/github account.md", res("Notes/Alpha.md", "github-account"));
check("a duplicate name prefers the linking note's folder", res("Folder/Delta.md", "Gamma") === "Folder/Gamma.md", res("Folder/Delta.md", "Gamma"));
check("a duplicate name elsewhere goes to the shortest path, every time", res("Notes/Alpha.md", "Gamma") === "Other/Gamma.md" && res("Notes/Alpha.md", "Gamma") === res("Notes/Alpha.md", "Gamma"), res("Notes/Alpha.md", "Gamma"));
const nb = g.neighbours("Notes/Alpha.md");
const toBeta = nb.find((n) => n.id === "Notes/Beta.md");
check("neighbours: the strongest occurrence carries the link", toBeta && toBeta.kind === "sentence" && toBeta.heading === "Setup", JSON.stringify(toBeta));
const toR = g.neighbours("Notes/Alpha.md").find((n) => n.id === "Projects/X/Notes/github account.md");
check("neighbours list every occurrence that carries a link, with its window", Array.isArray(toBeta?.occs) && toBeta.occs.length === 2 && toBeta.occs.every((o) => o.ord !== null) && toR?.occs.length === 1, JSON.stringify({ beta: toBeta?.occs, r: toR?.occs }));
check("unresolved targets are reported, not dropped silently", g.stats().unresolved.some(([t]) => t === "zeta title"), JSON.stringify(g.stats().unresolved));
const outOf = (id) => index.outgoing(id).map((l) => [l.target, l.note?.id ?? null]);
const backOf = (id) => index.backlinks(id).map((n) => n.id);
check(
  "the tools resolve a folder-qualified link to the copy it names",
  outOf("Notes/Epsilon.md").some(([, id]) => id === "Other/Gamma.md") && backOf("Other/Gamma.md").includes("Notes/Epsilon.md") && !backOf("Folder/Gamma.md").includes("Notes/Epsilon.md"),
  JSON.stringify({ out: outOf("Notes/Epsilon.md"), back: backOf("Folder/Gamma.md") }),
);
check(
  "[[Notes/Plan]] is Notes/Plan.md, not a deeper Archive/Notes/Plan.md, in the tools too",
  outOf("Notes/Linker.md").some(([, id]) => id === "Notes/Plan.md") && !backOf("Archive/Notes/Plan.md").includes("Notes/Linker.md") && index.resolve("notes/plan")?.id === "Notes/Plan.md",
  JSON.stringify({ out: outOf("Notes/Linker.md"), back: backOf("Archive/Notes/Plan.md"), resolve: index.resolve("notes/plan")?.id }),
);
check(
  "the tools prefer the linking note's folder and fold hyphens, like the graph",
  JSON.stringify(outOf("Projects/Alpha/Overview.md")) === JSON.stringify([["github-account", "Projects/X/Notes/github account.md"], ["setup", "Projects/Alpha/Setup.md"]]),
  JSON.stringify(outOf("Projects/Alpha/Overview.md")),
);
check(
  "names with double, no-break and folder-qualified whitespace resolve to themselves, not a slug twin",
  res("Notes/Whitespace.md", "Foo  Bar") === "Notes/Foo  Bar.md" && res("Notes/Whitespace.md", "Menu\u00a0Plan") === "Notes/Menu\u00a0Plan.md" && res("Notes/Whitespace.md", "Notes/Foo  Bar") === "Notes/Foo  Bar.md" && res("Notes/Alpha.md", "Notes/github-account") === "Projects/X/Notes/github account.md",
  JSON.stringify([res("Notes/Whitespace.md", "Foo  Bar"), res("Notes/Whitespace.md", "Menu\u00a0Plan"), res("Notes/Whitespace.md", "Notes/Foo  Bar"), res("Notes/Alpha.md", "Notes/github-account")]),
);
let protoErr = null;
try {
  g.stats();
  g.neighbours("Notes/Proto.md");
  await index.rankSections("constructor __proto__");
} catch (e) {
  protoErr = e.message;
}
check("a link or query named \"constructor\" or \"__proto__\" is just an unknown name", !protoErr && res("Notes/Proto.md", "constructor") === null, protoErr ?? res("Notes/Proto.md", "constructor"));
const trailOnly = g.neighbours("Notes/Trail.md").find((n) => n.id === "Notes/Standup.md");
check("a pair linked only in the trailer keeps its kind", trailOnly?.kind === "trailer" && trailOnly.strength === 0, JSON.stringify(trailOnly));
// a note appears: the dangling link re-points on the next use
put("Notes/Zeta.md", note("Zeta Title", "Now it exists."));
index.upsertFile(path.join(vault, "Notes/Zeta.md"));
check("a new note re-points a dangling link", res("Notes/Alpha.md", "Zeta Title") === "Notes/Zeta.md" && g.neighbours("Notes/Alpha.md").some((n) => n.id === "Notes/Zeta.md"), res("Notes/Alpha.md", "Zeta Title"));
// a long paragraph is cut hard; the link must sit whole in one window, and its edge must point at that window
const longSecs = index.sectionsOf("Notes/Long.md");
const holder = longSecs.filter((s) => s.text.includes("[[Beta]]"));
const edge = index.db.prepare("SELECT from_ord FROM edges WHERE from_id = ? AND target = ?").get("Notes/Long.md", "Beta");
check("the link's edge points at the window that holds it", edge && holder[0] && edge.from_ord === holder[0].ord, JSON.stringify({ edge, holder: holder.map((s) => s.ord) }));
const whole = (id, link) => {
  const secs = index.sectionsOf(id);
  return secs.length > 1 && secs.filter((s) => s.text.includes(link)).length === 1 && !secs.some((s) => /\[\[[^\]]*$/.test(s.text) || /^[^[]*\]\]/.test(s.text));
};
const cutWins = (id) => index.sectionsOf(id).map((s) => s.text.length).join(",");
check("a hard cut on the space inside a link moves before the link", whole("Notes/Long2.md", "[[Beta Gamma]]"), cutWins("Notes/Long2.md"));
check("a hard cut with no space to cut at, the link's ]] at the cut, moves before the link", whole("Notes/Long3.md", "[[Beta]]"), cutWins("Notes/Long3.md"));
const ords = (id) => index.db.prepare("SELECT target, from_ord FROM edges WHERE from_id = ? ORDER BY pos").all(id);
const secOrd = (id, heading) => index.sectionsOf(id).find((s) => s.heading === heading)?.ord;
const week = ords("Notes/Week.md");
check(
  "a repeated line, and a code copy before a link, do not pull the link into an earlier window",
  JSON.stringify(week) === JSON.stringify([{ target: "Standup", from_ord: secOrd("Notes/Week.md", "Monday") }, { target: "Standup", from_ord: secOrd("Notes/Week.md", "Tuesday") }, { target: "Runbook", from_ord: secOrd("Notes/Week.md", "Real") }]),
  JSON.stringify({ week, sections: index.sectionsOf("Notes/Week.md").map((s) => [s.ord, s.heading]) }),
);
// rebuilding from scratch gives the same graph
const before = JSON.stringify(g.neighbours("Notes/Alpha.md"));
index.fullReindex();
check("a full reindex gives the same graph", JSON.stringify(g.neighbours("Notes/Alpha.md")) === before);

await index.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall graph checks passed");
process.exit(failed ? 1 : 0);
