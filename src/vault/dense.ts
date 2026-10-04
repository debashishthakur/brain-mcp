import crypto from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Local dense retrieval for the vault: section embeddings (bge-small, int8) stored next to the FTS
 * tables, plus a cross-encoder reranker (bge-reranker-base, int8). Both models run on CPU through
 * onnxruntime and are fetched once into `<dataDir>/models`; nothing leaves the machine.
 *
 * Vectors are keyed by a hash of the embedded text, so a restart or an unchanged note never
 * re-embeds. Embedding runs in the background after every reindex or upsert; until vectors exist
 * the hybrid ranker degrades to lexical-only, so the server is never blocked on a model.
 */

export interface DenseConfig {
  hybrid: boolean;
  embedModel: string;
  rerankModel: string;
  /** Characters of a section fed to the embedder (title + heading are prepended). */
  embedChars: number;
  rerankN: number;
  /** Token cap per query/passage pair in the reranker. 256 loses answers that sit late in a section; 384 does not. */
  rerankMaxLen: number;
  /** Weight of the fused lexical/dense rank in the final score; the reranker gets the rest. */
  blend: number;
  /** Best reranker probability below which the vault is declared silent on the question. */
  floor: number;
  /** Keep hits scoring at least this fraction of the best hit. */
  keepRatio: number;
  earlyExit: boolean;
  aliases: Record<string, string>;
}

