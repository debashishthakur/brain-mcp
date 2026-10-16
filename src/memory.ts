import { queryTerms } from "./vault/index.js";

/** One entry in Captures/Memory.md, delimited by "## <stamp> · <category>". */
export interface MemoryBlock {
  id: string; // the stamp, e.g. "2026-09-22 18:21"; a stamp seen before in the file gets " #2", " #3", ...
  stamp: string; // the stamp exactly as written in the heading
  ord: number; // position in the file, 0 = first block
  category: string;
  text: string; // everything under the heading
}

const BLOCK_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (\w+)\s*$/;
/** A fact id as written in a heading or a Replaces line. */
export const FACT_ID_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: #\d+)?/g;

export function parseMemoryBlocks(markdown: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  const seen = new Map<string, number>();
  let cur: MemoryBlock | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (cur) {
      cur.text = buf.join("\n").trim();
      blocks.push(cur);
    }
    buf.length = 0;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(BLOCK_RE);
    if (m) {
      flush();
      const n = (seen.get(m[1]) ?? 0) + 1;
      seen.set(m[1], n);
      cur = { id: n > 1 ? `${m[1]} #${n}` : m[1], stamp: m[1], ord: blocks.length, category: m[2], text: "" };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

/** Labelled lines brain_remember writes under a fact. Supersedes is the pre-0.5 spelling of Replaces. */
const LABELS = ["Why", "How to apply", "Key", "Valid from", "Valid until", "Replaces", "Supersedes"] as const;
const LABEL_RE = new RegExp(`^\\*\\*(${LABELS.join("|")}):\\*\\*\\s*(.*)$`);

export interface BlockFields {
  fact: string; // the statement itself, without the labelled lines or the via trailer
  why: string | null;
  how: string | null;
  subject: string | null;
  attribute: string | null;
  validFrom: string | null; // raw text after "Valid from:"
  validUntil: string | null;
  replaces: string[]; // fact ids named on Replaces / Supersedes lines
  via: string | null;
}

/** Split a block's text into the fact and its labelled lines. A label's value runs until the next blank line. */
export function blockFields(text: string): BlockFields {
  const out: BlockFields = { fact: "", why: null, how: null, subject: null, attribute: null, validFrom: null, validUntil: null, replaces: [], via: null };
  const factLines: string[] = [];
  let label: string | null = null;
  let value: string[] = [];
  const close = () => {
    if (!label) return;
    const v = value.join("\n").trim();
    if (label === "Why") out.why = v || null;
    else if (label === "How to apply") out.how = v || null;
    else if (label === "Valid from") out.validFrom = v || null;
    else if (label === "Valid until") out.validUntil = v || null;
    else if (label === "Replaces" || label === "Supersedes") out.replaces.push(...(v.match(FACT_ID_RE) ?? []));
    else if (label === "Key") {
      const at = v.lastIndexOf(" / ");
      if (at > 0) {
        out.subject = v.slice(0, at).trim() || null;
        out.attribute = v.slice(at + 3).trim() || null;
      }
    }
    label = null;
    value = [];
  };
  let pastFact = false;
  for (const line of text.split(/\r?\n/)) {
    const via = line.trim().match(/^\*via (mcp:[^*]*)\*$/);
    if (via) {
      close();
      out.via = via[1].trim();
      pastFact = true;
      continue;
    }
    const m = line.match(LABEL_RE);
    if (m) {
      close();
      label = m[1];
      value = [m[2]];
      pastFact = true;
    } else if (label) {
      if (line.trim()) value.push(line);
      else close();
    } else if (!pastFact) {
      factLines.push(line);
    }
  }
  close();
  out.fact = factLines.join("\n").trim();
  out.replaces = [...new Set(out.replaces)];
  return out;
}

/** Strip the labelled lines and trailer we add ourselves so they do not count toward similarity. */
function factOnly(text: string): string {
  return blockFields(text).fact;
}

export interface Similarity {
  jaccard: number;
  containment: number;
}

/** Very light stemming so "projects"/"project" and "migrations"/"migration" compare equal. */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

export function similarity(a: string, b: string): Similarity {
  const ta = new Set(queryTerms(factOnly(a)).map(stem));
  const tb = new Set(queryTerms(factOnly(b)).map(stem));
  if (!ta.size || !tb.size) return { jaccard: 0, containment: 0 };
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return { jaccard: inter / union, containment: inter / Math.min(ta.size, tb.size) };
}

export type Verdict = { kind: "duplicate" | "update" | "new"; match?: MemoryBlock; sim?: Similarity };

export const DUPLICATE_JACCARD = 0.6;
export const DUPLICATE_CONTAINMENT = 0.85;
export const UPDATE_JACCARD = 0.3;

/** Deterministic near-duplicate check for a new fact against existing memory blocks. */
export function judge(fact: string, existing: MemoryBlock[]): Verdict {
  let best: { block: MemoryBlock; sim: Similarity } | null = null;
  for (const block of existing) {
    const sim = similarity(fact, block.text);
    const key = Math.max(sim.jaccard, sim.containment * 0.9);
    if (!best || key > Math.max(best.sim.jaccard, best.sim.containment * 0.9)) best = { block, sim };
  }
  if (!best) return { kind: "new" };
  const { jaccard, containment } = best.sim;
  if (jaccard >= DUPLICATE_JACCARD || containment >= DUPLICATE_CONTAINMENT) return { kind: "duplicate", match: best.block, sim: best.sim };
  if (jaccard >= UPDATE_JACCARD) return { kind: "update", match: best.block, sim: best.sim };
  return { kind: "new" };
}
