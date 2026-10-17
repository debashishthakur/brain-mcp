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
  /** Every link occurrence with where it sits, for the link graph (see extractLinks). */
  linkOccs: LinkOcc[];
  size: number;
}

/**
 * A wikilink: optional embed `!`, the target, an optional `#heading` (or `#^block`), an optional `|alias` (a table
 * escapes the pipe as `\|`). It never crosses a line break or contains brackets.
 */
export const WIKILINK = /(!?)\[\[([^[\]|#\n]+?)(?:#([^[\]|\n]*?))?(?:\\?\|([^[\]\n]*))?\]\]/g;

/** A link target as written, minus a table's trailing `\` and a `.md` suffix. */
export function cleanTarget(target: string): string {
  return target.trim().replace(/\\$/, "").replace(/\.md$/i, "").trim();
}

/** The `#heading` part of a link, minus a table's trailing `\`; block references (`#^id`) are dropped. */
function cleanHeading(h: string | undefined): string | null {
  if (!h || h.startsWith("^")) return null;
  return h.trim().replace(/\\$/, "").trim() || null;
}

/**
 * Which lines are code: fence lines and everything between them. A fence opens with three or more backticks or
 * tildes (a backtick fence's info string has no backtick) and closes only on the same character, at least as many,
 * with nothing else on the line, as in CommonMark and Obsidian. An unclosed fence runs to the end.
 */
export function codeLines(lines: string[]): boolean[] {
  let open: { ch: string; n: number } | null = null;
  return lines.map((line) => {
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (open) {
      if (m && m[1][0] === open.ch && m[1].length >= open.n && !m[2].trim()) open = null;
      return true;
    }
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], n: m[1].length };
      return true;
    }
    return false;
  });
}

/** Where a link sits, from strongest to weakest evidence that the author meant the connection. */
export type LinkKind = "sentence" | "short" | "list_explained" | "list_bare" | "heading" | "table" | "embed" | "fm" | "trailer";

export interface LinkOcc {
  /** Order of the occurrence within the note. */
  pos: number;
  kind: LinkKind;
  /** The frontmatter key, for kind "fm". */
  fmKey: string | null;
  /** The target as written (see cleanTarget). */
  target: string;
  /** The `#heading` part, if any (block references are dropped). */
  heading: string | null;
  /** The sentence, list item, heading or table row around the link, links shown as plain text, at most 300 characters. */
  ctx: string | null;
  /** Line of the body (0-based) and column the link starts at, for placing it in its section window; null in frontmatter. */
  lineNo: number | null;
  col: number | null;
}

/** Frontmatter keys whose plain-string values (no brackets) also count as links, as they always have. */
export const LINK_KEYS = ["project", "topics", "related", "part-of"];
/** Attachments: an embed of anything but a note is not a link between notes. */
const ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|pdf|mp[34]|m4a|wav|ogg|webm|mov|avi|csv|xlsx?|docx?|pptx?|zip|canvas|excalidraw)$/i;

/** Words outside links: runs of two or more letters (a CJK run counts one word per two characters). */
function wordCount(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/\p{L}{2,}/gu)) n += /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(m[0]) ? Math.ceil(m[0].length / 2) : 1;
  return n;
}
const plainLinks = (s: string) => s.replace(WIKILINK, (_m, _e, t: string, _h, a: string | undefined) => (a?.trim() || t).trim());
function aroundLink(text: string, at: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= 300) return s;
  const c = Math.min(Math.max(0, at), s.length);
  const start = Math.max(0, Math.min(c - 150, s.length - 300));
  return `${start > 0 ? "…" : ""}${s.slice(start, start + 300).trim()}${start + 300 < s.length ? "…" : ""}`;
}
/** `text` around the link that starts at `at`: links as plain text, whitespace folded, at most 300 characters. */
function ctxAround(text: string, at: number, clean: (s: string) => string = (s) => s): string {
  const lead = plainLinks(clean(text.slice(0, at))).replace(/\s+/g, " ").trimStart().length;
  return aroundLink(plainLinks(clean(text)), lead);
}
/** A comma-separated frontmatter string, split at commas outside [[links]] (an alias may hold a comma). */
const splitCommas = (s: string) => s.split(/,(?![^[]*\]\])/);

/**
 * Every link in a note, classified by where it sits. Code (fenced or inline) is skipped, attachments are dropped,
 * and links after the generated Connections trailer are kind "trailer". A link inside a run of three or more links
 * joined only by commas, "and" and the like is a bare list item even inside a sentence: that is a generated list.
 */
