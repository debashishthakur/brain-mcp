import path from "node:path";
import type Database from "better-sqlite3";
import { LINK_KEYS, stripLink, type LinkKind } from "./parse.js";

/**
 * The vault's link graph, built from the `edges` table: every link occurrence with where it sits (see extractLinks),
 * resolved to notes in memory and scored by how strongly it says two notes belong together. Resolution lives here,
 * not in the table, so renaming a note or adding an alias re-points every link on the next use; the graph is rebuilt
 * lazily after any change, like the dense matrix.
 */

export interface GraphConfig {
  /** Pull strongly linked notes' sections into the reranker shortlist. Off until the eval shows a gain. */
  enabled: boolean;
  /** Most shortlist entries graph candidates may take (they replace the bottom of the fused list, one for one). */
  slots: number;
  /** Top fused sections whose notes start the expansion. */
  seeds: number;
  /** Strongest links followed from each starting note. */
  linksPerSeed: number;
  /** Links weaker than this are not followed. */
  minWeight: number;
  /** 1: linked notes only. 2: also notes linked from those, along sentence links only. */
  depth: number;
  /** Graph candidates reranked alongside the top 3 when the early-exit shortcut applies. */
  exitSlots: number;
  /** Show the reranker the sentence that links a graph candidate to the note it was reached from. */
  prefix: boolean;
  /** Weight of a link by where it sits. */
  kinds: Record<Exclude<LinkKind, "fm">, number>;
  /** Weight of a frontmatter link by key; "*" for any other key that holds a [[link]]. */
  keys: Record<string, number>;
}

export const GRAPH_DEFAULTS: GraphConfig = {
  enabled: false,
  slots: 3,
  seeds: 5,
  linksPerSeed: 3,
  minWeight: 0.2,
  depth: 1,
  exitSlots: 3,
  prefix: true,
  kinds: { sentence: 1.0, embed: 0.8, list_explained: 0.7, heading: 0.5, table: 0.5, short: 0.4, list_bare: 0.3, trailer: 0 },
  keys: { related: 0.3, "part-of": 0.3, project: 0.2, topics: 0.15, "*": 0.2 },
};

/** Note types that organise other notes rather than hold content: they bridge, but are never answers. */
export const STRUCTURAL_TYPES = new Set(["hub", "concept", "moc", "meta", "guide"]);

/** A name as links match it: case and runs of whitespace (any kind) folded. */
export const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
/** A name with hyphens, underscores and runs of spaces folded together, so [[github-account]] finds "github account". */
export const slugKey = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, " ").trim();

interface Node {
  id: string;
  title: string;
  type: string;
  dir: string;
}

interface Occ {
  pos: number;
  kind: LinkKind;
  fmKey: string | null;
  ord: number | null;
  heading: string | null;
  weight: number;
}

/** All links from one note to another, merged. `base` is the strongest occurrence's weight. */
interface PairEdge {
  from: string;
  to: string;
  base: number;
  /** Kind of the strongest occurrence ("fm:<key>" for frontmatter). */
  kind: string;
  /** Occurrences in the body (not frontmatter, not the generated trailer). */
  bodyCount: number;
  occs: Occ[];
}

/** One step from a note to a neighbour, scored. */
export interface Neighbour {
  id: string;
  /** out: this note links to the neighbour · in: the neighbour links to this note */
  dir: "out" | "in";
  strength: number;
  kind: string;
  /** The occurrence that carries the link (look up its sentence with ctx()). */
  from: string;
  pos: number;
  /** Section window of the linking note that holds the link, if it is in the body. */
  fromOrd: number | null;
  /** The `#heading` the link points at, if any. */
  heading: string | null;
}

export interface GraphStats {
  notes: number;
  occurrences: Record<string, number>;
  pairs: number;
  /** Note pairs joined by a sentence, explained list item or embed, neither end a hub/concept/MOC page. */
  contentPairs: number;
  /** Notes with at least one such link. */
  contentNotes: number;
  unresolved: [string, number][];
  ambiguous: [string, string[]][];
  topIn: [string, number][];
}

