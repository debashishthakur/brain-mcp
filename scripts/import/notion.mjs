// Notion "Markdown & CSV" export -> vault notes. Unzip the export first and point this at the folder that holds
// the pages (if the zip contains a single folder, that one).
//
// Converted: pages and subpages, with the 32-character IDs Notion adds to file and folder names removed; the
// title (the first "# Heading"); links between pages, [text](Page%20Name%20<id>.md) -> [[Page Name|text]];
// the property lines Notion writes under the title of a database page (Tags -> topics, Last Edited Time ->
// modified, the rest as plain frontmatter keys); a subpage gets `part-of` pointing at its parent page.
// Not converted: database tables (.csv files, skipped), images and other attachments (not copied; links to them
// are left as they are), links to pages that are not in the export (kept as plain text).
import fs from "node:fs";
import path from "node:path";
import { Titles, Paths, addProps, cleanTitle, fileSafe, outsideCode, splitList, wikilinks, ymd, walk } from "./lib.mjs";

const ID = / [0-9a-f]{32}(?=\.\w+$|$)/;
const stripId = (s) => s.replace(ID, "");
const posix = (p) => p.split(path.sep).join("/");
const KNOWN = new Set(["created", "created time", "created by", "last edited time", "last edited by", "last edited", "tags", "tag", "status", "type", "date", "updated"]);
const MAPPED = ["tags", "tag", "last edited time", "last edited", "updated", "created", "created time", "type"];

/** The property lines right under the title: [key, value] pairs, or null when the lines are ordinary text. */
function propertyBlock(lines) {
  const props = [];
  for (const line of lines) {
    const m = /^([^:\n]{1,40}):\s+(.+)$/.exec(line);
    if (!m) break;
    props.push([m[1].trim(), m[2].trim()]);
  }
  // One line like "Note: remember this" is prose. Only treat a block as properties when it clearly is one.
  if (props.length >= 2 || (props.length === 1 && KNOWN.has(props[0][0].toLowerCase()))) return props;
  return null;
}

const asDate = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : ymd(new Date(t));
};

export function importNotion(src, { project, into = "Imported" } = {}, report) {
  const all = walk(src);
  const pages = all.filter((f) => f.endsWith(".md"));
  for (const f of all) {
    if (f.endsWith(".csv")) report.count("database tables skipped (.csv)");
    else if (!f.endsWith(".md")) report.count("attachments not copied");
  }
  if (!pages.length) throw new Error(`no .md files under ${src}: unzip the Notion "Markdown & CSV" export and point at that folder`);
  const titles = new Titles();
  const paths = new Paths();
  const info = new Map(); // original path (lower case, forward slashes) -> parsed page
  for (const rel of pages) {
    const text = fs.readFileSync(path.join(src, rel), "utf8").replace(/^\uFEFF/, "");
    const lines = text.replace(/\r/g, "").split("\n");
    const h1 = lines.findIndex((l) => l.trim());
    const heading = h1 >= 0 ? /^#\s+(.+?)\s*#*\s*$/.exec(lines[h1]) : null;
    const name = stripId(path.basename(rel, ".md"));
    const parent = path.dirname(rel) === "." ? "" : stripId(path.basename(path.dirname(rel)));
    info.set(posix(rel).toLowerCase(), { rel, lines, h1, hasHeading: !!heading, title: titles.claim(heading ? heading[1] : name, parent) });
  }

  const notes = [];
  for (const page of info.values()) {
    const { rel, lines, title } = page;
    let start = page.hasHeading ? page.h1 + 1 : 0;
    while (start < lines.length && !lines[start].trim()) start++;
    const props = propertyBlock(lines.slice(start)) ?? [];
    start += props.length;
    const data = { title, type: "note" };
    if (project) data.project = `[[${cleanTitle(project)}]]`;
    // A subpage lives in a folder named after its parent page.
    const parentPage = path.dirname(rel) === "." ? null : info.get(posix(path.dirname(rel) + ".md").toLowerCase());
    if (parentPage) data["part-of"] = [`[[${parentPage.title}]]`];
    const get = (...keys) => props.find(([k]) => keys.includes(k.toLowerCase()))?.[1];
    const tags = get("tags", "tag");
    if (tags) data.topics = wikilinks(splitList(tags));
    const edited = get("last edited time", "last edited", "updated");
    const created = get("created", "created time");
    data.modified = (edited && asDate(edited)) || ymd(fs.statSync(path.join(src, rel)).mtime);
    if (created && asDate(created)) data.created = asDate(created);
    if (get("type")) data.type = get("type");
    addProps(data, Object.fromEntries(props.filter(([k]) => !MAPPED.includes(k.toLowerCase()))));

    const dir = path.dirname(rel) === "." ? "" : path.dirname(rel).split(path.sep).map((s) => fileSafe(stripId(s))).join(path.sep);
    const body = outsideCode(lines.slice(start).join("\n").replace(/^\n+/, ""), (s) =>
      s.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang, text, href) => {
        if (bang || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return whole;
        let target = href.split("#")[0];
        try {
          target = decodeURIComponent(target);
        } catch {}
        const hit = info.get(posix(path.normalize(path.join(path.dirname(rel), target))).toLowerCase());
        if (hit) {
          report.count("page links rewritten");
          return text === hit.title || !text.trim() ? `[[${hit.title}]]` : `[[${hit.title}|${cleanTitle(text)}]]`;
        }
        if (/\.(md|csv)$/i.test(target)) {
          report.count("links to pages outside the export kept as text");
          return text;
        }
        return whole;
      }),
    );
    notes.push({ rel: paths.claim(path.join(into, dir), fileSafe(title)), data, body: `# ${title}\n\n${body}` });
    report.count("pages");
  }
  return notes;
}
