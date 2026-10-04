import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";
import { parseNoteFile, splitSections, stripConnections, toId, type ParsedNote } from "./parse.js";
import type { ResolvedConfig } from "../config.js";

export interface NoteRow {
  id: string;
  title: string;
  type: string;
  project: string | null;
  visibility: string | null;
  source: string | null;
  modified: string;
  captured: string | null;
  size: number;
  frontmatter: string;
  body: string;
}

export interface SearchHit {
  id: string;
  title: string;
  type: string;
  project: string | null;
  modified: string;
  snippet: string;
  score: number;
}

export interface SearchOptions {
  project?: string;
  type?: string;
  topic?: string;
  since?: string; // YYYY-MM-DD
  until?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  project TEXT,
  visibility TEXT,
  source TEXT,
  modified TEXT NOT NULL,
  captured TEXT,
  size INTEGER NOT NULL,
  frontmatter TEXT NOT NULL,
  body TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_project ON notes(project);
CREATE INDEX IF NOT EXISTS notes_type ON notes(type);
CREATE INDEX IF NOT EXISTS notes_modified ON notes(modified);
CREATE TABLE IF NOT EXISTS titles (
  name TEXT NOT NULL,
  note_id TEXT NOT NULL,
  PRIMARY KEY (name, note_id)
);
CREATE INDEX IF NOT EXISTS titles_note ON titles(note_id);
CREATE TABLE IF NOT EXISTS note_topics (
  note_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  PRIMARY KEY (note_id, topic)
);
CREATE INDEX IF NOT EXISTS topics_topic ON note_topics(topic);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (from_id, target)
);
CREATE INDEX IF NOT EXISTS links_target ON links(target);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);
CREATE TABLE IF NOT EXISTS sections (
  note_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  level INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (note_id, ord)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  note_id UNINDEXED,
  ord UNINDEXED,
  heading,
  text,
  tokenize = 'porter unicode61'
);
`;

export interface SectionRow {
  note_id: string;
  ord: number;
  heading: string;
  level: number;
  text: string;
}

export interface SectionHit {
  note_id: string;
  ord: number;
  heading: string;
  snippet: string;
  score: number;
}

const STOP = new Set(
  "a an and are as at be by for from how in is it of on or that the this to was what when where which who why will with do does did my me i you your our we can should would could about into over under after before between".split(" "),
);

/** Query terms: lowercase, alphanumerics, stopwords and 1-char tokens removed. */
export function queryTerms(q: string): string[] {
  const seen = new Set<string>();
  for (const t of q.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, " ").split(/\s+/)) {
    if (t.length > 1 && !STOP.has(t)) seen.add(t);
  }
  return [...seen];
}

/** Fraction of query terms that appear in a title (prefix match, so "keyframes" hits "Keyframe"). */
export function titleOverlap(title: string, terms: string[]): number {
  if (!terms.length) return 0;
  const t = title.toLowerCase();
  let n = 0;
  for (const term of terms) {
    const stem = term.length > 4 ? term.slice(0, term.length - 1) : term;
    if (t.includes(stem)) n++;
  }
  return n / terms.length;
}

export const RRF_K = 60;
/** Weight of a full title match relative to a rank-1 BM25 hit (which scores 1/RRF_K). */
export const TITLE_BONUS = 0.02;

export class VaultIndex {
  readonly db: Database.Database;
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(event: "upsert" | "remove", id: string) => void>();

  constructor(readonly cfg: ResolvedConfig) {
    this.db = new Database(path.join(cfg.dataDir, "index.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  onChange(fn: (event: "upsert" | "remove", id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------ file walk
  private isIgnored(abs: string): boolean {
    const rel = toId(this.cfg.vaultDir, abs);
    if (rel.startsWith("..")) return true;
    const first = rel.split("/")[0];
    return this.cfg.ignoreDirs.includes(first) || rel.split("/").some((p) => p.startsWith("."));
  }

  private *walk(dir: string): Generator<string> {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (this.isIgnored(abs)) continue;
      if (ent.isDirectory()) yield* this.walk(abs);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) yield abs;
    }
  }

  fullReindex(): { indexed: number; removed: number; ms: number } {
    const t0 = Date.now();
    const seen = new Set<string>();
    let indexed = 0;
    const tx = this.db.transaction(() => {
      for (const abs of this.walk(this.cfg.vaultDir)) {
        const id = toId(this.cfg.vaultDir, abs);
        seen.add(id);
        try {
          this.upsertParsed(parseNoteFile(this.cfg.vaultDir, abs));
          indexed++;
        } catch (e) {
          console.error(`[index] failed ${id}: ${(e as Error).message}`);
        }
      }
    });
    tx();
    const all = this.db.prepare("SELECT id FROM notes").all() as { id: string }[];
    let removed = 0;
    for (const { id } of all) {
      if (!seen.has(id)) {
        this.removeId(id);
        removed++;
      }
    }
    return { indexed, removed, ms: Date.now() - t0 };
  }

  upsertFile(abs: string): ParsedNote | null {
    if (this.isIgnored(abs) || !abs.toLowerCase().endsWith(".md")) return null;
    if (!fs.existsSync(abs)) {
      this.removeId(toId(this.cfg.vaultDir, abs));
      return null;
    }
    const note = parseNoteFile(this.cfg.vaultDir, abs);
    this.db.transaction(() => this.upsertParsed(note))();
    for (const fn of this.listeners) fn("upsert", note.id);
    return note;
  }

  private upsertParsed(n: ParsedNote): void {
    const db = this.db;
    db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM titles WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM note_topics WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM note_tags WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM links WHERE from_id = ?").run(n.id);
    db.prepare("DELETE FROM sections WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM sections_fts WHERE note_id = ?").run(n.id);
    db.prepare(
      `INSERT INTO notes (id,title,type,project,visibility,source,modified,captured,size,frontmatter,body,indexed_at)
       VALUES (@id,@title,@type,@project,@visibility,@source,@modified,@captured,@size,@frontmatter,@body,@indexed_at)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title,type=excluded.type,project=excluded.project,
         visibility=excluded.visibility,source=excluded.source,modified=excluded.modified,captured=excluded.captured,
         size=excluded.size,frontmatter=excluded.frontmatter,body=excluded.body,indexed_at=excluded.indexed_at`,
    ).run({
      id: n.id,
      title: n.title,
      type: n.type,
      project: n.project,
      visibility: n.visibility,
      source: n.source,
      modified: n.modified,
      captured: n.captured,
      size: n.size,
      frontmatter: JSON.stringify(n.frontmatter),
      body: n.body,
      indexed_at: new Date().toISOString(),
    });
    // Index the body without the generated "## Connections" trailer so link lists do not dominate ranking or snippets.
    db.prepare("INSERT INTO notes_fts (note_id,title,body) VALUES (?,?,?)").run(n.id, n.title, stripConnections(n.body));
    const insTitle = db.prepare("INSERT OR IGNORE INTO titles (name,note_id) VALUES (?,?)");
    insTitle.run(n.title.toLowerCase(), n.id);
    insTitle.run(path.posix.basename(n.id, ".md").toLowerCase(), n.id);
    for (const a of n.aliases) insTitle.run(a.toLowerCase(), n.id);
    const insTopic = db.prepare("INSERT OR IGNORE INTO note_topics (note_id,topic) VALUES (?,?)");
    for (const t of n.topics) insTopic.run(n.id, t);
    const insTag = db.prepare("INSERT OR IGNORE INTO note_tags (note_id,tag) VALUES (?,?)");
    for (const t of n.tags) insTag.run(n.id, t);
    const insLink = db.prepare("INSERT OR IGNORE INTO links (from_id,target) VALUES (?,?)");
    for (const l of n.links) insLink.run(n.id, l.toLowerCase());
    const insSec = db.prepare("INSERT INTO sections (note_id,ord,heading,level,text) VALUES (?,?,?,?,?)");
    const insSecFts = db.prepare("INSERT INTO sections_fts (note_id,ord,heading,text) VALUES (?,?,?,?)");
    for (const s of splitSections(n.body)) {
      const heading = s.heading || n.title;
      insSec.run(n.id, s.ord, heading, s.level, s.text);
      insSecFts.run(n.id, s.ord, heading, s.text);
    }
  }

  removeId(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM titles WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM note_topics WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM note_tags WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM links WHERE from_id = ?").run(id);
      this.db.prepare("DELETE FROM sections WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM sections_fts WHERE note_id = ?").run(id);
    })();
    for (const fn of this.listeners) fn("remove", id);
  }

  // ------------------------------------------------------------ watcher
  startWatcher(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.cfg.vaultDir, {
      ignoreInitial: true,
      ignored: (p, stats) => {
        if (p === this.cfg.vaultDir) return false;
        if (this.isIgnored(p)) return true;
        return !!stats?.isFile() && !p.toLowerCase().endsWith(".md");
      },
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    const schedule = (abs: string) => {
      const prev = this.pending.get(abs);
      if (prev) clearTimeout(prev);
      this.pending.set(
        abs,
        setTimeout(() => {
          this.pending.delete(abs);
          try {
            this.upsertFile(abs);
          } catch (e) {
            console.error(`[watch] ${abs}: ${(e as Error).message}`);
          }
        }, 150),
      );
    };
    this.watcher
      .on("add", schedule)
      .on("change", schedule)
      .on("unlink", (abs) => this.removeId(toId(this.cfg.vaultDir, abs)))
      .on("error", (e) => console.error(`[watch] ${(e as Error).message}`));
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.db.close();
  }

  // ------------------------------------------------------------ queries
  get(id: string): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  }

  /** Resolve a note by id (path), title, alias, or basename. */
  resolve(ref: string): NoteRow | undefined {
    const r = ref.trim().replace(/^\[\[|\]\]$/g, "");
    const direct = this.get(r) ?? this.get(r.endsWith(".md") ? r : `${r}.md`);
    if (direct) return direct;
    const rows = this.db
      .prepare(
        `SELECT n.* FROM titles t JOIN notes n ON n.id = t.note_id WHERE t.name = ?
         ORDER BY CASE n.type WHEN 'hub' THEN 0 WHEN 'concept' THEN 1 ELSE 2 END, n.modified DESC LIMIT 1`,
      )
      .all(r.toLowerCase()) as NoteRow[];
    return rows[0];
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c;
  }

  private buildFilter(o: SearchOptions, params: Record<string, unknown>): string {
    const w: string[] = [];
    if (o.project) {
      w.push("LOWER(n.project) = @project");
      params.project = o.project.toLowerCase();
    }
    if (o.type) {
      w.push("n.type = @type");
      params.type = o.type;
    }
    if (o.since) {
      w.push("n.modified >= @since");
      params.since = o.since;
    }
    if (o.until) {
      w.push("n.modified <= @until");
      params.until = o.until;
    }
    if (o.topic) {
      w.push("EXISTS (SELECT 1 FROM note_topics nt WHERE nt.note_id = n.id AND LOWER(nt.topic) = @topic)");
      params.topic = o.topic.toLowerCase();
    }
    return w.length ? " AND " + w.join(" AND ") : "";
  }

  search(query: string, o: SearchOptions = {}): SearchHit[] {
    const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const quoted = terms.map((t) => `"${t}"*`);
    const fetchLimit = Math.min(limit * 3, 150);
    const run = (match: string): SearchHit[] => {
      const params: Record<string, unknown> = { match, limit: fetchLimit };
      const filter = this.buildFilter(o, params);
      return this.db
        .prepare(
          `SELECT n.id, n.title, n.type, n.project, n.modified,
                  snippet(notes_fts, 2, '**', '**', ' ... ', 28) AS snippet,
                  bm25(notes_fts, 0, 4.0, 1.0) AS score
           FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id
           WHERE notes_fts MATCH @match ${filter}
           ORDER BY score LIMIT @limit`,
        )
        .all(params) as SearchHit[];
    };
    // Fuse BM25 rank with title overlap so a short note whose title matches beats a huge note that mentions everything.
    const fuse = (hits: SearchHit[]): SearchHit[] =>
      hits
        .map((h, i) => ({ ...h, score: 1 / (RRF_K + i) + TITLE_BONUS * titleOverlap(h.title, terms) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    try {
      const strict = run(quoted.join(" AND "));
      if (strict.length >= Math.min(3, limit) || quoted.length === 1) return fuse(strict);
      const loose = run(quoted.join(" OR "));
      const seen = new Set(strict.map((h) => h.id));
      return fuse([...strict, ...loose.filter((h) => !seen.has(h.id))]);
    } catch (e) {
      console.error(`[search] ${(e as Error).message}`);
      return [];
    }
  }

  /** Section-level full-text search. Same strict-then-loose strategy as note search. */
  searchSections(query: string, o: SearchOptions = {}): SectionHit[] {
    const limit = Math.min(Math.max(o.limit ?? 30, 1), 120);
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const quoted = terms.map((t) => `"${t}"*`);
    const run = (match: string): SectionHit[] => {
      const params: Record<string, unknown> = { match, limit };
      const filter = this.buildFilter(o, params);
      return this.db
        .prepare(
          `SELECT s.note_id, s.ord, s.heading,
                  snippet(sections_fts, 3, '**', '**', ' ... ', 24) AS snippet,
                  bm25(sections_fts, 0, 0, 3.0, 1.0) AS score
           FROM sections_fts s JOIN notes n ON n.id = s.note_id
           WHERE sections_fts MATCH @match ${filter}
           ORDER BY score LIMIT @limit`,
        )
        .all(params) as SectionHit[];
    };
    try {
      const strict = run(quoted.join(" AND "));
      if (strict.length >= Math.min(5, limit) || quoted.length === 1) return strict;
      const loose = run(quoted.join(" OR "));
      const seen = new Set(strict.map((h) => `${h.note_id}#${h.ord}`));
      return [...strict, ...loose.filter((h) => !seen.has(`${h.note_id}#${h.ord}`))].slice(0, limit);
    } catch (e) {
      console.error(`[search-sections] ${(e as Error).message}`);
      return [];
    }
  }

  section(noteId: string, ord: number): SectionRow | undefined {
    return this.db.prepare("SELECT * FROM sections WHERE note_id = ? AND ord = ?").get(noteId, ord) as SectionRow | undefined;
  }

  sectionsOf(noteId: string): SectionRow[] {
    return this.db.prepare("SELECT * FROM sections WHERE note_id = ? ORDER BY ord").all(noteId) as SectionRow[];
  }

  list(o: SearchOptions = {}): NoteRow[] {
    const params: Record<string, unknown> = { limit: Math.min(o.limit ?? 50, 500) };
    const filter = this.buildFilter(o, params);
    return this.db
      .prepare(`SELECT n.* FROM notes n WHERE 1=1 ${filter} ORDER BY n.modified DESC, n.title LIMIT @limit`)
      .all(params) as NoteRow[];
  }

  recent(sinceDate: string, o: { limit?: number; includeStructural?: boolean; project?: string } = {}): NoteRow[] {
    const params: Record<string, unknown> = { since: sinceDate, limit: Math.min(o.limit ?? 30, 200) };
    let filter = "";
    if (!o.includeStructural) filter += " AND n.type NOT IN ('hub','concept','moc','meta','guide')";
    if (o.project) {
      filter += " AND LOWER(n.project) = @project";
      params.project = o.project.toLowerCase();
    }
    return this.db
      .prepare(`SELECT n.* FROM notes n WHERE n.modified >= @since ${filter} ORDER BY n.modified DESC, n.title LIMIT @limit`)
      .all(params) as NoteRow[];
  }

  hubs(): NoteRow[] {
    return this.db.prepare("SELECT * FROM notes WHERE type = 'hub' ORDER BY title").all() as NoteRow[];
  }

  topicsOf(id: string): string[] {
    return (this.db.prepare("SELECT topic FROM note_topics WHERE note_id = ? ORDER BY topic").all(id) as { topic: string }[]).map((r) => r.topic);
  }

  tagsOf(id: string): string[] {
    return (this.db.prepare("SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag").all(id) as { tag: string }[]).map((r) => r.tag);
  }

  outgoing(id: string): { target: string; note: NoteRow | undefined }[] {
    const rows = this.db.prepare("SELECT target FROM links WHERE from_id = ? ORDER BY target").all(id) as { target: string }[];
    return rows.map((r) => ({ target: r.target, note: this.resolve(r.target) }));
  }

  backlinks(id: string, limit = 100): NoteRow[] {
    const names = (this.db.prepare("SELECT name FROM titles WHERE note_id = ?").all(id) as { name: string }[]).map((r) => r.name);
    if (!names.length) return [];
    const q = names.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT DISTINCT n.* FROM links l JOIN notes n ON n.id = l.from_id
         WHERE l.target IN (${q}) AND n.id != ? ORDER BY n.modified DESC LIMIT ?`,
      )
      .all(...names, id, limit) as NoteRow[];
  }

  sharedTopicNeighbours(id: string, limit = 10): { note: NoteRow; shared: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, GROUP_CONCAT(b.topic, '|') AS shared, COUNT(*) AS c
         FROM note_topics a JOIN note_topics b ON a.topic = b.topic AND b.note_id != a.note_id
         JOIN notes n ON n.id = b.note_id
         WHERE a.note_id = ? AND n.type NOT IN ('hub','concept')
         GROUP BY n.id ORDER BY c DESC, n.modified DESC LIMIT ?`,
      )
      .all(id, limit) as { id: string; shared: string }[];
    return rows.map((r) => ({ note: this.get(r.id)!, shared: r.shared.split("|") })).filter((r) => r.note);
  }

  projectNames(): string[] {
    return (this.db.prepare("SELECT DISTINCT project FROM notes WHERE project IS NOT NULL ORDER BY project").all() as { project: string }[]).map((r) => r.project);
  }
}
