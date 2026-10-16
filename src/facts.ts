import type Database from "better-sqlite3";
import { blockFields, parseMemoryBlocks, type MemoryBlock } from "./memory.js";

/**
 * Facts with validity windows, derived from the memory file.
 *
 * The memory file stays the source of truth and stays append-only: a fact never changes once written. A later
 * fact can name earlier ones on a `**Replaces:**` line, and any fact can carry `**Valid from:**`, `**Valid until:**`
 * and `**Key:** subject / attribute`. `deriveFacts` reads those lines into windows (an earlier fact ends when its
 * replacement starts), and FactStore keeps the result in the index database so brain_identity, brain_facts and
 * brain_context can ask what is true at a given moment. Delete the table and the next index of the file rebuilds it.
 *
 * Times are UTC. Stored as "YYYY-MM-DDTHH:MM:SSZ" so they compare as strings; an end time is exclusive.
 */

export type FactStatus = "current" | "replaced" | "expired" | "upcoming";

export interface Fact {
  id: string;
  ord: number;
  category: string;
  text: string;
  why: string | null;
  how: string | null;
  subject: string | null;
  attribute: string | null;
  validFrom: string;
  validUntil: string | null; // the fact's own end, from its Valid until line
  replacedBy: string | null;
  replacedAt: string | null; // when the replacement took effect: the replacing fact's validFrom
  replaces: string[]; // earlier facts this one replaced (resolved ids only)
  via: string | null;
  /** The block as written, with its heading rewritten to the fact id, for rendering. */
  block: string;
}

/** A time in the stored form. */
export const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
const iso = toIso;

export const nowIso = () => iso(Date.now());

/**
 * Parse "YYYY-MM-DD", "YYYY-MM-DD HH:MM" (UTC) or an ISO 8601 time with an offset into the stored form.
 * A bare date means the start of that day, or with `endOfDay` the start of the next, so "valid until 2026-10-20"
 * still holds on the 20th. Returns null for anything else, including impossible dates like 2026-02-30.
 */
export function parseWhen(raw: string, endOfDay = false): string | null {
  const s = raw.trim();
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const ms = Date.UTC(y, m - 1, day);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day) return null;
    return iso(ms + (endOfDay ? 86400_000 : 0));
  }
  const t = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!t) return null;
  const [y, m, day, h, min, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(t[i] ?? 0));
  const ms = Date.UTC(y, m - 1, day, h, min, sec);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== day || h > 23 || min > 59 || sec > 59) return null;
  if (!t[7] || t[7] === "Z") return iso(ms);
  const off = t[7].replace(":", "");
  const offMin = (off[0] === "-" ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  return iso(ms - offMin * 60_000);
}

/** "2026-10-16T09:10:00Z" → "2026-10-16 09:10", or just the date at midnight. */
export function showWhen(isoTime: string): string {
  const day = isoTime.slice(0, 10);
  const hm = isoTime.slice(11, 16);
  return hm === "00:00" ? day : `${day} ${hm}`;
}

/** An end time for people. Ends are exclusive, so midnight reads as "through" the day before. */
export function showEnd(isoTime: string): string {
  if (isoTime.slice(11, 19) !== "00:00:00") return `until ${showWhen(isoTime)}`;
  return `through ${new Date(Date.parse(isoTime) - 86400_000).toISOString().slice(0, 10)}`;
}

/** A heading stamp ("2026-09-22 18:21", UTC) as a stored time. */
const stampTime = (stamp: string) => `${stamp.replace(" ", "T")}:00Z`;

/** Lower-case, single-spaced subject/attribute pair, so "JobMail / Database" and "jobmail /  database" match. */
export function factKey(subject: string | null, attribute: string | null): string | null {
  if (!subject || !attribute) return null;
  const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return `${n(subject)} / ${n(attribute)}`;
}

/** What `f` was at time `at`: the earlier of its own end and its replacement decides between expired and replaced. */
export function statusAt(f: Fact, at: string): FactStatus {
  if (f.validFrom > at) return "upcoming";
  const expired = f.validUntil !== null && f.validUntil <= at;
  const replaced = f.replacedAt !== null && f.replacedAt <= at;
  if (expired && replaced) return f.validUntil! <= f.replacedAt! ? "expired" : "replaced";
  if (replaced) return "replaced";
  if (expired) return "expired";
  return "current";
}

/** When `f` stopped (or will stop) being true, if it does. */
export function endOf(f: Fact): string | null {
  if (f.validUntil && f.replacedAt) return f.validUntil < f.replacedAt ? f.validUntil : f.replacedAt;
  return f.validUntil ?? f.replacedAt;
}

