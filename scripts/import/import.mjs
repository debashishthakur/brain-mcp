#!/usr/bin/env node
// Bring notes from another tool into a vault brain-mcp can serve.
//
//   node scripts/import/import.mjs logseq   <graph folder>   --to <vault>
//   node scripts/import/import.mjs notion   <export folder>  --to <vault>
//   node scripts/import/import.mjs markdown <folder>         --to <vault>
//
//   --to <vault>      the vault folder to write into (created if missing)
//   --into <folder>   folder inside the vault for the imported notes (default: Imported)
//   --project <name>  put every imported note in this project (a [[link]] to its hub note)
//   --force           replace notes that already exist (default: skip them, so a re-run is safe)
//   --dry-run         say what would happen and write nothing
//
// The source is only read, never changed. What each importer converts and what it leaves out is at the top of
// its own file and in the README.
import fs from "node:fs";
import path from "node:path";
import { Report, writeNotes } from "./lib.mjs";
import { importLogseq } from "./logseq.mjs";
import { importNotion } from "./notion.mjs";
import { importMarkdown } from "./markdown.mjs";

const IMPORTERS = { logseq: importLogseq, notion: importNotion, markdown: importMarkdown };
const USAGE = `Usage: node scripts/import/import.mjs <logseq|notion|markdown> <source folder> --to <vault> [--into Imported] [--project "Name"] [--force] [--dry-run]`;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
};

const withValue = new Set(["--to", "--into", "--project"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !withValue.has(argv[i - 1]));
const [kind, source] = positional;
if (flag("--help") || flag("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (!IMPORTERS[kind]) fail(`Unknown source "${kind ?? ""}". Choose logseq, notion or markdown.`);
if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) fail(`Source folder not found: ${source ?? "(none given)"}`);
if (!opt("--to")) fail("Say where to write with --to <vault>.");

const src = path.resolve(source);
const dest = path.resolve(opt("--to"));
const into = opt("--into") ?? "Imported";
if (path.isAbsolute(into) || into.split(/[\\/]/).includes("..")) fail("--into must be a folder inside the vault.");
if (dest === src || dest.startsWith(src + path.sep)) fail("The vault must not be inside the folder you are importing from.");

const report = new Report();
let notes;
try {
  notes = IMPORTERS[kind](src, { project: opt("--project"), into }, report);
} catch (e) {
  fail(e.message);
}
writeNotes(dest, notes, report, { force: flag("--force"), dryRun: flag("--dry-run") });

const verb = flag("--dry-run") ? "Would write" : "Wrote";
console.log(`${verb} ${report.written.length} note(s) to ${path.join(dest, into)}${report.skipped.length ? `, skipped ${report.skipped.length} that already exist (use --force to replace)` : ""}.`);
if (report.counts.size) {
  console.log("\nWhat was converted, and what was left out:");
  for (const [what, n] of [...report.counts].sort()) console.log(`  ${String(n).padStart(5)}  ${what}`);
}
for (const n of report.notes) console.log(`\n${n}`);