const SPEC_NORM = Math.log2(3);
/** Specificity of a target with `d` linkers: 1 at d = 1, 0.61 at 4, 0.44 at 10, 0.25 at 80. */
const spec = (d: number) => SPEC_NORM / Math.log2(2 + Math.max(1, d));
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class LinkGraph {
  private dirty = true;
  private nodes = new Map<string, Node>();
  private outE = new Map<string, Map<string, PairEdge>>();
  private inE = new Map<string, Map<string, PairEdge>>();
  private indeg = new Map<string, number>();
  private outdeg = new Map<string, number>();
  private unresolved = new Map<string, number>();
  private ambiguous = new Map<string, Set<string>>();
  private names = {
    path: new Map<string, string[]>(),
    suffix: new Map<string, string[]>(),
    pathSlug: new Map<string, string[]>(),
    suffixSlug: new Map<string, string[]>(),
    title: new Map<string, string[]>(),
    base: new Map<string, string[]>(),
    alias: new Map<string, string[]>(),
    slug: new Map<string, string[]>(),
  };
  private ctxStmt: Database.Statement | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly cfg: { graph: GraphConfig; aliases?: Record<string, string> },
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  private ensure(): void {
    if (this.dirty) this.build();
  }

  private build(): void {
    const n = this.names;
    for (const m of Object.values(n)) m.clear();
    this.nodes.clear();
    this.outE.clear();
    this.inE.clear();
    this.indeg.clear();
    this.outdeg.clear();
    this.unresolved.clear();
    this.ambiguous.clear();
    const add = (map: Map<string, string[]>, key: string, id: string) => {
      if (!key) return;
      const l = map.get(key);
      if (!l) map.set(key, [id]);
      else if (!l.includes(id)) l.push(id);
    };
    const rows = this.db.prepare("SELECT id, title, type, frontmatter FROM notes ORDER BY id").all() as { id: string; title: string; type: string; frontmatter: string }[];
    for (const r of rows) {
      this.nodes.set(r.id, { id: r.id, title: r.title, type: r.type, dir: path.posix.dirname(r.id) });
      // Paths and their folder suffixes are also kept slugged, so [[Notes/github-account]] finds Notes/GitHub account.md.
      const parts = r.id.replace(/\.md$/i, "").split("/").map(nameKey);
      for (let i = 0; i < parts.length - 1; i++) {
        add(i === 0 ? n.path : n.suffix, parts.slice(i).join("/"), r.id);
        add(i === 0 ? n.pathSlug : n.suffixSlug, parts.slice(i).map(slugKey).join("/"), r.id);
      }
      const base = nameKey(path.posix.basename(r.id, ".md"));
      add(n.title, nameKey(r.title), r.id);
      add(n.base, base, r.id);
      add(n.slug, slugKey(r.title), r.id);
      add(n.slug, slugKey(base), r.id);
      let fm: Record<string, unknown> = {};
      try {
        fm = JSON.parse(r.frontmatter);
      } catch {}
      const aliases = Array.isArray(fm.aliases) ? fm.aliases : typeof fm.aliases === "string" ? fm.aliases.split(",") : [];
      for (const a of aliases) {
        const s = nameKey(stripLink(a));
        add(n.alias, s, r.id);
        add(n.slug, slugKey(s), r.id);
      }
    }
    const weightOf = (kind: LinkKind, fmKey: string | null) =>
      kind === "fm" ? (this.cfg.graph.keys[fmKey ?? ""] ?? this.cfg.graph.keys["*"] ?? 0) : (this.cfg.graph.kinds[kind] ?? 0);
    const occs = this.db.prepare("SELECT from_id, pos, from_ord, kind, fm_key, target, target_heading FROM edges ORDER BY from_id, pos").all() as {
      from_id: string;
      pos: number;
      from_ord: number | null;
      kind: LinkKind;
      fm_key: string | null;
      target: string;
      target_heading: string | null;
    }[];
    for (const o of occs) {
      const to = this.resolveRaw(o.from_id, o.target);
      if (!to) {
        const key = o.target.toLowerCase();
        this.unresolved.set(key, (this.unresolved.get(key) ?? 0) + 1);
        continue;
      }
      if (to === o.from_id || !this.nodes.has(o.from_id)) continue;
      const occ: Occ = { pos: o.pos, kind: o.kind, fmKey: o.fm_key, ord: o.from_ord, heading: o.target_heading, weight: weightOf(o.kind, o.fm_key) };
      let byTo = this.outE.get(o.from_id);
      if (!byTo) this.outE.set(o.from_id, (byTo = new Map()));
      let e = byTo.get(to);
      if (!e) {
        e = { from: o.from_id, to, base: 0, kind: "", bodyCount: 0, occs: [] };
        byTo.set(to, e);
        let byFrom = this.inE.get(to);
        if (!byFrom) this.inE.set(to, (byFrom = new Map()));
        byFrom.set(o.from_id, e);
      }
      e.occs.push(occ);
      if (o.kind !== "fm" && o.kind !== "trailer") e.bodyCount++;
      if (e.occs.length === 1 || occ.weight > e.base) {
        e.base = occ.weight;
        e.kind = o.kind === "fm" ? `fm:${o.fm_key}` : o.kind;
      }
    }
    // Degrees count only links with some weight, so a generated trailer does not make every note look popular.
    for (const [from, byTo] of this.outE)
      for (const e of byTo.values()) {
        if (e.base < 0.15) continue;
        this.outdeg.set(from, (this.outdeg.get(from) ?? 0) + 1);
        this.indeg.set(e.to, (this.indeg.get(e.to) ?? 0) + 1);
      }
    this.dirty = false;
  }

  /** Pick one note among several with the same name: same folder as the linking note, then the shortest path, then the lowest id. */
  private pick(cands: string[] | undefined, fromId: string, name: string): string | null {
    if (!cands?.length) return null;
    if (cands.length === 1) return cands[0];
    const set = this.ambiguous.get(name) ?? new Set<string>();
    for (const c of cands) set.add(c);
    this.ambiguous.set(name, set);
    const dir = path.posix.dirname(fromId);
    const same = cands.filter((c) => path.posix.dirname(c) === dir);
    const pool = same.length ? same : cands;
    return [...pool].sort((a, b) => a.length - b.length || byId(a, b))[0];
  }

  /**
   * Resolution order: full path, path suffix (and both slugged), title, file name, alias, then the slug of a name.
   * Last, a retrieval shorthand (`retrieval.aliases`, e.g. mcp → Model Context Protocol) is tried as the name.
   * Names match with case and whitespace folded.
   */
  private resolveRaw(fromId: string, target: string, viaShorthand = false): string | null {
    const key = nameKey(target);
    if (!key) return null;
    const n = this.names;
    // A full path first, so [[Plan]] is the root Plan.md, as Obsidian writes it when another Plan.md exists elsewhere.
    const exact = this.pick(n.path.get(key), fromId, key);
    if (exact) return exact;
    if (key.includes("/")) {
      const slugged = key.split("/").map(slugKey).join("/");
      const p = this.pick(n.suffix.get(key), fromId, key) ?? this.pick(n.pathSlug.get(slugged), fromId, key) ?? this.pick(n.suffixSlug.get(slugged), fromId, key);
      if (p) return p;
    }
    const found = this.pick(n.title.get(key), fromId, key) ?? this.pick(n.base.get(key), fromId, key) ?? this.pick(n.alias.get(key), fromId, key) ?? this.pick(n.slug.get(slugKey(key)), fromId, key);
    if (found || viaShorthand) return found;
    // Own keys only: a link named "constructor" must not reach Object.prototype.
    const aliases = this.cfg.aliases;
    const expanded = aliases && Object.hasOwn(aliases, key) ? aliases[key] : undefined;
    return typeof expanded === "string" ? this.resolveRaw(fromId, expanded, true) : null;
  }

  /** The note a link target written in `fromId` points at, or null. */
  resolve(fromId: string, target: string): string | null {
    this.ensure();
    return this.resolveRaw(fromId, target);
  }

  /**
   * Notes whose links resolve to `id`, counting the links ParsedNote.links keeps (body links, the generated trailer
   * and the frontmatter link keys), as brain_graph's backlinks and the move/delete warnings always have.
   */
  linkers(id: string): string[] {
    this.ensure();
    const out: string[] = [];
    for (const e of this.inE.get(id)?.values() ?? []) if (e.occs.some((o) => o.kind !== "fm" || LINK_KEYS.includes(o.fmKey ?? ""))) out.push(e.from);
    return out.sort(byId);
  }

  node(id: string): Node | undefined {
    this.ensure();
    return this.nodes.get(id);
  }

  isStructural(id: string): boolean {
    const t = this.node(id)?.type;
    return !!t && STRUCTURAL_TYPES.has(t);
  }

  private reciprocal(e: PairEdge): boolean {
    if (!e.bodyCount || e.base < 0.3) return false;
    const back = this.outE.get(e.to)?.get(e.from);
    return !!back && back.bodyCount > 0 && back.base >= 0.3;
  }

  /**
   * How strongly a link joins two notes. Outgoing (this note names the neighbour): base weight × repeat factor ×
   * reciprocity × specificity of the target (a hub linked from everywhere says little). Incoming (the neighbour
   * names this note): 0.8 × the same, with the linking note's out-degree as the specificity.
   */
  strength(e: PairEdge, dir: "out" | "in"): number {
    const cf = e.bodyCount ? 1 + 0.25 * (Math.min(e.bodyCount, 3) - 1) : 1;
    const recip = this.reciprocal(e) ? 1.2 : 1;
    return dir === "out" ? e.base * cf * recip * spec(this.indeg.get(e.to) ?? 1) : 0.8 * e.base * cf * recip * spec(this.outdeg.get(e.from) ?? 1);
  }

  /** Every note one link away, strongest first (ties by id). The carrying occurrence is the strongest one. */
  neighbours(id: string): Neighbour[] {
    this.ensure();
    const out: Neighbour[] = [];
    const best = (e: PairEdge) => e.occs.reduce((a, b) => (b.weight > a.weight ? b : a));
    for (const e of this.outE.get(id)?.values() ?? []) {
      const o = best(e);
      out.push({ id: e.to, dir: "out", strength: this.strength(e, "out"), kind: e.kind, from: e.from, pos: o.pos, fromOrd: o.ord, heading: o.heading });
    }
    for (const e of this.inE.get(id)?.values() ?? []) {
      const o = best(e);
      out.push({ id: e.from, dir: "in", strength: this.strength(e, "in"), kind: e.kind, from: e.from, pos: o.pos, fromOrd: o.ord, heading: null });
    }
    // A pair linked both ways appears twice; keep the stronger direction.
    const keep = new Map<string, Neighbour>();
    for (const nb of out) {
      const cur = keep.get(nb.id);
      if (!cur || nb.strength > cur.strength) keep.set(nb.id, nb);
    }
    return [...keep.values()].sort((a, b) => b.strength - a.strength || byId(a.id, b.id));
  }

  /** The sentence (or list item, heading, table row) that carries a link occurrence. */
  ctx(fromId: string, pos: number): string | null {
    this.ctxStmt ??= this.db.prepare("SELECT ctx FROM edges WHERE from_id = ? AND pos = ?");
    return (this.ctxStmt.get(fromId, pos) as { ctx: string | null } | undefined)?.ctx ?? null;
  }

  stats(): GraphStats {
    this.ensure();
    const occurrences: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT kind, COUNT(*) c FROM edges GROUP BY kind ORDER BY kind").all() as { kind: string; c: number }[]) occurrences[r.kind] = r.c;
    let pairs = 0;
    let contentPairs = 0;
    const contentNotes = new Set<string>();
    for (const byTo of this.outE.values())
      for (const e of byTo.values()) {
        pairs++;
        const strong = e.occs.some((o) => o.kind === "sentence" || o.kind === "list_explained" || o.kind === "embed");
        if (strong && !this.isStructural(e.from) && !this.isStructural(e.to)) {
          contentPairs++;
          contentNotes.add(e.from);
        }
      }
    return {
      notes: this.nodes.size,
      occurrences,
      pairs,
      contentPairs,
      contentNotes: contentNotes.size,
      unresolved: [...this.unresolved.entries()].sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).slice(0, 15),
      ambiguous: [...this.ambiguous.entries()].map(([k, v]) => [k, [...v].sort(byId)] as [string, string[]]).sort((a, b) => byId(a[0], b[0])),
      topIn: [...this.indeg.entries()].sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).slice(0, 15),
    };
  }
}
