import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import chokidar, { type FSWatcher } from "chokidar";
import { codeLines, extractLinks, linkWindows, parseNoteFile, splitSections, stripConnections, stripLink, toId, type ParsedNote } from "./parse.js";
import { LinkGraph, STRUCTURAL_TYPES } from "./graph.js";
import { DenseIndex } from "./dense.js";
import { FactStore } from "../facts.js";
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

/** An existing note a text names without linking it. */
export interface Mention {
  id: string;
  title: string;
  /** The name as found: the title or one of its aliases. */
  name: string;
  /** The sentence around the first mention. */
  snippet: string;
}

export interface SearchOptions {
  project?: string;
  type?: string;
  topic?: string;
  since?: string; // YYYY-MM-DD
  until?: string;
  limit?: number;
  /** Notes the caller may read. Ranking drops the rest before fusion, so they never take a reranker slot or decide coverage. */
  readable?: (n: NoteRow) => boolean;
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
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  from_ord INTEGER,
  kind TEXT NOT NULL,
  fm_key TEXT,
  target TEXT NOT NULL,
  target_heading TEXT,
  ctx TEXT,
  PRIMARY KEY (from_id, pos)
);
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
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts2 USING fts5(
  note_id UNINDEXED,
  ord UNINDEXED,
  title,
  heading,
  text,
  project,
  topics,
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

/** One section after hybrid ranking. `score` is the blended rank; `rprob` the reranker's own probability (NaN when it did not run). */
export interface RankedSection {
  note_id: string;
  ord: number;
  heading: string;
  text: string;
  note: NoteRow;
  score: number;
  rprob: number;
  why: string[];
}

/** Counts for the audit log and the evals: list sizes, fused candidates, how many reached and passed the reranker. */
export interface RankStats {
  lists: { lex: number; den: number; exact: number; note: number };
  fused: number;
  /** Sections handed to the reranker stage (or kept, on the keyword-only path). */
  pool: number;
  /** Pairs the cross-encoder actually scored. */
  reranked: number;
  /** Best reranker probability; null when the reranker did not run. */
  topProb: number | null;
}

/** Why a pooled section did or did not reach the result: kept, refused by the floor, trimmed by keepRatio, or past k. */
export type PoolCut = "kept" | "floor" | "trim" | "limit";

export interface PoolEntry {
  key: string;
  /** head: inside the top `rerankN` of the fused list · first: a list's first pick added below it */
  src: "head" | "first";
  /** 1-based position in the fused list. */
  fusedRank: number;
  reranked: boolean;
  prob: number | null;
  score: number | null;
  cut: PoolCut;
}

/** The ranker's working state for one query, returned only when asked for (`debug: true`). */
export interface RankDebug {
  lists: { lex: string[]; den: string[]; exact: string[]; note: string[] };
  /** Fused order, best first (at most 200). */
  fused: { key: string; score: number }[];
  pool: PoolEntry[];
}

export interface RankResult {
  sections: RankedSection[];
  /** good: confident hit · thin: weak best hit, answer with a caveat · none: the vault is silent · lexical: models unavailable, keyword ranking only */
  coverage: "good" | "thin" | "none" | "lexical";
  corrections: string[];
  terms: string[];
  earlyExit: boolean;
  ms: number;
  stats: RankStats;
  debug?: RankDebug;
}

export interface HybridSearchResult {
  hits: SearchHit[];
  coverage: RankResult["coverage"];
  corrections: string[];
  stats: RankStats;
}

/** Reciprocal rank fusion over ranked lists keyed by section. */
function rrf<T extends { key: string }>(lists: T[][], k = RRF_K_FUSION): { key: string; score: number; item: T }[] {
  const acc = new Map<string, { score: number; item: T }>();
  for (const l of lists) {
    l.forEach((r, rank) => {
      const cur = acc.get(r.key);
      const add = 1 / (k + rank + 1);
      if (cur) cur.score += add;
      else acc.set(r.key, { score: add, item: r });
    });
  }
  return [...acc.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.score - a.score);
}
const RRF_K_FUSION = 60;

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
  /** Embeddings + reranker; null when `retrieval.hybrid` is off. Models load lazily on first use. */
  readonly dense: DenseIndex | null;
  /** Facts from the memory file with their validity windows, rebuilt whenever that file is indexed. */
  readonly facts: FactStore;
  /** Link occurrences resolved to notes and weighted, rebuilt lazily after any change. */
  readonly graph: LinkGraph;
  private readonly memoryId: string;
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(event: "upsert" | "remove", id: string) => void>();

  constructor(readonly cfg: ResolvedConfig) {
    this.db = new Database(path.join(cfg.dataDir, "index.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.dense = cfg.retrieval.hybrid ? new DenseIndex(this.db, cfg.modelsDir, cfg.retrieval) : null;
    this.graph = new LinkGraph(this.db, cfg.retrieval);
    this.memoryId = cfg.memoryFile.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    this.facts = new FactStore(this.db);
    // An index built before the facts table existed already holds the memory file: derive the table from it now.
    this.facts.rebuild(this.memoryNote()?.body ?? null);
  }

  private isMemoryFile(id: string): boolean {
    return id.toLowerCase() === this.memoryId;
  }

  private memoryNote(): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE LOWER(id) = ?").get(this.memoryId) as NoteRow | undefined;
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
    // Sorted by byte order: row order decides exact ties in BM25, and readdir order differs between filesystems.
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
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
    // Vectors are hash-keyed, so this only embeds sections whose text changed since the last run.
    this.dense?.schedule(500);
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
    this.dense?.schedule();
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
    db.prepare("DELETE FROM edges WHERE from_id = ?").run(n.id);
    db.prepare("DELETE FROM sections WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM sections_fts WHERE note_id = ?").run(n.id);
    db.prepare("DELETE FROM sections_fts2 WHERE note_id = ?").run(n.id);
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
    // sections_fts2 carries the note title, project and topics on every window so a title match counts in section BM25.
    const insSecFts2 = db.prepare("INSERT INTO sections_fts2 (note_id,ord,title,heading,text,project,topics) VALUES (?,?,?,?,?,?,?)");
    const topics = n.topics.join(" ");
    const sections = splitSections(n.body);
    let count = 0;
    for (const s of sections) {
      const heading = s.heading || n.title;
      insSec.run(n.id, s.ord, heading, s.level, s.text);
      insSecFts.run(n.id, s.ord, heading, s.text);
      insSecFts2.run(n.id, s.ord, n.title, heading, s.text, n.project ?? "", topics);
      count++;
    }
    // Every link occurrence, with the section window it sits in; resolution to notes happens in the graph.
    const insEdge = db.prepare("INSERT INTO edges (from_id,pos,from_ord,kind,fm_key,target,target_heading,ctx) VALUES (?,?,?,?,?,?,?,?)");
    const ords = linkWindows(n.body, n.linkOccs, sections);
    n.linkOccs.forEach((o, i) => insEdge.run(n.id, o.pos, ords[i], o.kind, o.fmKey, o.target, o.heading, o.ctx));
    this.graph.markDirty();
    // Keep vectors for ordinals that still exist (their hash decides whether they are re-embedded); drop the rest.
    this.dense?.forget(n.id, count);
    if (this.isMemoryFile(n.id)) this.facts.rebuild(n.body);
  }

  removeId(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM titles WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM note_topics WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM note_tags WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM links WHERE from_id = ?").run(id);
      this.db.prepare("DELETE FROM edges WHERE from_id = ?").run(id);
      this.graph.markDirty();
      this.db.prepare("DELETE FROM sections WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM sections_fts WHERE note_id = ?").run(id);
      this.db.prepare("DELETE FROM sections_fts2 WHERE note_id = ?").run(id);
      this.dense?.forget(id);
      if (this.isMemoryFile(id)) this.facts.rebuild(null);
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
    this.dense?.stop();
    await this.watcher?.close();
    this.db.close();
  }

  // ------------------------------------------------------------ queries
  get(id: string): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  }

  /**
   * Resolve a note someone names (a tool argument): its id (path, in any case, .md optional), then a title, file name
   * or alias (a hub wins a shared name, then a concept page, then the newest note), then the link rules: path suffix,
   * names ignoring hyphens and underscores, retrieval shorthands (see LinkGraph.resolve).
   */
  resolve(ref: string): NoteRow | undefined {
    const r = ref.trim().replace(/^\[\[|\]\]$/g, "");
    const direct = this.get(r) ?? this.get(r.endsWith(".md") ? r : `${r}.md`);
    if (direct) return direct;
    const lower = r.toLowerCase();
    const anyCase = this.db.prepare("SELECT * FROM notes WHERE lower(id) IN (?, ?) ORDER BY id LIMIT 1").get(lower, lower.endsWith(".md") ? lower : `${lower}.md`) as NoteRow | undefined;
    if (anyCase) return anyCase;
    const rows = this.db
      .prepare(
        `SELECT n.* FROM titles t JOIN notes n ON n.id = t.note_id WHERE t.name = ?
         ORDER BY CASE n.type WHEN 'hub' THEN 0 WHEN 'concept' THEN 1 ELSE 2 END, n.modified DESC, n.id LIMIT 1`,
      )
      .all(lower) as NoteRow[];
    if (rows[0]) return rows[0];
    return r ? this.resolveLink("", r) : undefined;
  }

  /** The note a link written in `fromId` points at, by the link rules (see LinkGraph.resolve). */
  resolveLink(fromId: string, target: string): NoteRow | undefined {
    const to = this.graph.resolve(fromId, target);
    return to ? this.get(to) : undefined;
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
      const params: Record<string, unknown> = { match };
      const filter = this.buildFilter(o, params);
      const stmt = this.db.prepare(
        `SELECT n.id, n.title, n.type, n.project, n.modified,
                snippet(notes_fts, 2, '**', '**', ' ... ', 28) AS snippet,
                bm25(notes_fts, 0, 4.0, 1.0) AS score
         FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id
         WHERE notes_fts MATCH @match ${filter}
         ORDER BY score LIMIT @limit OFFSET @offset`,
      );
      return this.readableRows((limit, offset) => stmt.all({ ...params, limit, offset }) as SearchHit[], fetchLimit, (h) => h.id, o.readable);
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
      const params: Record<string, unknown> = { match };
      const filter = this.buildFilter(o, params);
      const stmt = this.db.prepare(
        `SELECT s.note_id, s.ord, s.heading,
                snippet(sections_fts, 3, '**', '**', ' ... ', 24) AS snippet,
                bm25(sections_fts, 0, 0, 3.0, 1.0) AS score
         FROM sections_fts s JOIN notes n ON n.id = s.note_id
         WHERE sections_fts MATCH @match ${filter}
         ORDER BY score LIMIT @limit OFFSET @offset`,
      );
      return this.readableRows((n, offset) => stmt.all({ ...params, limit: n, offset }) as SectionHit[], limit, (h) => h.note_id, o.readable);
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

  // ------------------------------------------------------------ hybrid ranking
  /**
   * Query terms plus alias expansions and spelling corrections (originals are kept alongside). A correction must be a
   * word some note the caller may read holds: a word only private notes use must not show up as "spelling read as".
   */
  private understand(q: string, readable?: (n: NoteRow) => boolean): { terms: string[]; corrections: string[] } {
    const raw = queryTerms(q);
    const out = new Set<string>();
    const corrections: string[] = [];
    const aliases = this.cfg.retrieval.aliases;
    for (const t of raw) {
      // Own keys only: the term "constructor" must not reach Object.prototype.
      const expanded = Object.hasOwn(aliases, t) ? aliases[t] : undefined;
      if (typeof expanded === "string") for (const x of queryTerms(expanded)) out.add(x);
      out.add(t);
      const c = this.dense?.correct(t);
      if (c && (!readable || this.wordReadable(c, readable))) {
        corrections.push(`${t}→${c}`);
        out.add(c);
      }
    }
    const lq = q.toLowerCase();
    for (const [k, v] of Object.entries(aliases)) if (typeof v === "string" && k.includes(" ") && lq.includes(k)) for (const x of queryTerms(v)) out.add(x);
    return { terms: [...out], corrections };
  }

  private wordReadable(word: string, readable: (n: NoteRow) => boolean): boolean {
    try {
      const rows = this.db.prepare("SELECT DISTINCT note_id FROM sections_fts2 WHERE sections_fts2 MATCH ?").all(`"${word.replace(/"/g, "")}"`) as { note_id: string }[];
      return rows.some((r) => {
        const n = this.get(r.note_id);
        return !!n && readable(n);
      });
    } catch {
      return false;
    }
  }

  private noteFilterOk(n: NoteRow | undefined, o: SearchOptions): n is NoteRow {
    if (!n) return false;
    if (o.project && (n.project ?? "").toLowerCase() !== o.project.toLowerCase()) return false;
    if (o.type && n.type !== o.type) return false;
    if (o.since && n.modified < o.since) return false;
    if (o.until && n.modified > o.until) return false;
    if (o.topic && !this.topicsOf(n.id).some((t) => t.toLowerCase() === o.topic!.toLowerCase())) return false;
    if (o.readable && !o.readable(n)) return false;
    return true;
  }

  /** Section BM25 over the OR of all terms (title x4, heading x2, project/topics x1.5), honouring the note filters. */
  private bm25Sections(terms: string[], o: SearchOptions, limit: number): { key: string; note_id: string; ord: number }[] {
    if (!terms.length) return [];
    const params: Record<string, unknown> = { match: terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ") };
    const filter = this.buildFilter(o, params);
    try {
      const stmt = this.db.prepare(
        `SELECT s.note_id, s.ord, bm25(sections_fts2, 0, 0, 4.0, 2.0, 1.0, 1.5, 1.5) AS score
         FROM sections_fts2 s JOIN notes n ON n.id = s.note_id
         WHERE sections_fts2 MATCH @match ${filter} ORDER BY score LIMIT @limit OFFSET @offset`,
      );
      const rows = this.readableRows((n, offset) => stmt.all({ ...params, limit: n, offset }) as { note_id: string; ord: number }[], limit, (r) => r.note_id, o.readable);
      return rows.map((r) => ({ key: `${r.note_id}#${r.ord}`, note_id: r.note_id, ord: r.ord }));
    } catch (e) {
      console.error(`[rank] bm25: ${(e as Error).message}`);
      return [];
    }
  }

  /** Sections containing an ISO date verbatim: FTS5 splits 2026-09-24 into three weak tokens, so this list restores exact matches. */
  private dateHits(dates: string[], o: SearchOptions): { key: string; note_id: string; ord: number }[] {
    // Filtered before the cut of 40, so notes the caller may not read cannot take the places.
    const stmt = this.db.prepare("SELECT note_id, ord FROM sections WHERE instr(text, ?) > 0 ORDER BY note_id, ord");
    const out: { key: string; note_id: string; ord: number }[] = [];
    for (const d of dates) {
      let n = 0;
      for (const r of stmt.all(d) as { note_id: string; ord: number }[]) {
        if (n >= 40) break;
        if (!this.noteFilterOk(this.get(r.note_id), o)) continue;
        out.push({ key: `${r.note_id}#${r.ord}`, ...r });
        n++;
      }
    }
    return out;
  }

  /**
   * The first `want` rows of a ranked query whose notes the caller may read. A SQL LIMIT counts every note, so without
   * this a vault with many private matches would push readable ones out of the list; pages are fetched until enough
   * readable rows are found. Without a readable check this is one query.
   */
  private readableRows<T>(fetch: (limit: number, offset: number) => T[], want: number, noteOf: (r: T) => string, readable?: (n: NoteRow) => boolean): T[] {
    if (!readable) return fetch(want, 0);
    const out: T[] = [];
    const page = Math.max(2 * want, 50);
    for (let offset = 0; out.length < want; offset += page) {
      const rows = fetch(page, offset);
      for (const r of rows) {
        const n = this.get(noteOf(r));
        if (n && readable(n)) out.push(r);
      }
      if (rows.length < page) break;
    }
    return out.slice(0, want);
  }

  /**
   * Hybrid section ranking: aliases + spelling → BM25 ∥ dense ∥ exact-date lists → RRF → cross-encoder
   * rerank of the top `rerankN` (only the top 3 when BM25 and dense already agree on #1) → blended score
   * → gate. Falls back to keyword-only fusion (coverage "lexical") when the models are unavailable.
   */
  async rankSections(query: string, o: SearchOptions & { k?: number; debug?: boolean } = {}): Promise<RankResult> {
    const t0 = Date.now();
    const rc = this.cfg.retrieval;
    const k = Math.min(Math.max(o.k ?? 10, 1), 50);
    const u = this.understand(query, o.readable);
    const dates = query.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
    const noteCache = new Map<string, NoteRow | undefined>();
    const noteOf = (id: string) => {
      if (!noteCache.has(id)) noteCache.set(id, this.get(id));
      return noteCache.get(id);
    };
    // The SQL filters cover project/type/dates/topic; readability is checked while each list is filled, so notes the
    // caller may not read never take a place in it (see readableRows).
    const lex = this.bm25Sections(u.terms, o, 40);
    const exact = dates.length ? this.dateHits(dates, o) : [];
    const modelsOk = this.dense ? await this.dense.ready() : false;
    const den = modelsOk
      ? (o.readable ? (await this.dense!.search(query, Infinity)).filter((h) => { const n = noteOf(h.note_id); return !!n && o.readable!(n); }).slice(0, 40) : await this.dense!.search(query, 40))
          .filter((h) => this.noteFilterOk(noteOf(h.note_id), o))
          .map((h) => ({ key: `${h.note_id}#${h.ord}`, note_id: h.note_id, ord: h.ord }))
      : [];
    // Note-level BM25 (title x4 over the whole body) as a fourth list, anchored on each note's first window:
    // a note whose title names the subject still competes when no single window carries every term.
    // A note with no section (an empty file, or frontmatter only) has nothing to return, so its title alone must not
    // reach the reranker and win the coverage label.
    const secStmt = this.db.prepare("SELECT heading, text FROM sections WHERE note_id = ? AND ord = ?");
    const noteList = this.search(u.terms.join(" "), { ...o, limit: 15 })
      .filter((h) => this.noteFilterOk(noteOf(h.id), o) && secStmt.get(h.id, 0))
      .map((h) => ({ key: `${h.id}#0`, note_id: h.id, ord: 0 }));
    const lists = [lex, den, exact, noteList].filter((l) => l.length);
    const fused = rrf(lists);
    const materialise = (item: { note_id: string; ord: number }, score: number, rprob: number, why: string[]): RankedSection | null => {
      const note = noteOf(item.note_id);
      const sec = secStmt.get(item.note_id, item.ord) as { heading: string; text: string } | undefined;
      if (!note || !sec) return null;
      return { note_id: item.note_id, ord: item.ord, heading: sec.heading, text: sec.text, note, score, rprob, why };
    };
    const stats: RankStats = {
      lists: { lex: lex.length, den: den.length, exact: exact.length, note: noteList.length },
      fused: fused.length,
      pool: 0,
      reranked: 0,
      topProb: null,
    };
    const debug: RankDebug | undefined = o.debug
      ? {
          lists: { lex: lex.map((x) => x.key), den: den.map((x) => x.key), exact: exact.map((x) => x.key), note: noteList.map((x) => x.key) },
          fused: fused.slice(0, 200).map((f) => ({ key: f.key, score: f.score })),
          pool: [],
        }
      : undefined;
    const done = (sections: RankedSection[], coverage: RankResult["coverage"], earlyExit: boolean): RankResult => ({
      sections,
      coverage,
      corrections: u.corrections,
      terms: u.terms,
      earlyExit,
      ms: Date.now() - t0,
      stats,
      ...(debug ? { debug } : {}),
    });
    if (!fused.length) return done([], modelsOk ? "none" : "lexical", false);
    const fusedTop = fused[0].score;

    if (!modelsOk) {
      const out: RankedSection[] = [];
      for (const f of fused.slice(0, k)) {
        const s = materialise(f.item, f.score / fusedTop, NaN, ["keyword fusion"]);
        if (s) out.push(s);
      }
      stats.pool = out.length;
      if (debug)
        debug.pool = fused.slice(0, k).map((f, i) => ({ key: f.key, src: "head", fusedRank: i + 1, reranked: false, prob: null, score: f.score / fusedTop, cut: "kept" }));
      return done(out, "lexical", false);
    }

    const cands = fused.slice(0, rc.rerankN);
    const headN = cands.length;
    if (rc.firstPicks) {
      // Every list's first pick is reranked wherever fusion put it. A section only one list finds, such as one fact in
      // the long memory file, can fall far below other notes' first windows that collect votes from several lists.
      for (const best of [lex[0], den[0], exact[0], noteList[0]]) {
        if (!best || cands.some((c) => c.key === best.key)) continue;
        const f = fused.find((x) => x.key === best.key);
        if (f) cands.push(f);
      }
    }
    if (!cands.length) return done([], "none", false);
    // The shortcut needs the agreed section inside the reranked head. The note-level list can lift other notes'
    // first windows above it (a long note such as the memory file competes there through its first window only),
    // and a head without it would gate a well-answered query to "none". With firstPicks off this is 0.4.0's rule,
    // which took the shortcut whenever the two lists agreed.
    const agree =
      rc.earlyExit &&
      lex.length > 0 &&
      den.length > 0 &&
      lex[0].key === den[0].key &&
      (!rc.firstPicks || cands.slice(0, 3).some((c) => c.key === lex[0].key));
    const passage = (c: { item: { note_id: string; ord: number } }) => {
      const note = noteOf(c.item.note_id);
      const sec = secStmt.get(c.item.note_id, c.item.ord) as { heading: string; text: string } | undefined;
      const head = sec && note && sec.heading.toLowerCase() !== note.title.toLowerCase() ? ` / ${sec.heading}` : "";
      return `${note?.title ?? ""}${head}\n${sec?.text ?? ""}`;
    };
    let probs: number[];
    if (agree) {
      // Lexical and dense agree on the best section: rerank only the head for a calibrated gate and
      // ordering; the tail keeps its fused order, scaled strictly below the weakest reranked item.
      const head = await this.dense!.rerank(query, cands.slice(0, 3).map(passage));
      const headMin = Math.min(...head);
      probs = cands.map((c, i) => (i < head.length ? head[i] : 0.9 * headMin * (c.score / fusedTop)));
    } else {
      probs = await this.dense!.rerank(query, cands.map(passage));
    }
    const reranked = agree ? Math.min(3, cands.length) : cands.length;
    const topR = Math.max(...probs.slice(0, reranked));
    stats.pool = cands.length;
    stats.reranked = reranked;
    stats.topProb = topR;
    const fusedRankOf = new Map(fused.map((f, i) => [f.key, i + 1]));
    const pool: PoolEntry[] = cands.map((c, i) => ({
      key: c.key,
      src: i < headN ? "head" : "first",
      fusedRank: fusedRankOf.get(c.key) ?? 0,
      reranked: i < reranked,
      prob: i < reranked ? probs[i] : null,
      score: null,
      cut: "floor",
    }));
    if (debug) debug.pool = pool;
    // With agreeOverride, keyword and meaning search putting the same section first answers "thin" with that note
    // instead of refusing: evidence the reranker missed, though one rare shared word makes both searches agree too.
    const searchAgrees = rc.agreeOverride && lex.length > 0 && den.length > 0 && lex[0].key === den[0].key;
    if (topR < rc.floor && !searchAgrees) return done([], "none", agree);
    const overridden = topR < rc.floor;
    const scored = cands.map((c, i) => ({ c, i, prob: probs[i], score: (1 - rc.blend) * probs[i] + rc.blend * (c.score / fusedTop), reranked: i < reranked }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0].score;
    const out: RankedSection[] = [];
    // Sorted best first, so once one entry is trimmed or past k, every later one is too. The best `minKeep` are
    // never trimmed: the second note of a two-note answer often scores far below the first.
    let stop: PoolCut | null = null;
    for (const s of scored) {
      pool[s.i].score = s.score;
      // An overridden answer vouches for the agreed note only; everything else scored under the floor.
      if (overridden && s.c.item.note_id !== lex[0].note_id) {
        pool[s.i].cut = "floor";
        continue;
      }
      if (!stop && out.length >= rc.minKeep && s.score < Math.max(0.02, rc.keepRatio * top)) stop = "trim";
      if (!stop && out.length >= k) stop = "limit";
      if (stop) {
        pool[s.i].cut = stop;
        continue;
      }
      const why = [s.reranked ? `rerank ${s.prob.toFixed(2)}` : "fused tail", ...(lex.some((x) => x.key === s.c.key) ? ["keyword"] : []), ...(den.some((x) => x.key === s.c.key) ? ["semantic"] : []), ...(exact.some((x) => x.key === s.c.key) ? ["exact date"] : []), ...(noteList.some((x) => x.key === s.c.key) ? ["title"] : [])];
      const sec = materialise(s.c.item, s.score, s.reranked ? s.prob : NaN, why);
      if (sec) {
        out.push(sec);
        pool[s.i].cut = "kept";
      }
    }
    return done(out, !overridden && topR >= rc.goodAt ? "good" : "thin", agree);
  }

  /** Note-level hybrid search: a note scores as its best section, which also supplies the snippet. */
  async searchHybrid(query: string, o: SearchOptions = {}): Promise<HybridSearchResult> {
    const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
    const r = await this.rankSections(query, { ...o, k: Math.min(limit * 3, 50) });
    const byNote = new Map<string, RankedSection>();
    for (const s of r.sections) if (!byNote.has(s.note_id)) byNote.set(s.note_id, s);
    const hits: SearchHit[] = [...byNote.values()].slice(0, limit).map((s) => ({
      id: s.note_id,
      title: s.note.title,
      type: s.note.type,
      project: s.note.project,
      modified: s.note.modified,
      snippet: `${s.heading && s.heading !== s.note.title ? `[${s.heading}] ` : ""}${s.text.replace(/^#+\s.*\n?/, "").replace(/\s+/g, " ").slice(0, 220)}`,
      score: s.score,
    }));
    return { hits, coverage: r.coverage, corrections: r.corrections, stats: r.stats };
  }

  section(noteId: string, ord: number): SectionRow | undefined {
    return this.db.prepare("SELECT * FROM sections WHERE note_id = ? AND ord = ?").get(noteId, ord) as SectionRow | undefined;
  }

  /**
   * The id of the fact a memory-file section belongs to, or null. Found by position, numbering a repeated stamp
   * " #2", " #3" the way parseMemoryBlocks does, since two facts saved in one minute share a heading. A fact's first
   * window starts with its "## " heading line; later windows of a long fact carry the heading but not the line.
   */
  factIdOfSection(noteId: string, ord: number): string | null {
    if (!this.isMemoryFile(noteId)) return null;
    const seen = new Map<string, number>();
    let current: string | null = null;
    for (const s of this.sectionsOf(noteId)) {
      const stamp = s.level === 2 ? s.heading.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · \w+$/)?.[1] : undefined;
      if (!stamp) current = null;
      else if (s.text.startsWith("## ")) {
        const n = (seen.get(stamp) ?? 0) + 1;
        seen.set(stamp, n);
        current = n > 1 ? `${stamp} #${n}` : stamp;
      }
      if (s.ord === ord) return current;
    }
    return null;
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

  /** The links a note makes (ParsedNote.links), each resolved by the link rules; `note` is undefined when nothing matches. */
  outgoing(id: string): { target: string; note: NoteRow | undefined }[] {
    const rows = this.db.prepare("SELECT target FROM links WHERE from_id = ? ORDER BY target").all(id) as { target: string }[];
    return rows.map((r) => ({ target: r.target, note: this.resolveLink(id, r.target) }));
  }

  /** Notes whose links resolve to this one (same rules as outgoing), newest first. */
  backlinks(id: string, limit = 100): NoteRow[] {
    return this.graph
      .linkers(id)
      .filter((from) => from !== id)
      .map((from) => this.get(from))
      .filter((n): n is NoteRow => !!n)
      .sort((a, b) => (a.modified !== b.modified ? (a.modified < b.modified ? 1 : -1) : a.id < b.id ? -1 : 1))
      .slice(0, limit);
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

  /**
   * Existing notes a text names without linking: titles and aliases of notes the caller may read, the first mention
   * of each, at most `max`, in the order they appear. Left out: hubs and concept pages, the memory file, `selfId`, and
   * any note the text already links. A name needs two or more words (any case), or one word of five or more letters
   * written with the title's own capitals that occurs in at most 5% of sections, so common words stay quiet. Code,
   * links, URLs and headings are not searched. Write tools return these so the caller can link them in a sentence.
   */
  unlinkedMentions(written: string, selfId: string | null, canRead: (n: NoteRow) => boolean, max = 3): Mention[] {
    // Blank out what must not match, keeping positions so snippets come from the original text.
    const text = written.replace(/\r\n/g, "\n");
    const blank = (s: string) => s.replace(/[^\n]/g, " ");
    const lines = text.split("\n");
    const code = codeLines(lines);
    let masked = lines.map((l, i) => (code[i] ? blank(l) : l)).join("\n");
    masked = masked.replace(/`[^`\n]*`/g, blank).replace(/!?\[\[[^\]\n]*\]\]/g, blank).replace(/\]\([^)\n]*\)/g, blank).replace(/https?:\/\/\S+/g, blank);
    masked = masked.replace(/^#{1,6}\s.*$/gm, blank);
    const lower = masked.toLowerCase();
    const linked = new Set<string>();
    for (const o of extractLinks(text, {})) {
      const id = this.graph.resolve(selfId ?? "", o.target);
      if (id) linked.add(id);
    }
    const nSections = (this.db.prepare("SELECT COUNT(*) c FROM sections").get() as { c: number }).c || 1;
    // A word is common when other notes use it a lot: the named note's own sections and the note being written don't count.
    const dfStmt = this.db.prepare("SELECT COUNT(*) c FROM sections_fts2 WHERE sections_fts2 MATCH ? AND note_id NOT IN (?, ?)");
    const rare = (word: string, noteId: string) => {
      try {
        return (dfStmt.get(`"${word.replace(/"/g, "")}"`, noteId, selfId ?? "") as { c: number }).c <= 0.05 * nSections;
      } catch {
        return false;
      }
    };
    const names: { id: string; title: string; name: string }[] = [];
    const rows = this.db.prepare("SELECT id, title, type, project, visibility, frontmatter FROM notes ORDER BY id").all() as NoteRow[];
    for (const r of rows) {
      if (r.id === selfId || this.isMemoryFile(r.id) || STRUCTURAL_TYPES.has(r.type) || linked.has(r.id) || !canRead(r)) continue;
      let aliases: string[] = [];
      try {
        const fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
        aliases = (Array.isArray(fm.aliases) ? fm.aliases : typeof fm.aliases === "string" ? fm.aliases.split(",") : []).map((a) => stripLink(a)).filter(Boolean);
      } catch {}
      for (const name of new Set([r.title, ...aliases].map((s) => s.trim()).filter(Boolean))) names.push({ id: r.id, title: r.title, name });
    }
    // Longest names first, so "Harbor Ledger progress" wins over "Harbor Ledger" where both fit.
    names.sort((a, b) => b.name.length - a.name.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const found: (Mention & { at: number })[] = [];
    const taken: [number, number][] = [];
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n.id)) continue;
      const multi = /\s/.test(n.name);
      if (!multi && (n.name.length < 5 || !/^\p{L}/u.test(n.name))) continue;
      if (!lower.includes(n.name.toLowerCase())) continue;
      const esc = n.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, multi ? "iu" : "u");
      const m = re.exec(masked);
      if (!m) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      if (!multi && !rare(n.name, n.id)) continue;
      taken.push([start, end]);
      seen.add(n.id);
      // The sentence holding the mention, from the original text.
      const before = text.slice(0, start);
      const from = Math.max(before.lastIndexOf("\n"), before.search(/[.!?]\s[^.!?]*$/) + 1, 0);
      const afterIdx = text.slice(end).search(/[.!?\n]/);
      const to = afterIdx < 0 ? text.length : end + afterIdx + 1;
      let snippet = text.slice(from, to).replace(/\s+/g, " ").trim();
      if (snippet.length > 160) snippet = `${snippet.slice(0, 157).trimEnd()}…`;
      found.push({ id: n.id, title: n.title, name: m[0], snippet, at: start });
    }
    return found
      .sort((a, b) => a.at - b.at)
      .slice(0, max)
      .map(({ at, ...m }) => m);
  }
}