export function extractLinks(body: string, fm: Record<string, unknown>): LinkOcc[] {
  const out: LinkOcc[] = [];
  const push = (o: Omit<LinkOcc, "pos">) => out.push({ ...o, pos: out.length });
  const fmLink = (key: string, target: string, heading: string | null) => push({ kind: "fm", fmKey: key, target, heading, ctx: null, lineNo: null, col: null });
  // Frontmatter: any key whose value holds [[links]]. The long-standing link keys also take plain values, as they
  // always have: a list item is one link (YAML reads an unquoted [[X]] as a nested list; a number counts as its text),
  // a string is a comma-separated list (project stays whole), and a value wrapped in [[ ]] that the pattern rejects
  // (a title with brackets of its own) is unwrapped by hand.
  for (const [key, v] of Object.entries(fm)) {
    const linkKey = LINK_KEYS.includes(key);
    const items: unknown[] = Array.isArray(v) ? (linkKey ? v.flat(Infinity) : v) : [v];
    for (const item of items) {
      const s = typeof item === "string" ? item : linkKey && (typeof item === "number" || typeof item === "boolean") ? String(item) : null;
      if (s === null) continue;
      for (const part of linkKey && !Array.isArray(v) && key !== "project" ? splitCommas(s) : [s]) {
        const found = [...part.matchAll(WIKILINK)];
        if (found.length) {
          for (const m of found) if (!(m[1] && ATTACHMENT.test(cleanTarget(m[2])))) fmLink(key, cleanTarget(m[2]), cleanHeading(m[3]));
        } else if (linkKey) {
          const t = part.trim().replace(/^\[\[([\s\S]*)\]\]$/, "$1");
          if (t) fmLink(key, cleanTarget(t), null);
        }
      }
    }
  }
  // Positions count LF line ends, so the trailer cut and line starts agree in a CRLF note.
  const text = body.replace(/\r\n/g, "\n");
  const cut = text.search(/\n---\s*\n\s*## Connections\b/);
  const lines = text.split("\n");
  const code = codeLines(lines);
  let offset = 0;
  lines.forEach((raw, lineNo) => {
    const lineStart = offset;
    offset += raw.length + 1;
    if (code[lineNo]) return;
    const trailer = cut >= 0 && lineStart > cut;
    // Inline code is blanked out (same length, so positions hold) before links are matched, except a code span inside
    // a link's own brackets, which is part of the note's name: [[`brain_search` tool]].
    const spans = [...raw.matchAll(WIKILINK)].map((m) => [m.index!, m.index! + m[0].length]);
    const line = raw.replace(/`[^`\n]*`/g, (s: string, at: number) => (spans.some(([a, b]) => at > a && at + s.length < b) ? s : " ".repeat(s.length)));
    const matches = [...line.matchAll(WIKILINK)].filter((m) => !(m[1] && ATTACHMENT.test(cleanTarget(m[2]))));
    if (!matches.length) return;
    const bareAt = line.length - line.replace(/^\s*(>\s*)+/, "").length;
    const bare = line.slice(bareAt);
    const shape = /^#{1,6}\s/.test(bare) ? "heading" : /^\s*\|/.test(bare) ? "table" : /^\s*([-*+]|\d+[.)])\s+/.test(bare) ? "list" : "para";
    // Runs of 3+ links separated only by commas, semicolons, middots, slashes, "and"/"or": generated enumerations.
    const enumerated = new Set<number>();
    let run: number[] = [];
    const closeRun = () => {
      if (run.length >= 3) for (const i of run) enumerated.add(i);
      run = [];
    };
    matches.forEach((m, i) => {
      if (i > 0) {
        const prev = matches[i - 1];
        const gap = line.slice(prev.index! + prev[0].length, m.index!).trim();
        if (!/^(,|;|·|\/|&|and|or|,\s*and|,\s*or)?$/i.test(gap)) closeRun();
      }
      run.push(i);
    });
    closeRun();
    matches.forEach((m, i) => {
      const at = m.index!;
      const target = cleanTarget(m[2]);
      const heading = cleanHeading(m[3]);
      // The context comes from the raw line (code shown), cut at the same positions as the masked one.
      if (trailer) return push({ kind: "trailer", fmKey: null, target, heading, ctx: null, lineNo, col: at });
      if (m[1]) return push({ kind: "embed", fmKey: null, target, heading, ctx: ctxAround(raw.slice(bareAt), at - bareAt), lineNo, col: at });
      let kind: LinkKind;
      let ctx: string;
      if (shape === "heading") {
        const from = bareAt + bare.match(/^#{1,6}\s+/)![0].length;
        kind = "heading";
        ctx = ctxAround(raw.slice(from), at - from);
      } else if (shape === "table") {
        kind = "table";
        ctx = ctxAround(raw.slice(bareAt), at - bareAt, (s) => s.replace(/\\\|/g, "|"));
      } else if (shape === "list") {
        const from = bareAt + bare.match(/^\s*([-*+]|\d+[.)])\s+/)![0].length;
        kind = enumerated.has(i) || wordCount(line.slice(from).replace(WIKILINK, " ").replace(/https?:\S+/g, " ")) < 3 ? "list_bare" : "list_explained";
        ctx = ctxAround(raw.slice(from), at - from);
      } else {
        // The sentence holding the link: split after . ! ? (not at ;, so "Part of [[X]]; used by [[Y]]." stays one).
        let start = 0;
        let end = line.length;
        for (const s of line.matchAll(/[.!?](?=\s+\S)/g)) {
          if (s.index! < at) start = s.index! + 1;
          else if (s.index! >= at + m[0].length) {
            end = s.index! + 1;
            break;
          }
        }
        const sentence = line.slice(start, end);
        kind = enumerated.has(i) ? "list_bare" : wordCount(sentence.replace(WIKILINK, " ").replace(/https?:\S+/g, " ")) >= 3 ? "sentence" : "short";
        ctx = ctxAround(raw.slice(start, end), at - start);
      }
      push({ kind, fmKey: null, target, heading, ctx, lineNo, col: at });
    });
  });
  return out;
}

/**
 * The section window (`ord` from splitSections) each body link sits in; null for frontmatter and trailer links.
 * Every body line is walked through the windows in order (windows hold the lines in order, code included), so a
 * repeated line, or a copy of it in code earlier in the note, cannot claim a later link. A line cut across windows
 * (see hardCut) is placed by the link's column.
 */
export function linkWindows(body: string, occs: LinkOcc[], sections: Section[]): (number | null)[] {
  const lines = stripConnections(body).split(/\r?\n/);
  /** Per line: the windows holding it, each with the columns [from, to) of the line it holds. */
  const parts: { w: number; from: number; to: number }[][] = [];
  let w = 0;
  let at = 0;
  for (const raw of lines) {
    const mine: { w: number; from: number; to: number }[] = [];
    parts.push(mine);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) continue;
    for (let i = w; i < Math.min(sections.length, w + 3) && !mine.length; i++) {
      const idx = sections[i].text.indexOf(t, i === w ? at : 0);
      if (idx < 0) continue;
      mine.push({ w: i, from: lead, to: lead + t.length });
      w = i;
      at = idx + t.length;
    }
    if (mine.length) continue;
    // Cut across windows: the window holding the line's start ends with it, the next ones carry on from their start.
    for (let i = w; i < Math.min(sections.length, w + 2) && !mine.length; i++) {
      const idx = sections[i].text.indexOf(t.slice(0, 40), i === w ? at : 0);
      if (idx < 0) continue;
      let rest = t;
      let col = lead;
      for (let j = i; rest && j < sections.length; j++) {
        const start = j === i ? idx : 0;
        const take = Math.min(sections[j].text.length - start, rest.length);
        mine.push({ w: j, from: col, to: col + take });
        w = j;
        at = start + take;
        const after = rest.slice(take);
        rest = after.trimStart();
        col += take + after.length - rest.length;
      }
    }
  }
  return occs.map((o) => {
    if (o.kind === "fm" || o.kind === "trailer" || o.lineNo == null) return null;
    const ps = parts[o.lineNo] ?? [];
    const col = o.col ?? 0;
    const p = ps.find((x) => col >= x.from && col < x.to) ?? ps.filter((x) => x.from <= col).at(-1) ?? ps[0];
    if (p) return sections[p.w].ord;
    const i = sections.findIndex((s) => s.text.includes(`[[${o.target}`));
    return i >= 0 ? sections[i].ord : null;
  });
}

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
  const linkOccs = extractLinks(body, fm);
  // `links` keeps its meaning for brain_graph, brain_read and move/delete warnings: body links (code and attachments
  // excluded) plus the long-standing frontmatter link keys.
  const links = new Set<string>();
  for (const o of linkOccs) if (o.kind !== "fm" || LINK_KEYS.includes(o.fmKey!)) links.add(o.target);
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
    linkOccs,
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

/** Longest section the ranker sees. Long sections are windowed at paragraph boundaries so a fact late in a
 *  heading-less note is still inside the embedder's and reranker's view; later windows keep the heading. */
export const SECTION_WINDOW_CHARS = 1200;

function windows(text: string, max = SECTION_WINDOW_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && (cur + "\n\n" + para).length > max) {
      out.push(cur);
      cur = para;
    } else cur = cur ? cur + "\n\n" + para : para;
  }
  if (cur) out.push(cur);
  // A single paragraph (or table, or code block) longer than 1.5 windows is cut hard.
  return out.flatMap((w) => (w.length > max * 1.5 ? hardCut(w, max) : [w]));
}

/**
 * Cut an over-long block into pieces of at most `max` characters: at the last line break in the second half of the
 * piece, else at the last space, and never inside a [[link]].
 */
function hardCut(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    // A link is split unless its "]]" ends by the cut: back up to its "[[".
    const open = rest.lastIndexOf("[[", cut);
    if (open > rest.lastIndexOf("]]", cut - 2) && open > 0) cut = open;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Split a note body into heading-delimited sections (windowed, see SECTION_WINDOW_CHARS), skipping code fences and the generated Connections trailer. */
export function splitSections(body: string): Section[] {
  const lines = stripConnections(body).split(/\r?\n/);
  const out: Section[] = [];
  let cur: string[] = [];
  let heading = "";
  let level = 0;
  let inFence = false;
  const flush = () => {
    const text = cur.join("\n").trim();
    if (text) for (const w of windows(text)) out.push({ ord: out.length, heading, level, text: w });
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
