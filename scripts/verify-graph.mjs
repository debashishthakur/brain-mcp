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
