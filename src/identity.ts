import type { ResolvedConfig } from "./config.js";
import { queryTerms, type VaultIndex, type NoteRow } from "./vault/index.js";
import type { Policy, Principal } from "./policy.js";
import { firstParagraph, stripConnections, stripTitleHeading } from "./vault/parse.js";
import { nowIso, statusAt, type Fact } from "./facts.js";

const clean = (n: NoteRow) => stripTitleHeading(stripConnections(n.body), n.title).trim();

/** Room for captured facts in the bundle. */
const FACTS_BUDGET = 12000;

/** Over budget, who the owner is and how to work with them stay longest; project facts and pointers go first. */
const CATEGORY_RANK: Record<string, number> = { user: 0, feedback: 1, project: 2, reference: 3 };
const rankOf = (category: string) => CATEGORY_RANK[category] ?? 4;

/** A fact as written, minus its Replaces/Supersedes lines: they point at facts the bundle leaves out. */
function factBlock(f: Fact): string {
  return f.block
    .split("\n")
    .filter((l) => !/^\*\*(Replaces|Supersedes):\*\*/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Only facts true now. Replaced, expired and not-yet-valid facts stay in the memory file as history, where
 * brain_facts finds them. Over budget, keep the highest-ranked categories and, within one, the newest facts;
 * show what is kept grouped by category, oldest first.
 */
function currentFacts(index: VaultIndex, budget: number, file: string): string {
  const now = nowIso();
  const all = index.facts.all();
  const current = all.filter((f) => statusAt(f, now) === "current");
  const kept: { f: Fact; text: string }[] = [];
  let used = 0;
  for (const f of [...current].sort((a, b) => rankOf(a.category) - rankOf(b.category) || b.ord - a.ord)) {
    const text = factBlock(f);
    if (used + text.length + 2 > budget) break;
    kept.push({ f, text });
    used += text.length + 2;
  }
  kept.sort((a, b) => rankOf(a.f.category) - rankOf(b.f.category) || a.f.ord - b.f.ord);
  const hidden = all.length - current.length;
  const omitted = current.length - kept.length;
  const notes = [
    hidden ? `${hidden} replaced, expired or not-yet-valid fact(s) are kept in \`${file}\` as history; brain_facts with history=true lists them.` : "",
    omitted ? `${omitted} current fact(s) omitted for size; brain_facts lists them all.` : "",
  ].filter(Boolean);
  return [notes.join(" "), ...kept.map((k) => k.text)].filter(Boolean).join("\n\n") || "No current facts.";
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "\n[… truncated, read the full note with brain_read]";
}

/** The memory file is appended to, so over budget keep the newest facts: cut at a "## " fact heading. */
function capNewest(s: string, n: number, file: string): string {
  if (s.length <= n) return s;
  const tail = s.slice(-n);
  const at = tail.indexOf("\n## ");
  const kept = at >= 0 ? tail.slice(at + 1) : tail;
  const dropped = (s.slice(0, s.length - kept.length).match(/^## \d{4}-/gm) || []).length;
  return `[… ${dropped} older fact(s) omitted for size; read them with brain_read "${file}"]\n\n${kept}`;
}

function fm(row: NoteRow): Record<string, unknown> {
  try {
    return JSON.parse(row.frontmatter) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Assemble the persona bundle: who the owner is, how they want the assistant to
 * behave, what they are working on. Everything here is filtered through the
 * read policy for the calling principal.
 */
function haystack(n: NoteRow, topics: string[]): string {
  return `${n.title} ${topics.join(" ")} ${n.body.slice(0, 3000)}`.toLowerCase();
}

function termHits(hay: string, t: string): boolean {
  return t.length >= 4 ? hay.includes(t.slice(0, Math.max(4, t.length - 1))) : new RegExp(`\\b${t}\\b`).test(hay);
}

/**
 * Keep only topic terms that are discriminative across the memory notes: a term found in
 * more than 40% of them (e.g. "project", "user") says nothing about which notes apply.
 */
function discriminativeTerms(terms: string[], hays: string[]): string[] {
  if (!terms.length || !hays.length) return terms;
  const keep = terms.filter((t) => hays.filter((h) => termHits(h, t)).length / hays.length <= 0.4);
  return keep;
}

function matchesTopic(hay: string, terms: string[]): boolean {
  return terms.some((t) => termHits(hay, t));
}

export function buildIdentity(cfg: ResolvedConfig, index: VaultIndex, policy: Policy, p: Principal, topic?: string): { text: string; notes: string[] } {
  const id = cfg.identity;
  const used: string[] = [];
  const parts: string[] = [];
  let budget = id.maxTotalChars;
  const take = (s: string) => {
    budget -= s.length;
    parts.push(s);
  };
  const terms = topic ? queryTerms(topic) : [];

  take(
    `# Identity bundle · ${cfg.owner}\n\n` +
      `Generated ${new Date().toISOString()} from the second-brain vault (${index.count()} notes indexed, live)` +
      (terms.length ? `, memory filtered to the topic "${topic}"` : "") +
      `. Treat everything below as the owner's standing context: adopt their preferences, assume their expertise, ` +
      `and speak to them as the assistant they have already trained. Pull specifics with brain_context / brain_search / brain_project / brain_read.\n`,
  );

  // 1. Profile
  const profile = index.resolve(id.profileNote);
  if (profile && policy.canRead(profile, p)) {
    used.push(profile.id);
    take(`## Who they are\n\n${cap(clean(profile), id.maxCharsPerMemoryNote)}\n`);
  }

  // 2. Memory notes (preferences, feedback, project facts recorded by Claude Code)
  const allMemory = index
    .list({ project: id.memoryProject, limit: 200 })
    .filter((n) => n.id !== profile?.id && n.id !== cfg.memoryFile && policy.canRead(n, p))
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
  let memory = allMemory;
  if (terms.length) {
    const hays = allMemory.map((n) => haystack(n, index.topicsOf(n.id)));
    const useful = discriminativeTerms(terms, hays);
    // No discriminative term means the topic was too generic to filter on: keep the most recent few.
    memory = useful.length ? allMemory.filter((_, i) => matchesTopic(hays[i], useful)) : allMemory.slice(0, 5);
    if (!memory.length) memory = allMemory.slice(0, 5);
  }
  if (memory.length) {
    const chunks: string[] = [];
    for (const n of memory) {
      const body = cap(clean(n), id.maxCharsPerMemoryNote);
      const chunk = `### ${n.title} · ${n.type} · ${n.modified}\n\n${body}\n`;
      if (budget - chunk.length < 8000) {
        chunks.push(`### (${memory.length - chunks.length} more memory notes omitted for size; list them with brain_search project="${id.memoryProject}")\n`);
        break;
      }
      chunks.push(chunk);
      used.push(n.id);
      budget -= chunk.length;
    }
    const omitted = allMemory.length - memory.length;
    parts.push(
      `## Standing preferences, feedback and project memory\n\nRecorded across sessions. Follow the **How to apply** lines.` +
        (omitted > 0 ? ` ${omitted} memory note(s) not about "${topic}" were left out; call brain_identity without a topic for all of them.` : "") +
        `\n\n${chunks.join("\n")}`,
    );
  }

  // 3. Facts captured through this MCP
  const captured = index.get(cfg.memoryFile);
  if (captured && policy.canRead(captured, p)) {
    used.push(captured.id);
    // A memory file with no "## <stamp> · <category>" facts (hand-written in another shape) is shown as before.
    const body = index.facts.all().length ? currentFacts(index, FACTS_BUDGET, cfg.memoryFile) : capNewest(clean(captured), FACTS_BUDGET, cfg.memoryFile);
    take(`## Facts captured via brain_remember\n\n${body}\n`);
  }

  // 4. Skills: how the owner has shaped Claude's behaviour
  const skills = index.list({ project: id.skillsProject, limit: 50 }).filter((n) => policy.canRead(n, p));
  if (skills.length) {
    const lines = skills.map((n) => `- **${n.title}** (${n.type}) — ${cap(firstParagraph(stripConnections(n.body)), 300)}`);
    take(`## Behaviour shaping (${id.skillsProject})\n\n${lines.join("\n")}\n`);
  }

  // 5. Projects
  const hubs = index.hubs().filter((n) => policy.canRead(n, p));
  if (hubs.length) {
    const lines = hubs.map((h) => {
      const f = fm(h);
      // Generated hubs carry note-count; hand-written ones (Notes/) don't, so count the project's notes live.
      const count = f["note-count"] ?? index.list({ project: h.title, limit: 1000 }).length;
      const touched = f["last-touched"] instanceof Date ? (f["last-touched"] as Date).toISOString().slice(0, 10) : (f["last-touched"] ?? h.modified);
      return `- **${h.title}** — ${cap(firstParagraph(h.body), 240)} *(${count} notes, last touched ${touched})*`;
    });
    take(`## Projects\n\nUse brain_project for a briefing on any of these.\n\n${lines.join("\n")}\n`);
  }

  // 6. Current focus
  const since = new Date(Date.now() - id.focusWindowDays * 86400_000).toISOString().slice(0, 10);
  const recent = index.recent(since, { limit: 20 }).filter((n) => policy.canRead(n, p) && n.project !== id.memoryProject);
  if (recent.length) {
    const lines = recent.map((n) => `- ${n.modified} · **${n.title}** · ${n.project ?? "—"} · ${n.type}`);
    take(`## Current focus (last ${id.focusWindowDays} days)\n\n${lines.join("\n")}\n`);
  } else {
    take(`## Current focus\n\nNo notes modified in the last ${id.focusWindowDays} days. Use brain_recent with a wider window.\n`);
  }

  take(
    `## How to use this brain\n\n` +
      `- Ground answers in notes: brain_search for anything factual, brain_project before discussing a project, brain_graph to hop between related work.\n` +
      `- Cite note ids (vault paths) when you rely on a note.\n` +
      `- When the owner states a durable preference, decision or fact, save it with brain_remember; when they produce a durable document, save it with brain_capture.\n` +
      `- When a fact above changes, save the new one with brain_remember and \`replaces\` set to the old fact's id (the stamp in its heading); the old one becomes history. Ask brain_facts what was true at an earlier date.\n` +
      `- Contents are confidential to the owner. Never echo credentials; redacted markers must stay redacted.\n`,
  );

  return { text: parts.join("\n"), notes: used };
}
