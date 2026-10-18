import type { Neighbour } from "./graph.js";

/**
 * How linked notes join the ranker (see VaultIndex.rankSections): which linked sections are worth a reranker place,
 * which places they may take, what the reranker is told about the link, and which trimmed section a kept hit's link
 * rescues. Pure functions over plain data, so each rule is testable without a vault or models.
 */

/** The top fused places, never given to a linked section. */
export const TOP_FIXED = 3;
/** The first entries of each search list, never displaced. */
export const PROTECT_LIST_TOP = 3;
/** An entry that meaning search and a keyword list both rank this high or better is never displaced. */
export const PROTECT_BOTH = 10;
/** Extra score for a linked note reached from each further seed. */
export const SHARED_BOOST = 0.5;
/** Longest linking sentence shown to the reranker in front of a linked section. */
export const PREFIX_CHARS = 200;

const cmpKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A note the expansion starts from: one of the top fused sections. */
export interface Seed {
  note: string;
  key: string;
  title: string;
  /** Its fused score relative to the best. */
  score: number;
}

/** ok: a candidate · filtered: outside the search's filters (project, type, dates, topic) · hidden: not readable. */
export type Access = "ok" | "filtered" | "hidden";

/** A linked section worth a reranker place, with the link that reached it. */
export interface GraphPick {
  note: string;
  key: string;
  ord: number;
  /** Cosine of the section with the question, at least 0. */
  fit: number;
  /** seed score x link strength x fit. */
  score: number;
  seed: Seed;
  nb: Neighbour;
}

export type CandStatus = "admitted" | "beaten" | "no-slot" | "cap" | "listed" | "structural" | "filtered" | "no-vector";

/** What became of one linked note, for the debug trace. */
export interface CandTrace {
  note: string;
  key?: string;
  seed: string;
  dir: "out" | "in";
  kind: string;
  strength: number;
  fit?: number;
  score?: number;
  status: CandStatus;
}

/**
 * The linked sections worth a place, best first. Each seed's links are walked strongest first down to `minWeight`;
 * a note already listed, structural (hub, concept page, ...), outside the filters or without a vector is traced and
 * passed over, and an unreadable one is passed over without a trace. Each seed keeps its best `linksPerSeed` by score;
 * a note reached from two seeds keeps its higher score (the earlier seed on a tie). Past `max`, picks are "no-slot".
 */
export function selectGraphPicks(o: {
  seeds: Seed[];
  neighbours: (id: string) => Neighbour[];
  isStructural: (id: string) => boolean;
  access: (id: string) => Access;
  listed: Set<string>;
  bestWindow: (id: string) => { ord: number; cos: number } | undefined;
  minWeight: number;
  linksPerSeed: number;
  max: number;
}): { picks: GraphPick[]; overflow: GraphPick[]; trace: CandTrace[] } {
  const trace: CandTrace[] = [];
  const best = new Map<string, GraphPick>();
  const seedsOf = new Map<string, number>();
  const traced = (g: GraphPick, status: CandStatus): CandTrace => ({ note: g.note, key: g.key, seed: g.seed.note, dir: g.nb.dir, kind: g.nb.kind, strength: g.nb.strength, fit: g.fit, score: g.score, status });
  for (const s of o.seeds) {
    const options: GraphPick[] = [];
    for (const nb of o.neighbours(s.note)) {
      if (nb.strength < o.minWeight) break;
      const access = o.access(nb.id);
      if (access === "hidden") continue;
      const t = { note: nb.id, seed: s.note, dir: nb.dir, kind: nb.kind, strength: nb.strength };
      if (o.listed.has(nb.id)) trace.push({ ...t, status: "listed" });
      else if (o.isStructural(nb.id)) trace.push({ ...t, status: "structural" });
      else if (access === "filtered") trace.push({ ...t, status: "filtered" });
      else {
        const w = o.bestWindow(nb.id);
        if (!w) trace.push({ ...t, status: "no-vector" });
        else {
          const fit = Math.max(0, w.cos);
          options.push({ note: nb.id, key: `${nb.id}#${w.ord}`, ord: w.ord, fit, score: s.score * nb.strength * fit, seed: s, nb });
        }
      }
    }
    options.sort((a, b) => b.score - a.score || cmpKey(a.key, b.key));
    options.forEach((g, i) => {
      if (i >= o.linksPerSeed) return void trace.push(traced(g, "cap"));
      seedsOf.set(g.note, (seedsOf.get(g.note) ?? 0) + 1);
      const cur = best.get(g.note);
      if (!cur || g.score > cur.score) best.set(g.note, g);
    });
  }
  // A note several seeds link to is what connects them ("what links A and B"): +50% per extra seed.
  for (const [note, n] of seedsOf) if (n > 1) best.get(note)!.score *= 1 + SHARED_BOOST * (n - 1);
  const ranked = [...best.values()].sort((a, b) => b.score - a.score || cmpKey(a.key, b.key));
  const overflow = ranked.slice(o.max);
  for (const g of overflow) trace.push(traced(g, "no-slot"));
  return { picks: ranked.slice(0, o.max), overflow, trace };
}

/**
 * Shortlist entries a linked section never displaces: the seeds, each list's first entries, every exact-date hit,
 * and any entry meaning search and a keyword list both rank within PROTECT_BOTH.
 */
