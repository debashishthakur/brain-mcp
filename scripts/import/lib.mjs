// Shared helpers for the importers: writing notes with the frontmatter brain-mcp reads, safe file and link
// names, and text transforms that leave code alone. No dependencies beyond Node.
import fs from "node:fs";
import path from "node:path";

/** A Date as YYYY-MM-DD in local time (the form `modified` is read in). */
export const ymd = (d) => d.toLocaleDateString("sv-SE");

/** Every file under `dir`, sorted, skipping hidden folders and the names in `skip`. Paths are relative to `dir`. */
export function walk(dir, skip = []) {
  const out = [];
  const visit = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith(".") || skip.includes(e.name)) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) visit(r);
      else out.push(r);
    }
  };
  visit("");
  return out.sort();
}

/** A title that is safe inside [[double brackets]]: no brackets, pipe, hash or caret, one line, no stray spaces. */
export const cleanTitle = (s) =>
  String(s)
    .replace(/[\[\]|#^]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A file name (without extension) that every OS accepts. */
export const fileSafe = (s) =>
  cleanTitle(s)
    .replace(/[\\/:*?"<>\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .slice(0, 120) || "Untitled";

/** `[[Name]]` form of a list of names, the way `topics` and `part-of` are read. */
export const wikilinks = (names) => names.map((n) => `[[${cleanTitle(n)}]]`);

/** Split a comma separated property value into trimmed, non-empty parts. */
export const splitList = (v) =>
  String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Run `fn` over the parts of `text` that are not code: fenced blocks and inline code spans pass through
 * untouched, so a link or tag written inside code is never rewritten.
 */
export function outsideCode(text, fn) {
  const out = [];
  let fence = null; // the opening marker while inside a fenced block
  let prose = [];
  const flush = () => {
    if (!prose.length) return;
    out.push(
      prose
        .join("\n")
        .split(/(`+[^`\n]*?`+)/g)
        .map((part, i) => (i % 2 ? part : fn(part)))
        .join(""),
    );
    prose = [];
  };
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      flush();
      out.push(line);
      fence = m[1];
    } else prose.push(line);
  }
  flush();
  return out.join("\n");
}

const yamlScalar = (v) => {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return ymd(v);
  if (typeof v === "object" && v !== null) return JSON.stringify(v); // flow-style YAML, which JSON is
  return JSON.stringify(String(v)); // a JSON string is a valid YAML double-quoted scalar
};

/** Frontmatter block for `data`. Arrays become block lists, empty values are left out, keys keep insertion order. */
export function frontmatter(data) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) lines.push(`${k}:`, ...v.map((x) => `  - ${yamlScalar(x)}`));
    else lines.push(`${k}: ${yamlScalar(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** Keys the importers set themselves, so a free-form property of the same name never replaces them. */
const RESERVED = new Set(["title", "type", "project", "topics", "related", "part-of", "aliases", "modified", "visibility"]);

/** A property name as a frontmatter key: lower case, hyphens, no punctuation. */
export const keyName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Add free-form `props` to `data` under safe key names, never overwriting what the importer set. */
export function addProps(data, props) {
  for (const [k, v] of Object.entries(props)) {
    const key = keyName(k);
    if (!key || key in data || RESERVED.has(key)) continue;
    data[key] = v;
  }
  return data;
}

/**
 * Hands out one title per source note and keeps them unique. A title that is taken becomes
 * `Title (Folder)`, then `Title (Folder) 2` and so on, so no two notes share a link target.
 */
export class Titles {
  constructor() {
    this.used = new Set();
  }
  claim(title, hint = "") {
    const base = cleanTitle(title) || "Untitled";
    const free = (t) => !this.used.has(t.toLowerCase());
    let t = base;
    if (!free(t) && cleanTitle(hint)) t = `${base} (${cleanTitle(hint)})`;
    const stem = t;
    for (let n = 2; !free(t); n++) t = `${stem} ${n}`;
    this.used.add(t.toLowerCase());
    return t;
  }
}

/** A file path for a note, unique within this run even on case-insensitive disks. */
export class Paths {
  constructor() {
    this.used = new Set();
  }
  claim(dir, name) {
    let rel = path.join(dir, `${name}.md`);
    for (let n = 2; this.used.has(rel.toLowerCase()); n++) rel = path.join(dir, `${name} ${n}.md`);
    this.used.add(rel.toLowerCase());
    return rel;
  }
}

/** Collects what was converted and what was not, so the run can say so plainly. */
export class Report {
  constructor() {
    this.written = [];
    this.skipped = [];
    this.counts = new Map();
    this.notes = [];
  }
  count(what, n = 1) {
    this.counts.set(what, (this.counts.get(what) ?? 0) + n);
  }
}

/**
 * Write the notes an importer produced. `notes` is a list of { rel, data, body }. Nothing is overwritten
 * unless `force` is set, and with `dryRun` nothing is written at all.
 */
export function writeNotes(dest, notes, report, { force = false, dryRun = false } = {}) {
  for (const n of notes) {
    const target = path.join(dest, n.rel);
    if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) throw new Error(`refusing to write outside ${dest}: ${n.rel}`);
    if (fs.existsSync(target) && !force) {
      report.skipped.push(n.rel);
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${frontmatter(n.data)}\n${n.body.replace(/^\n+/, "").replace(/\s+$/, "")}\n`);
    }
    report.written.push(n.rel);
  }
}
