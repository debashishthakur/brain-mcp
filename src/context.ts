import type { ResolvedConfig } from "./config.js";
import { queryTerms, titleOverlap, RRF_K, TITLE_BONUS, type VaultIndex, type NoteRow, type SectionHit } from "./vault/index.js";
import type { Policy, Principal } from "./policy.js";

const STRUCTURAL = new Set(["hub", "concept", "moc", "meta", "guide"]);

export interface ContextOptions {
  project?: string;
  budgetChars?: number;
  maxSectionsPerNote?: number;
}

interface Candidate {
  note: NoteRow;
  ord: number;
  heading: string;
  score: number;
  why: string[];
}

export interface ContextResult {
  text: string;
  notes: string[];
  candidates: number;
  included: number;
}

/**
 * Deterministic context pack: section-level FTS fused with note-level FTS and a graph
 * neighbourhood bonus, packed under a character budget. Reciprocal rank fusion means no
 * single signal can dominate. A reranker can later re-score `ranked` before packing.
 */
export function buildContext(cfg: ResolvedConfig, index: VaultIndex, policy: Policy, p: Principal, question: string, o: ContextOptions = {}): ContextResult {
  const c = cfg.context;
  const budget = Math.max(2000, Math.min(o.budgetChars ?? c.budgetChars, 60000));
  const perNote = Math.max(1, Math.min(o.maxSectionsPerNote ?? c.maxSectionsPerNote, 6));
  const terms = queryTerms(question);
  if (!terms.length) return { text: "The question has no searchable terms.", notes: [], candidates: 0, included: 0 };

  const noteCache = new Map<string, NoteRow | undefined>();
  const noteOf = (id: string) => {
    if (!noteCache.has(id)) noteCache.set(id, index.get(id));
    return noteCache.get(id);
  };
  const readable = (n: NoteRow | undefined): n is NoteRow => !!n && policy.canRead(n, p);

  // Signal 1: section hits
  const secHits: SectionHit[] = index.searchSections(question, { project: o.project, limit: c.candidateSections });
  // Signal 2: note hits
  const noteHits = index.search(question, { project: o.project, limit: c.candidateNotes });
  const noteRank = new Map<string, number>();
  noteHits.forEach((h, i) => noteRank.set(h.id, i));
  // Signal 3: graph neighbourhood of the top note hits
  const neighbours = new Set<string>();
  for (const h of noteHits.slice(0, 3)) {
    for (const l of index.outgoing(h.id)) if (l.note) neighbours.add(l.note.id);
    for (const b of index.backlinks(h.id, 30)) neighbours.add(b.id);
  }
  const today = Date.now();

  const byKey = new Map<string, Candidate>();
  secHits.forEach((h, i) => {
    const note = noteOf(h.note_id);
    if (!readable(note)) return;
    const key = `${h.note_id}#${h.ord}`;
    const cand: Candidate = { note, ord: h.ord, heading: h.heading, score: 1 / (RRF_K + i), why: [`section rank ${i + 1}`] };
    const nr = noteRank.get(h.note_id);
    if (nr !== undefined) {
      cand.score += 0.7 / (RRF_K + nr);
      cand.why.push(`note rank ${nr + 1}`);
    }
    if (neighbours.has(h.note_id)) {
      cand.score += 0.004;
      cand.why.push("linked to a top hit");
    }
    byKey.set(key, cand);
  });
  // Notes that matched as a whole but had no section hit: bring in their preamble.
  for (const h of noteHits) {
    if ([...byKey.values()].some((cnd) => cnd.note.id === h.id)) continue;
    const note = noteOf(h.id);
    if (!readable(note)) continue;
    const first = index.section(h.id, 0);
    if (!first) continue;
    byKey.set(`${h.id}#0`, { note, ord: 0, heading: first.heading, score: 0.7 / (RRF_K + noteRank.get(h.id)!), why: [`note rank ${noteRank.get(h.id)! + 1}`] });
  }
  for (const cand of byKey.values()) {
    const age = (today - Date.parse(cand.note.modified)) / 86400_000;
    if (age < 90) cand.score += 0.002;
    const t = titleOverlap(cand.note.title, terms);
    if (t > 0) {
      cand.score += TITLE_BONUS * t;
      cand.why.push(`title matches ${Math.round(t * 100)}%`);
    }
    const h = cand.ord > 0 ? titleOverlap(cand.heading, terms) : 0;
    if (h > 0) {
      cand.score += (TITLE_BONUS / 2) * h;
      cand.why.push(`heading matches ${Math.round(h * 100)}%`);
    }
  }

  let ranked = [...byKey.values()].sort((a, b) => b.score - a.score);
  const content = ranked.filter((cnd) => !STRUCTURAL.has(cnd.note.type));
  if (content.length) ranked = content;

  // Pack
  const perNoteCount = new Map<string, number>();
  const picked: Candidate[] = [];
  let used = 0;
  for (const cand of ranked) {
    const n = perNoteCount.get(cand.note.id) ?? 0;
    if (n >= perNote) continue;
    const sec = index.section(cand.note.id, cand.ord);
    if (!sec) continue;
    const len = Math.min(sec.text.length, c.maxSectionChars);
    if (picked.length && used + len > budget) continue;
    picked.push(cand);
    perNoteCount.set(cand.note.id, n + 1);
    used += len;
    if (used >= budget) break;
  }

  if (!picked.length) {
    return {
      text: `Nothing in the vault matched "${question}". Try brain_search with different keywords, or brain_project to browse a project.`,
      notes: [],
      candidates: ranked.length,
      included: 0,
    };
  }

  // Render, grouped by note in rank order of first appearance
  const order: string[] = [];
  const groups = new Map<string, Candidate[]>();
  for (const cand of picked) {
    if (!groups.has(cand.note.id)) {
      groups.set(cand.note.id, []);
      order.push(cand.note.id);
    }
    groups.get(cand.note.id)!.push(cand);
  }
  const parts: string[] = [];
  parts.push(`# Context for: ${question}\n`);
  parts.push(`${picked.length} section(s) from ${order.length} note(s), chosen from ${ranked.length} candidates by keyword rank fusion. Cite note ids when you use them.\n`);
  parts.push(`## Sources\n`);
  order.forEach((id, i) => {
    const n = groups.get(id)![0].note;
    const heads = groups.get(id)!.map((cnd) => cnd.heading).join(" · ");
    parts.push(`${i + 1}. **${n.title}** \`${id}\` — ${n.type}${n.project ? ` · ${n.project}` : ""} · ${n.modified} — ${heads}`);
  });
  parts.push("");
  order.forEach((id, i) => {
    const cands = groups.get(id)!.sort((a, b) => a.ord - b.ord);
    const n = cands[0].note;
    parts.push(`---\n## [${i + 1}] ${n.title}\n\`${id}\`\n`);
    for (const cand of cands) {
      const sec = index.section(id, cand.ord)!;
      let text = sec.text;
      if (text.length > c.maxSectionChars) text = text.slice(0, c.maxSectionChars).trimEnd() + `\n[… section truncated; brain_read note="${id}" section="${sec.heading}" for the rest]`;
      parts.push(policy.redact(text).text + "\n");
    }
  });
  return { text: parts.join("\n"), notes: order, candidates: ranked.length, included: picked.length };
}
