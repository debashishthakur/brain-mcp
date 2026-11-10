// Logseq graph -> vault notes. Reads <graph>/pages and <graph>/journals (the folders Logseq itself writes).
//
// Converted: page and journal files, page properties (title, alias, tags, type; any other becomes a plain
// frontmatter key), namespaces (a___b.md or a%2Fb.md -> title "a/b"), [[links]] (kept as they are, brain-mcp
// resolves them by title or alias), #tags and #[[tags]] (to links), the outline (top-level bullets become
// paragraphs, nested bullets stay lists), TODO/DONE markers (to task checkboxes), [label]([[Page]]) links, and
// journal pages (aliased to Logseq's default link text, "Sep 23rd, 2026").
// Not converted: block references ((uuid)), embeds of blocks, macros, queries and block properties, which are
// dropped and counted; assets and the logseq/ settings folder, which are ignored.
import fs from "node:fs";
import path from "node:path";
import { Titles, Paths, addProps, cleanTitle, fileSafe, outsideCode, splitList, wikilinks, ymd } from "./lib.mjs";

const PROP = /^\s*(?:-\s+)?([A-Za-z][\w-]*)::\s?(.*)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th"));

/** The page name Logseq gives a file: `a___b.md` and `a%2Fb.md` are the namespace `a/b`. */
export function titleFromFile(file) {
  let t = path.basename(file, ".md");
  try {
    t = decodeURIComponent(t);
  } catch {}
  return t.replace(/___/g, "/");
}

/** `[[a]], [[b c]]`, `a, b` or `#a, #b` as a list of names. */
function names(value) {
  const linked = [...value.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
  const rest = value.replace(/\[\[[^\]]+\]\]/g, ",");
  return [...new Set([...linked, ...splitList(rest).map((s) => s.replace(/^#/, ""))].filter(Boolean))];
}

/** Properties at the top of a file, before the first block of text, as [key, value] pairs, and the lines left over. */
function splitProperties(lines) {
  const props = [];
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || PROP.test(lines[i]))) {
    const m = PROP.exec(lines[i].replace(/\r$/, ""));
    if (m) props.push([m[1].toLowerCase(), m[2].trim()]);
    i++;
  }
  return { props, rest: lines.slice(i) };
}

/** The outline as Markdown: top-level bullets become paragraphs, deeper ones stay list items. */
function flatten(lines, report) {
  const blocks = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "").replace(/\t/g, "  ");
    if (!line.trim()) continue;
    if (/^\s*[A-Za-z][\w-]*::(\s.*)?$/.test(line)) {
      // `id:: ...`, `collapsed:: true`: block properties sit on their own line under a bullet.
      report.count("block properties dropped");
      continue;
    }
    const m = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (!m) {
      // A continuation line of the previous block (a code fence, a second paragraph).
      blocks.push({ depth: blocks.length ? blocks[blocks.length - 1].depth : 0, text: line.trim(), cont: true });
      continue;
    }
    blocks.push({ depth: Math.floor(m[1].length / 2), text: (m[2] ?? "").trim() });
  }
  const md = [];
  for (const b of blocks) {
    let t = b.text;
    if (!t) continue;
    let task = "";
    const todo = /^(TODO|DOING|LATER|NOW|WAITING|IN-PROGRESS)\s+(.*)$/.exec(t);
    const done = /^DONE\s+(.*)$/.exec(t);
    const cancelled = /^(CANCELED|CANCELLED)\s+(.*)$/.exec(t);
    if (todo) {
      task = "[ ] ";
      t = todo[2];
    } else if (done) {
      task = "[x] ";
      t = done[1];
    } else if (cancelled) t = `~~${cancelled[2]}~~`;
    if (task) report.count("tasks");
    if (b.cont) md.push(t);
    else if (b.depth === 0) {
      if (md.length) md.push("");
      md.push(task ? `- ${task}${t}` : t);
    } else md.push(`${"  ".repeat(b.depth - 1)}- ${task}${t}`);
  }
  return md.join("\n");
}

/** Inline Logseq syntax -> Markdown the server reads. */
function inline(text, report) {
  return outsideCode(text, (s) =>
    s
      .replace(/\{\{embed\s+\[\[([^\]]+)\]\]\s*\}\}/gi, (_, p) => (report.count("page embeds turned into links"), `[[${p}]]`))
      .replace(/\{\{embed\s+\(\([^)]*\)\)\s*\}\}/gi, () => (report.count("block embeds dropped"), ""))
      .replace(/\{\{[^}]*\}\}/g, () => (report.count("macros and queries dropped"), ""))
      .replace(/\(\([0-9a-f-]{8,}\)\)/gi, () => (report.count("block references dropped"), ""))
      .replace(/\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)/g, (_, label, page) => (report.count("labelled links"), label === page ? `[[${page}]]` : `[[${page}|${label}]]`))
      .replace(/#\[\[([^\]]+)\]\]/g, (_, t) => (report.count("tags turned into links"), `[[${t}]]`))
      .replace(/(^|[\s(])#([A-Za-z0-9_][\w/-]*)/g, (_, pre, t) => (report.count("tags turned into links"), `${pre}[[${t}]]`))
      .replace(/(?<=\S)[ \t]+(?=\n)/g, "") // what a dropped reference leaves behind
      .replace(/\n{3,}/g, "\n\n"),
  );
}

export function importLogseq(src, { project, into = "Imported" } = {}, report) {
  const pagesDir = path.join(src, "pages");
  const journalsDir = path.join(src, "journals");
  if (!fs.existsSync(pagesDir) && !fs.existsSync(journalsDir)) throw new Error(`${src} has no pages/ or journals/ folder: is it a Logseq graph?`);
  const titles = new Titles();
  const paths = new Paths();
  const notes = [];
  const files = (dir, kind) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => ({ file: path.join(dir, f), kind }))
      : [];
  for (const { file, kind } of [...files(pagesDir, "page"), ...files(journalsDir, "journal")]) {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const { props, rest } = splitProperties(text.split("\n"));
    const p = Object.fromEntries(props);
    const journal = kind === "journal" && /^\d{4}_\d{2}_\d{2}$/.test(path.basename(file, ".md"));
    const stamp = journal ? path.basename(file, ".md").replace(/_/g, "-") : null;
    const title = titles.claim(p.title || (journal ? stamp : titleFromFile(file)), kind);
    const data = { title, type: p.type || (journal ? "journal" : "note") };
    if (project) data.project = `[[${cleanTitle(project)}]]`;
    if (p.tags) data.topics = wikilinks(names(p.tags));
    const aliases = p.alias || p.aliases ? names(p.alias || p.aliases) : [];
    if (journal) {
      const [y, m, d] = stamp.split("-").map(Number);
      aliases.push(`${MONTHS[m - 1]} ${ordinal(d)}, ${y}`); // Logseq's default journal link text
    }
    if (aliases.length) data.aliases = aliases;
    data.modified = journal ? stamp : ymd(fs.statSync(file).mtime);
    addProps(
      data,
      Object.fromEntries(
        props.filter(([k]) => !["title", "type", "tags", "alias", "aliases"].includes(k)).map(([k, v]) => [k, v.replace(/\[\[([^\]]+)\]\]/g, "$1")]),
      ),
    );
    const body = inline(flatten(rest, report), report);
    const dir = path.join(into, journal ? "Journals" : "Pages");
    notes.push({ rel: paths.claim(dir, fileSafe(title)), data, body: `# ${title}\n\n${body}` });
    report.count(journal ? "journals" : "pages");
  }
  return notes;
}