/** Turn memory blocks into facts with windows. Pure; `warnings` lists Replaces lines that could not be applied. */
export function deriveFacts(blocks: MemoryBlock[]): { facts: Fact[]; warnings: string[] } {
  const warnings: string[] = [];
  const facts: Fact[] = [];
  const byId = new Map<string, Fact>();
  const refs: { from: Fact; to: string[] }[] = [];
  for (const b of blocks) {
    const f = blockFields(b.text);
    let validFrom = stampTime(b.stamp);
    if (f.validFrom) {
      const v = parseWhen(f.validFrom);
      if (v) validFrom = v;
      else warnings.push(`${b.id}: "Valid from: ${f.validFrom}" is not a date; using the time it was recorded.`);
    }
    let validUntil: string | null = null;
    if (f.validUntil) {
      validUntil = parseWhen(f.validUntil, true);
      if (!validUntil) warnings.push(`${b.id}: "Valid until: ${f.validUntil}" is not a date; ignored.`);
      else if (validUntil <= validFrom) warnings.push(`${b.id}: ends (${showWhen(validUntil)}) before it starts (${showWhen(validFrom)}).`);
    }
    const heading = `## ${b.id} · ${b.category}`;
    const fact: Fact = {
      id: b.id,
      ord: b.ord,
      category: b.category,
      text: f.fact,
      why: f.why,
      how: f.how,
      subject: f.subject,
      attribute: f.attribute,
      validFrom,
      validUntil,
      replacedBy: null,
      replacedAt: null,
      replaces: [],
      via: f.via,
      block: `${heading}\n\n${b.text}`.trim(),
    };
    facts.push(fact);
    byId.set(b.id, fact);
    if (f.replaces.length) refs.push({ from: fact, to: f.replaces });
  }
  // Only an earlier fact can be replaced, so a typo cannot hide a newer fact or form a cycle. A fact replaced
  // twice keeps its first replacement; the second is reported.
  for (const { from, to } of refs) {
    for (const id of to) {
      const target = byId.get(id);
      if (!target) warnings.push(`${from.id}: replaces ${id}, but no fact has that id.`);
      else if (target.ord >= from.ord) warnings.push(`${from.id}: replaces ${id}, which is not an earlier fact; ignored.`);
      else if (target.replacedBy) warnings.push(`${from.id}: replaces ${id}, already replaced by ${target.replacedBy}; ignored.`);
      else {
        target.replacedBy = from.id;
        target.replacedAt = from.validFrom;
        from.replaces.push(id);
      }
    }
  }
  return { facts, warnings };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  why TEXT,
  how TEXT,
  subject TEXT,
  attribute TEXT,
  key TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  replaced_by TEXT,
  replaced_at TEXT,
  replaces TEXT NOT NULL,
  via TEXT,
  block TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_key ON facts(key);
CREATE INDEX IF NOT EXISTS facts_from ON facts(valid_from);
`;

/** True at @at: started, not past its own end, not yet replaced. */
const TRUE_AT = "valid_from <= @at AND (valid_until IS NULL OR valid_until > @at) AND (replaced_at IS NULL OR replaced_at > @at)";

interface FactRow {
  id: string;
  ord: number;
  category: string;
  text: string;
  why: string | null;
  how: string | null;
  subject: string | null;
  attribute: string | null;
  key: string | null;
  valid_from: string;
  valid_until: string | null;
  replaced_by: string | null;
  replaced_at: string | null;
  replaces: string;
  via: string | null;
  block: string;
}

const fromRow = (r: FactRow): Fact => ({
  id: r.id,
  ord: r.ord,
  category: r.category,
  text: r.text,
  why: r.why,
  how: r.how,
  subject: r.subject,
  attribute: r.attribute,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
  replacedBy: r.replaced_by,
  replacedAt: r.replaced_at,
  replaces: JSON.parse(r.replaces) as string[],
  via: r.via,
  block: r.block,
});

export class FactStore {
  /** Problems found the last time the memory file was read, e.g. a Replaces line naming no fact. */
  warnings: string[] = [];

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
  }

  /** Replace the table with the facts in `markdown` (the memory file's body), or empty it when the file is gone. */
  rebuild(markdown: string | null): void {
    const { facts, warnings } = deriveFacts(markdown ? parseMemoryBlocks(markdown) : []);
    this.warnings = warnings;
    const ins = this.db.prepare(
      `INSERT INTO facts (id,ord,category,text,why,how,subject,attribute,key,valid_from,valid_until,replaced_by,replaced_at,replaces,via,block)
       VALUES (@id,@ord,@category,@text,@why,@how,@subject,@attribute,@key,@valid_from,@valid_until,@replaced_by,@replaced_at,@replaces,@via,@block)`,
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM facts").run();
      for (const f of facts)
        ins.run({
          id: f.id,
          ord: f.ord,
          category: f.category,
          text: f.text,
          why: f.why,
          how: f.how,
          subject: f.subject,
          attribute: f.attribute,
          key: factKey(f.subject, f.attribute),
          valid_from: f.validFrom,
          valid_until: f.validUntil,
          replaced_by: f.replacedBy,
          replaced_at: f.replacedAt,
          replaces: JSON.stringify(f.replaces),
          via: f.via,
          block: f.block,
        });
    })();
  }

  /** Every fact, in file order. */
  all(): Fact[] {
    return (this.db.prepare("SELECT * FROM facts ORDER BY ord").all() as FactRow[]).map(fromRow);
  }

  get(id: string): Fact | undefined {
    const r = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as FactRow | undefined;
    return r ? fromRow(r) : undefined;
  }

  /** Facts true at `at` (default now), in file order. */
  trueAt(at: string = nowIso()): Fact[] {
    return (this.db.prepare(`SELECT * FROM facts WHERE ${TRUE_AT} ORDER BY ord`).all({ at }) as FactRow[]).map(fromRow);
  }

  /** A one-line warning for fact `id` when it is not true at `at`, or null when it is (or no such fact exists). */
  flag(id: string, at: string = nowIso()): string | null {
    const f = this.get(id);
    if (!f) return null;
    const s = statusAt(f, at);
    if (s === "replaced") return `> Outdated: replaced by ${f.replacedBy} on ${showWhen(f.replacedAt!)}. Kept as history.`;
    if (s === "expired") return `> Expired: it held ${showEnd(f.validUntil!)}. Kept as history.`;
    if (s === "upcoming") return `> Not true yet: takes effect ${showWhen(f.validFrom)}.`;
    return null;
  }
}
