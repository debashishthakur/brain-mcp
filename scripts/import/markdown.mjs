// A plain folder of Markdown (any tool, or none) -> vault notes, keeping the folder structure and file names.
//
// Converted: each note gets the frontmatter the server reads: its own frontmatter is kept, and a missing
// `title` (the first "# Heading", else the file name), `type`, `modified` (the file's date) and, when it has a
// `tags` list, `topics` are filled in. Relative Markdown links to other notes in the folder,
// [text](sub/Other.md), become [[Other|text]]; [[wikilinks]] are left as they are.
// Not converted: links to files that are not notes (kept as they are), links to a heading inside a note (the
// heading is dropped, the link goes to the note), notes whose frontmatter is not valid YAML (imported without it).
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { Titles, cleanTitle, outsideCode, splitList, wikilinks, ymd, walk } from "./lib.mjs";

const posix = (p) => p.split(path.sep).join("/");
const plain = (v) => (v instanceof Date ? ymd(v) : Array.isArray(v) ? v.map(plain) : v);

export function importMarkdown(src, { project, into = "Imported" } = {}, report) {
  const pages = walk(src, ["node_modules", "_build", "Templates"]).filter((f) => f.toLowerCase().endsWith(".md"));
  if (!pages.length) throw new Error(`no .md files under ${src}`);
  const titles = new Titles();
  const info = new Map();
  for (const rel of pages) {
    const raw = fs.readFileSync(path.join(src, rel), "utf8").replace(/^\uFEFF/, "");
    let parsed;
    try {
      parsed = matter(raw);
    } catch {
      parsed = { data: {}, content: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") };
      report.count("notes with invalid frontmatter imported without it");
    }
    const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(parsed.content);
    const name = path.basename(rel).replace(/\.md$/i, "");
    const base = parsed.data.title ? String(parsed.data.title) : h1 ? h1[1] : name;
    const folder = path.dirname(rel) === "." ? "" : path.basename(path.dirname(rel));
    info.set(posix(rel).toLowerCase(), { rel, data: parsed.data, content: parsed.content, title: titles.claim(base, folder) });
  }

  const notes = [];
  for (const page of info.values()) {
    const { rel, title } = page;
    const data = { title };
    for (const [k, v] of Object.entries(page.data)) if (k !== "title") data[k] = plain(v);
    data.type ??= "note";
    if (project && !data.project) data.project = `[[${cleanTitle(project)}]]`;
    if (!data.topics && data.tags) data.topics = wikilinks(Array.isArray(data.tags) ? data.tags.map(String) : splitList(data.tags));
    // A date the note already carries is a better `modified` than the day the file was copied.
    const dated = [data.modified, data.updated, data.last_modified, data.date].find((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v));
    data.modified = dated ? dated.slice(0, 10) : ymd(fs.statSync(path.join(src, rel)).mtime);
    const body = outsideCode(page.content, (s) =>
      s.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang, text, href) => {
        if (bang || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return whole;
        let target = href.split("#")[0];
        try {
          target = decodeURIComponent(target);
        } catch {}
        if (!/\.md$/i.test(target)) return whole;
        const hit = info.get(posix(path.normalize(path.join(path.dirname(rel), target))).toLowerCase());
        if (!hit) {
          report.count("links to missing notes left as they are");
          return whole;
        }
        report.count("note links rewritten");
        return text === hit.title || !text.trim() ? `[[${hit.title}]]` : `[[${hit.title}|${cleanTitle(text)}]]`;
      }),
    );
    notes.push({ rel: path.join(into, rel), data, body });
    report.count("notes");
  }
  return notes;
}