export const DENSE_DEFAULTS: DenseConfig = {
  hybrid: true,
  embedModel: "Xenova/bge-small-en-v1.5",
  rerankModel: "Xenova/bge-reranker-base",
  embedChars: 1500,
  rerankN: 16,
  rerankMaxLen: 384,
  blend: 0.2,
  floor: 0.05,
  keepRatio: 0.3,
  earlyExit: true,
  // Generic shorthands only. Put your own (project nicknames, people, places) under
  // `retrieval.aliases` in brain.config.json; they are merged on top of these.
  aliases: {
    mcp: "Model Context Protocol",
    pg: "PostgreSQL",
    postgres: "PostgreSQL",
    k8s: "Kubernetes",
    ts: "TypeScript",
    js: "JavaScript",
    py: "Python",
    oauth2: "OAuth",
    cv: "resume",
    sysdesign: "system design",
  },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS section_vectors (
  note_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  v BLOB NOT NULL,
  PRIMARY KEY (note_id, ord)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sections_vocab USING fts5vocab(sections_fts2, 'row');
`;

export interface DenseHit {
  note_id: string;
  ord: number;
  score: number;
}

type Embedder = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
interface Reranker {
  tok: (a: string[], o: Record<string, unknown>) => Record<string, unknown>;
  model: (enc: Record<string, unknown>) => Promise<{ logits: { data: Float32Array } }>;
}

export function embedInput(title: string, heading: string, text: string, embedChars: number): string {
  const head = heading && heading.toLowerCase() !== title.toLowerCase() ? ` / ${heading}` : "";
  return `${title}${head}\n${text.slice(0, embedChars)}`;
}

export class DenseIndex {
  private embedder: Embedder | null = null;
  private reranker: Reranker | null = null;
  private loading: Promise<boolean> | null = null;
  private disabled = false;
  private embedding = false;
  private embedAgain = false;
  private scheduled: NodeJS.Timeout | null = null;
  private keys: { note_id: string; ord: number }[] = [];
  private mat = new Float32Array(0);
  private dim = 0;
  private dirty = true;
  readonly modelsDir: string;

  constructor(
    readonly db: Database.Database,
    dataDir: string,
    readonly cfg: DenseConfig,
  ) {
    this.modelsDir = path.join(dataDir, "models");
    db.exec(SCHEMA);
  }

  /** True once both models are in memory; false if they could not be loaded (then the ranker stays lexical). */
  async ready(): Promise<boolean> {
    if (this.disabled) return false;
    if (this.embedder && this.reranker) return true;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const t0 = Date.now();
          const tf = await import("@huggingface/transformers");
          tf.env.cacheDir = this.modelsDir;
          const pipe = (await tf.pipeline("feature-extraction", this.cfg.embedModel, { dtype: "q8" })) as unknown as Embedder;
          const tok = await tf.AutoTokenizer.from_pretrained(this.cfg.rerankModel);
          const model = await tf.AutoModelForSequenceClassification.from_pretrained(this.cfg.rerankModel, { dtype: "q8" });
          this.embedder = pipe;
          this.reranker = {
            tok: (a, o) => tok(a, o) as unknown as Record<string, unknown>,
            model: (enc) => model(enc) as unknown as Promise<{ logits: { data: Float32Array } }>,
          };
          console.error(`[dense] models ready in ${Date.now() - t0} ms (${this.cfg.embedModel}, ${this.cfg.rerankModel})`);
          return true;
        } catch (e) {
          this.disabled = true;
          console.error(`[dense] models unavailable, retrieval stays lexical: ${(e as Error).message}`);
          return false;
        }
      })();
    }
    return this.loading;
  }

  stats(): { vectors: number; loaded: boolean; disabled: boolean } {
    const vectors = (this.db.prepare("SELECT COUNT(*) c FROM section_vectors WHERE model = ?").get(this.cfg.embedModel) as { c: number }).c;
    return { vectors, loaded: !!(this.embedder && this.reranker), disabled: this.disabled };
  }

  // ------------------------------------------------------------ maintenance
  /** Drop vectors for a note (all of them, or only ordinals past `keepBelow`). */
  forget(noteId: string, keepBelow?: number): void {
    if (keepBelow === undefined) this.db.prepare("DELETE FROM section_vectors WHERE note_id = ?").run(noteId);
    else this.db.prepare("DELETE FROM section_vectors WHERE note_id = ? AND ord >= ?").run(noteId, keepBelow);
    this.dirty = true;
  }

  /** Cancel a pending background embed (used on close, e.g. after `--reindex`). */
  stop(): void {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
  }

  /** Embed every section whose text hash has no vector yet. Debounced; safe to call often. */
  schedule(delayMs = 1500): void {
    if (this.disabled) return;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.embedMissing();
    }, delayMs);
  }

  async embedMissing(batchSize = 32): Promise<number> {
    if (this.embedding) {
      this.embedAgain = true;
      return 0;
    }
    this.embedding = true;
    let done = 0;
    try {
      if (!(await this.ready())) return 0;
      const rows = this.db
        .prepare(
          `SELECT s.note_id, s.ord, s.heading, s.text, n.title, v.hash AS have, v.model AS have_model
           FROM sections s JOIN notes n ON n.id = s.note_id
           LEFT JOIN section_vectors v ON v.note_id = s.note_id AND v.ord = s.ord`,
        )
        .all() as { note_id: string; ord: number; heading: string; text: string; title: string; have: string | null; have_model: string | null }[];
      const todo: { note_id: string; ord: number; input: string; hash: string }[] = [];
      for (const r of rows) {
        const input = embedInput(r.title, r.heading, r.text, this.cfg.embedChars);
        const hash = crypto.createHash("sha1").update(input).digest("hex");
        if (r.have === hash && r.have_model === this.cfg.embedModel) continue;
        todo.push({ note_id: r.note_id, ord: r.ord, input, hash });
      }
      if (!todo.length) return 0;
      const t0 = Date.now();
      const ins = this.db.prepare(
        `INSERT INTO section_vectors (note_id, ord, hash, model, dim, v) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id, ord) DO UPDATE SET hash = excluded.hash, model = excluded.model, dim = excluded.dim, v = excluded.v`,
      );
      for (let i = 0; i < todo.length; i += batchSize) {
        const batch = todo.slice(i, i + batchSize);
        const out = await this.embedder!(batch.map((b) => b.input), { pooling: "cls", normalize: true });
        const dim = out.dims[out.dims.length - 1];
        const data = out.data;
        this.db.transaction(() => {
          batch.forEach((b, j) => {
            const slice = data.slice(j * dim, (j + 1) * dim);
            ins.run(b.note_id, b.ord, b.hash, this.cfg.embedModel, dim, Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
          });
        })();
        done += batch.length;
        this.dirty = true;
      }
      console.error(`[dense] embedded ${done} section(s) in ${Date.now() - t0} ms`);
      return done;
    } catch (e) {
      console.error(`[dense] embedding failed: ${(e as Error).message}`);
      return done;
    } finally {
      this.embedding = false;
      if (this.embedAgain) {
        this.embedAgain = false;
        this.schedule(500);
      }
    }
  }

  private loadMatrix(): void {
    if (!this.dirty) return;
    const rows = this.db.prepare("SELECT note_id, ord, dim, v FROM section_vectors WHERE model = ?").all(this.cfg.embedModel) as {
      note_id: string;
      ord: number;
      dim: number;
      v: Buffer;
    }[];
    this.dim = rows[0]?.dim ?? 0;
    this.keys = rows.map((r) => ({ note_id: r.note_id, ord: r.ord }));
    this.mat = new Float32Array(rows.length * this.dim);
    rows.forEach((r, i) => this.mat.set(new Float32Array(r.v.buffer, r.v.byteOffset, this.dim), i * this.dim));
    this.dirty = false;
  }

  // ------------------------------------------------------------ queries
  /** Cosine top-k over every embedded section. Brute force: a few thousand dot products is well under a millisecond. */
  async search(query: string, k = 40): Promise<DenseHit[]> {
    if (!(await this.ready())) return [];
    this.loadMatrix();
    if (!this.keys.length) return [];
    const out = await this.embedder!([query], { pooling: "cls", normalize: true });
    const q = out.data;
    const d = this.dim;
    const scores = new Float32Array(this.keys.length);
    for (let i = 0; i < this.keys.length; i++) {
      let s = 0;
      const o = i * d;
      for (let j = 0; j < d; j++) s += this.mat[o + j] * q[j];
      scores[i] = s;
    }
    const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, k);
    return idx.map((i) => ({ ...this.keys[i], score: scores[i] }));
  }

  /** Cross-encoder probabilities for (query, passage) pairs, in input order. */
  async rerank(query: string, passages: string[]): Promise<number[]> {
    if (!passages.length || !(await this.ready())) return passages.map(() => 0);
    const enc = this.reranker!.tok(Array(passages.length).fill(query), {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: this.cfg.rerankMaxLen,
    });
    const out = await this.reranker!.model(enc);
    return Array.from(out.logits.data, (l) => 1 / (1 + Math.exp(-l)));
  }

  // ------------------------------------------------------------ query understanding helpers
  private knownStmt: Database.Statement | null = null;
  /** A word is known if FTS5, with the index's own tokenizer and stemmer, finds it anywhere. */
  known(word: string): boolean {
    try {
      this.knownStmt ??= this.db.prepare("SELECT 1 FROM sections_fts2 WHERE sections_fts2 MATCH ? LIMIT 1");
      return !!this.knownStmt.get(`"${word.replace(/"/g, "")}"`);
    } catch {
      return true;
    }
  }

  private vocab: Map<string, number> | null = null;
  private vocabAt = 0;
  /** Stemmed index vocabulary with document frequencies, refreshed at most once a minute. */
  private vocabulary(): Map<string, number> {
    if (!this.vocab || Date.now() - this.vocabAt > 60_000) {
      this.vocab = new Map((this.db.prepare("SELECT term, doc FROM sections_vocab").all() as { term: string; doc: number }[]).map((r) => [r.term, r.doc]));
      this.vocabAt = Date.now();
    }
    return this.vocab;
  }

  /**
   * Correct a word the index has never seen to a term that occurs in at least two sections at
   * Damerau distance 1 (2 for long words). Anything weaker stays as typed.
   */
  correct(word: string): string | null {
    if (word.length < 5 || /\d/.test(word) || this.known(word)) return null;
    const maxD = word.length <= 8 ? 1 : 2;
    let best: string | null = null;
    let bestScore = -1;
    for (const [t, df] of this.vocabulary()) {
      if (df < 2 || Math.abs(t.length - word.length) > maxD || t[0] !== word[0]) continue;
      const dist = damerau(word, t, maxD);
      if (dist > maxD) continue;
      const score = (maxD - dist + 1) * 1000 + df;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }
}

/** Optimal string alignment distance, cut off once it exceeds `max`. */
export function damerau(a: string, b: string, max = 2): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}
