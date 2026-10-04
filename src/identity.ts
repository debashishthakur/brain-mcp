import type { ResolvedConfig } from "./config.js";
import { queryTerms, type VaultIndex, type NoteRow } from "./vault/index.js";
import type { Policy, Principal } from "./policy.js";
import { firstParagraph, stripConnections, stripTitleHeading } from "./vault/parse.js";

const clean = (n: NoteRow) => stripTitleHeading(stripConnections(n.body), n.title).trim();

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n).trimEnd() + "\n[… truncated, read the full note with brain_read]";
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
    take(`## Facts captured via brain_remember\n\n${cap(clean(captured), 12000)}\n`);
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
      const count = f["note-count"] ?? "";
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
      `- Contents are confidential to the owner. Never echo credentials; redacted markers must stay redacted.\n`,
  );

  return { text: parts.join("\n"), notes: used };
}
