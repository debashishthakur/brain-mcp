// Verifies the importers (scripts/import): Logseq, Notion and plain Markdown samples are converted into notes
// the server reads, links between them resolve in the server's own link graph, nothing in the source is
// touched, a second run skips what exists, --force replaces it, and --dry-run writes nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = path.join(ROOT, "scripts", "import", "import.mjs");
const SAMPLE = path.join(ROOT, "scripts", "import", "sample");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "brain-import-"));
const vault = path.join(TMP, "vault");
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
};
const run = (...args) => spawnSync("node", [IMPORT, ...args], { encoding: "utf8" });
const read = (rel) => fs.readFileSync(path.join(vault, rel), "utf8");
const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : "/"].join("\n"))
    .join("\n--\n");

try {
  const before = snapshot(SAMPLE);

  // 1. Each importer runs on its sample
  const lg = run("logseq", path.join(SAMPLE, "logseq"), "--to", vault, "--into", "Logseq", "--project", "Harbour Project");
  const nt = run("notion", path.join(SAMPLE, "notion"), "--to", vault, "--into", "Notion");
  const md = run("markdown", path.join(SAMPLE, "markdown"), "--to", vault, "--into", "Markdown");
  check("logseq import exits cleanly", lg.status === 0, lg.stderr);
  check("notion import exits cleanly", nt.status === 0, nt.stderr);
  check("markdown import exits cleanly", md.status === 0, md.stderr);
  check("the source samples are untouched", snapshot(SAMPLE) === before);

  // 2. Logseq
  const tidal = read("Logseq/Pages/Tidal Notes.md");
  check("logseq: properties become frontmatter", tidal.includes('title: "Tidal Notes"') && tidal.includes('  - "tide notes"') && tidal.includes('  - "[[sailing]]"') && tidal.includes('public: "true"'), tidal.slice(0, 300));
  check("logseq: --project puts notes in the project", tidal.includes('project: "[[Harbour Project]]"'));
  check("logseq: tags, tasks and labelled links are converted", tidal.includes("[[boat work]]") && tidal.includes("- [ ] Check the bilge pump") && tidal.includes("- [x] Order charts") && tidal.includes("[[Projects/Harbour budget|the budget]]"));
  check("logseq: block references, queries and block properties are dropped", !/\(\([0-9a-f]/.test(tidal) && !tidal.includes("{{query") && !tidal.includes("id::"));
  check("logseq: code is left alone", tidal.includes("[[not a link]] #nottag"));
  check("logseq: a namespaced file keeps its title", read("Logseq/Pages/Projects Harbour budget.md").includes('title: "Projects/Harbour budget"'));
  check("logseq: a journal gets its date and Logseq's link text", read("Logseq/Journals/2026-09-23.md").includes('modified: "2026-09-23"') && read("Logseq/Journals/2026-09-23.md").includes('"Sep 23rd, 2026"'));
  check("logseq: the report counts what was dropped", /block references dropped/.test(lg.stdout) && /macros and queries dropped/.test(lg.stdout), lg.stdout);

  // 3. Notion
  const budget = read("Notion/Harbour Hub/Refit budget.md");
  check("notion: IDs are gone from names and the folder keeps its shape", fs.existsSync(path.join(vault, "Notion", "Harbour Hub.md")) && fs.existsSync(path.join(vault, "Notion", "Meeting notes.md")));
  check("notion: property lines become frontmatter", budget.includes('modified: "2026-09-24"') && budget.includes('status: "In progress"') && budget.includes('  - "[[boat]]"'), budget.slice(0, 300));
  check("notion: a subpage points at its parent", budget.includes('part-of:\n  - "[[Harbour Hub]]"'));
  check("notion: page links become wikilinks", read("Notion/Harbour Hub.md").includes("[[Refit budget]]") && read("Notion/Harbour Hub.md").includes("[[Meeting notes]]") && budget.includes("[[Harbour Hub]]"));
  check("notion: external links, missing pages and code are handled", read("Notion/Harbour Hub.md").includes("[manual](https://example.com/manual)") && read("Notion/Harbour Hub.md").includes("A deleted page: Gone page.") && read("Notion/Harbour Hub.md").includes("[kept as code](Meeting%20notes"));
  check("notion: database tables are reported as skipped", /database tables skipped/.test(nt.stdout), nt.stdout);

  // 4. Markdown
  const seeds = read("Markdown/plants/seeds.md");
  check("markdown: folders and file names are kept", fs.existsSync(path.join(vault, "Markdown", "README.md")) && fs.existsSync(path.join(vault, "Markdown", "plants", "seeds.md")));
  check("markdown: own frontmatter is kept and topics are added", seeds.includes('title: "Seed Calendar"') && seeds.includes("updated:") && seeds.includes('  - "[[garden]]"') && seeds.includes('modified: "2026-09-01"'), seeds.slice(0, 300));
  check("markdown: relative links become wikilinks, others stay", read("Markdown/README.md").includes("[[Seed Calendar|seed calendar]]") && read("Markdown/README.md").includes("[missing page](nope.md)") && read("Markdown/README.md").includes("[kept as code](plants/seeds.md)"));
  check("markdown: broken frontmatter does not stop the import", read("Markdown/broken.md").includes("worth keeping") && !read("Markdown/broken.md").includes("[unclosed"));

  // 5. The server reads them and the links resolve in its own graph
  const cfgPath = path.join(TMP, "brain.config.json");
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "brain.config.json"), "utf8"));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...base, vaultPath: "./vault", dataDir: "./data", owner: "Importer Check", identity: { ...base.identity, profileNote: "Harbour Project" } }));
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(ROOT, "dist", "index.js"), "--stdio", "--config", cfgPath],
    stderr: "pipe",
    env: { ...process.env, BRAIN_MCP_HYBRID: "0", BRAIN_MCP_LOG_DIR: path.join(TMP, "logs") },
  });
  const client = new Client({ name: "verify-import", version: "0.0.1" });
  await client.connect(transport);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");
  // brain_read lists only the links that resolve to a note, so this fails for a link written in a form the server cannot follow.
  const links = (text) => (/^links: (.*)$/m.exec(text) ?? [, ""])[1].split(", ");
  const hub = await call("brain_read", { note: "Harbour Hub" });
  check("server: Notion links resolve", links(hub).includes("Refit budget") && links(hub).includes("Meeting notes"), hub.slice(0, 400));
  const backlinks = await call("brain_graph", { note: "Refit budget" });
  check("server: the subpage links back to its parent", backlinks.includes("Harbour Hub"), backlinks.slice(0, 400));
  const journal = await call("brain_read", { note: "2026-09-22" });
  check("server: a Logseq journal link resolves through its alias", links(journal).includes("2026-09-23"), journal.slice(0, 400));
  const ns = await call("brain_read", { note: "Tidal Notes" });
  check("server: a link to a namespaced page resolves", links(ns).includes("Projects/Harbour budget") && /project: Harbour Project/.test(ns), ns.slice(0, 400));
  const seedsRead = await call("brain_read", { note: "Seed Calendar" });
  check("server: Markdown links resolve and topics are read", links(seedsRead).includes("Garden Journal") && /topics: garden, planning/.test(seedsRead), seedsRead.slice(0, 400));
  const found = await call("brain_search", { query: "engine service before sails" });
  check("server: imported text is searchable", found.includes("Meeting notes"), found.slice(0, 300));
  await client.close();

  // 6. Safe to repeat, safe to preview
  const again = run("notion", path.join(SAMPLE, "notion"), "--to", vault, "--into", "Notion");
  check("a second run skips what already exists", again.status === 0 && /skipped 3 that already exist/.test(again.stdout), again.stdout);
  const edited = path.join(vault, "Notion", "Meeting notes.md");
  fs.appendFileSync(edited, "\nMy own edit.\n");
  run("notion", path.join(SAMPLE, "notion"), "--to", vault, "--into", "Notion");
  check("a re-run keeps your edits", read("Notion/Meeting notes.md").includes("My own edit."));
  run("notion", path.join(SAMPLE, "notion"), "--to", vault, "--into", "Notion", "--force");
  check("--force replaces them", !read("Notion/Meeting notes.md").includes("My own edit."));
  const dry = path.join(TMP, "dry");
  const d = run("logseq", path.join(SAMPLE, "logseq"), "--to", dry, "--dry-run");
  check("--dry-run reports and writes nothing", d.status === 0 && /Would write 5 note/.test(d.stdout) && !fs.existsSync(dry), d.stdout);

  // 7. Bad input
  const inside = run("markdown", path.join(SAMPLE, "markdown"), "--to", path.join(SAMPLE, "markdown", "out"));
  check("a vault inside the source is refused", inside.status === 1 && /must not be inside/.test(inside.stderr) && !fs.existsSync(path.join(SAMPLE, "markdown", "out")), inside.stderr);
  const wrong = run("logseq", path.join(SAMPLE, "markdown"), "--to", path.join(TMP, "x"));
  check("a folder that is not a Logseq graph is refused", wrong.status === 1 && /is it a Logseq graph/.test(wrong.stderr), wrong.stderr);
  const escape = run("markdown", path.join(SAMPLE, "markdown"), "--to", path.join(TMP, "y"), "--into", "../elsewhere");
  check("--into cannot leave the vault", escape.status === 1 && /inside the vault/.test(escape.stderr), escape.stderr);
  check("unknown sources show the usage", run("evernote", SAMPLE, "--to", TMP).stderr.includes("Usage:"));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll import checks passed");
process.exit(failed ? 1 : 0);