export function protectedKeys(lists: { lex: string[]; den: string[]; exact: string[]; note: string[] }, seedKeys: string[], headKeys: string[]): Set<string> {
  const p = new Set<string>(seedKeys);
  for (const l of [lists.lex, lists.den, lists.exact, lists.note]) for (const k of l.slice(0, PROTECT_LIST_TOP)) p.add(k);
  for (const k of lists.exact) p.add(k);
  const rank = (l: string[]) => {
    const m = new Map<string, number>();
    l.forEach((k, i) => {
      if (!m.has(k)) m.set(k, i + 1);
    });
    return m;
  };
  const lexR = rank(lists.lex);
  const noteR = rank(lists.note);
  const denR = rank(lists.den);
  for (const k of headKeys) {
    const keyword = Math.min(lexR.get(k) ?? Infinity, noteR.get(k) ?? Infinity);
    if (keyword <= PROTECT_BOTH && (denR.get(k) ?? Infinity) <= PROTECT_BOTH) p.add(k);
  }
  return p;
}

/**
 * Give linked sections reranker places, one for one: each pick, best first, takes the weakest unprotected head entry
 * below the top TOP_FIXED if swapWeight x its score beats that entry's fused score relative to the best (`fusedTop`).
 * Picks are sorted best first and the head's bottom gets stronger as places go, so the first pick that fails ends it.
 */
export function fairSwap(o: { head: { key: string; score: number }[]; picks: GraphPick[]; fusedTop: number; protect: Set<string>; swapWeight: number }): {
  admitted: GraphPick[];
  displaced: { key: string; fusedRank: number; by: string }[];
  beaten: GraphPick[];
  noSlot: GraphPick[];
} {
  const admitted: GraphPick[] = [];
  const displaced: { key: string; fusedRank: number; by: string }[] = [];
  let beaten: GraphPick[] = [];
  let noSlot: GraphPick[] = [];
  let j = o.head.length - 1;
  for (let i = 0; i < o.picks.length; i++) {
    const g = o.picks[i];
    while (j >= TOP_FIXED && o.protect.has(o.head[j].key)) j--;
    if (j < TOP_FIXED) {
      noSlot = o.picks.slice(i);
      break;
    }
    if (!(o.swapWeight * g.score > o.head[j].score / o.fusedTop)) {
      beaten = o.picks.slice(i);
      break;
    }
    displaced.push({ key: o.head[j].key, fusedRank: j + 1, by: g.key });
    admitted.push(g);
    j--;
  }
  return { admitted, displaced, beaten, noSlot };
}

/**
 * The line the reranker reads in front of a linked section: the sentence that links it to its seed. An out-link
 * (the seed names the section's note) gives "Linked from <seed> / <heading>: <sentence>"; an in-link (the note names
 * the seed) gives "Links to <seed>: <sentence>", or nothing when the chosen window already holds that sentence. The
 * occurrence shown is the one in the linking note's window closest to the question, then the heaviest, then the
 * first. Frontmatter-only links have no sentence and get nothing.
 */
export function graphPrefix(
  g: GraphPick,
  o: { windowCos: (key: string) => number; ctx: (from: string, pos: number) => string | null; heading: (note: string, ord: number) => string | null },
): string | null {
  const body = g.nb.occs.filter((x) => x.ord !== null);
  if (g.nb.dir === "in" && body.some((x) => x.ord === g.ord)) return null;
  const linker = g.nb.dir === "out" ? g.seed.note : g.note;
  const occ = [...body].sort((a, b) => o.windowCos(`${linker}#${b.ord}`) - o.windowCos(`${linker}#${a.ord}`) || b.weight - a.weight || a.pos - b.pos)[0];
  if (!occ) return null;
  const s = o.ctx(linker, occ.pos);
  if (!s) return null;
  const text = s.length > PREFIX_CHARS ? `${s.slice(0, PREFIX_CHARS - 1).trimEnd()}…` : s;
  if (g.nb.dir === "in") return `Links to ${g.seed.title}: ${text}`;
  const h = o.heading(g.seed.note, occ.ord!);
  return `Linked from ${g.seed.title}${h && h.toLowerCase() !== g.seed.title.toLowerCase() ? ` / ${h}` : ""}: ${text}`;
}

/**
 * Trimmed sections linked with a kept hit (either direction), worth keeping after all: the second note of a two-note answer often scores
 * far below the first, and the link is evidence they belong together. Only rows the trim cut, that were reranked and
 * came from the search lists (not the graph), of a note not kept yet and not structural, linked from a kept note with
 * at least `minWeight`; the strongest anchor wins (the earlier kept note on a tie), at most min(max, room), each note
 * once, in score order.
 */
export function linkedPartners(o: {
  order: { i: number; note: string; cut: string; reranked: boolean; graph: boolean }[];
  kept: string[];
  neighbours: (id: string) => Neighbour[];
  isStructural: (id: string) => boolean;
  minWeight: number;
  max: number;
  room: number;
}): { i: number; anchor: string; strength: number; kind: string }[] {
  const keptSet = new Set(o.kept);
  const anchorOf = new Map<string, { anchor: string; strength: number; kind: string }>();
  for (const k of o.kept)
    for (const nb of o.neighbours(k)) {
      if (nb.strength < o.minWeight) break;
      if (keptSet.has(nb.id) || o.isStructural(nb.id)) continue;
      const cur = anchorOf.get(nb.id);
      if (!cur || nb.strength > cur.strength) anchorOf.set(nb.id, { anchor: k, strength: nb.strength, kind: nb.kind });
    }
  const out: { i: number; anchor: string; strength: number; kind: string }[] = [];
  const limit = Math.min(o.max, o.room);
  for (const r of o.order) {
    if (out.length >= limit) break;
    if (r.cut !== "trim" || !r.reranked || r.graph || keptSet.has(r.note)) continue;
    const a = anchorOf.get(r.note);
    if (!a) continue;
    out.push({ i: r.i, ...a });
    keptSet.add(r.note);
  }
  return out;
}
