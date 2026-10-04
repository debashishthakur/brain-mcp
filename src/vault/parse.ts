import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export interface ParsedNote {
  id: string; // vault-relative path with forward slashes
  title: string;
  type: string;
  project: string | null;
  topics: string[];
  related: string[];
  tags: string[];
  aliases: string[];
  visibility: string | null;
  source: string | null;
  modified: string; // YYYY-MM-DD
  captured: string | null;
  frontmatter: Record<string, unknown>;
  body: string; // markdown body without frontmatter
  links: string[]; // wikilink targets (raw, without alias/section)
  size: number;
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export function stripLink(v: unknown): string {
  if (typeof v !== "string") return String(v ?? "");
  const m = v.trim().match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
  return (m ? m[1] : v).trim();
}

function asList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(stripLink).filter(Boolean);
  if (typeof v === "string") return v.split(",").map(stripLink).filter(Boolean);
  return [];
}

function asDate(v: unknown, fallback: Date): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return fallback.toISOString().slice(0, 10);
}

export function toId(vaultDir: string, absPath: string): string {
  return path.relative(vaultDir, absPath).split(path.sep).join("/");
}

export function parseNoteFile(vaultDir: string, absPath: string): ParsedNote {
  const raw = fs.readFileSync(absPath, "utf8");
  const stat = fs.statSync(absPath);
  return parseNote(toId(vaultDir, absPath), raw, stat.mtime);
}

export function parseNote(id: string, raw: string, mtime: Date): ParsedNote {
  let fm: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    fm = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch {
    // malformed frontmatter: treat whole file as body
  }
  const base = path.posix.basename(id, ".md");
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : base;
  const links = new Set<string>();
  for (const m of body.matchAll(WIKILINK)) links.add(m[1].trim());
  for (const key of ["project", "topics", "related", "part-of"]) {
    for (const t of asList(fm[key])) links.add(t);
  }
  return {
    id,
    title,
    type: typeof fm.type === "string" ? fm.type.split("|")[0].split("#")[0].trim() : "note",
    project: fm.project ? stripLink(fm.project) : null,
    topics: asList(fm.topics),
    related: asList(fm.related),
    tags: asList(fm.tags),
    aliases: asList(fm.aliases),
    visibility: typeof fm.visibility === "string" ? fm.visibility.trim().toLowerCase() : null,
    source: typeof fm.source === "string" ? fm.source : null,
    modified: asDate(fm.modified, mtime),
    captured: fm.captured ? asDate(fm.captured, mtime) : null,
    frontmatter: fm,
    body,
    links: [...links],
    size: Buffer.byteLength(raw, "utf8"),
  };
}

/** Remove the generated "## Connections" trailer so it does not dominate search or context. */
export function stripConnections(body: string): string {
  const i = body.search(/\n---\s*\n\s*## Connections\b/);
  return i >= 0 ? body.slice(0, i).trimEnd() : body;
}

/** Drop a leading "# Title" line that duplicates the frontmatter title. */
export function stripTitleHeading(body: string, title: string): string {
  const m = body.match(/^\s*#\s+(.+?)\s*\r?\n/);
  if (m && m[1].trim().toLowerCase() === title.trim().toLowerCase()) return body.slice(m[0].length).replace(/^\s*\n/, "");
  return body;
}

export function firstParagraph(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (out.length) break;
      continue;
    }
    if (t.startsWith("#") || t.startsWith("---")) {
      if (out.length) break;
      continue;
    }
    out.push(t);
  }
  return out.join(" ");
}

export interface Section {
  ord: number;
  heading: string; // "" for the preamble before the first heading
  level: number;
  text: string; // includes the heading line
}

/** Split a note body into heading-delimited sections, skipping code fences and the generated Connections trailer. */
export function splitSections(body: string): Section[] {
  const lines = stripConnections(body).split(/\r?\n/);
  const out: Section[] = [];
  let cur: string[] = [];
  let heading = "";
  let level = 0;
  let inFence = false;
  const flush = () => {
    const text = cur.join("\n").trim();
    if (text) out.push({ ord: out.length, heading, level, text });
    cur = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      flush();
      heading = m[2].trim();
      level = m[1].length;
    }
    cur.push(line);
  }
  flush();
  return out;
}

export function section(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const want = heading.replace(/^#+\s*/, "").trim().toLowerCase();
  let level = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === want) {
        level = m[1].length;
        start = i;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}
