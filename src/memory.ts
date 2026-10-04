import { queryTerms } from "./vault/index.js";

/** One entry in Captures/Memory.md, delimited by "## <stamp> · <category>". */
export interface MemoryBlock {
  id: string; // the stamp, e.g. "2026-09-22 18:21"
  category: string;
  text: string;
}

const BLOCK_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (\w+)\s*$/;

export function parseMemoryBlocks(markdown: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
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
      cur = { id: m[1], category: m[2], text: "" };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

/** Strip the trailer we add ourselves so it does not count toward similarity. */
function factOnly(text: string): string {
  return text
    .replace(/\*via mcp:[^*]*\*/g, "")
    .replace(/\*\*(Why|How to apply|Supersedes):\*\*.*$/gms, "")
    .trim();
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
