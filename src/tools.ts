import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "./config.js";
import type { VaultIndex, NoteRow } from "./vault/index.js";
import { section, stripConnections, stripTitleHeading, firstParagraph } from "./vault/parse.js";
import { Policy, type Principal, ALL_SCOPES } from "./policy.js";
import { Audit } from "./audit.js";
import { buildIdentity } from "./identity.js";
import { buildContext } from "./context.js";
import { judge, parseMemoryBlocks } from "./memory.js";

export interface Deps {
  cfg: ResolvedConfig;
  index: VaultIndex;
  policy: Policy;
  audit: Audit;
  /** Principal used when the transport carries no auth info (stdio). */
  defaultPrincipal: Principal;
}

interface Extra {
  authInfo?: { clientId: string; scopes: string[] };
  sessionId?: string;
}

function principalOf(extra: Extra, d: Deps): Principal {
  if (extra.authInfo) {
    return { clientId: extra.authInfo.clientId, scopes: new Set(extra.authInfo.scopes), transport: "http", sessionId: extra.sessionId };
  }
  return { ...d.defaultPrincipal, sessionId: extra.sessionId };
}

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

function meta(n: NoteRow, index: VaultIndex): string {
  const topics = index.topicsOf(n.id);
  const bits = [`type: ${n.type}`, n.project ? `project: ${n.project}` : null, `modified: ${n.modified}`, topics.length ? `topics: ${topics.join(", ")}` : null];
  return bits.filter(Boolean).join(" · ");
}

function line(n: NoteRow, index: VaultIndex, extra = ""): string {
  return `- **${n.title}** \`${n.id}\` — ${meta(n, index)}${extra ? ` — ${extra}` : ""}`;
}

function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "untitled";
}

function yq(s: string): string {
  return JSON.stringify(s);
}

export function instructions(cfg: ResolvedConfig): string {
  return (
    `This server is ${cfg.owner}'s second brain: a live Obsidian vault of their projects, decisions, runbooks, preferences and memory.\n\n` +
    `FIRST ACTION in every conversation: call brain_identity with no arguments, before answering anything, and adopt what it returns ` +
    `as standing context (who the owner is, how they want you to work, what they are working on). Do not ask the owner to re-explain themselves.\n\n` +
    `Then: brain_context for any question the vault might answer (one call, returns the relevant sections), brain_search to locate notes, ` +
    `brain_project before discussing a project, brain_graph to move between related notes, brain_read for full text, ` +
    `brain_recent for "what am I working on". Record durable facts with brain_remember and durable documents with brain_capture.\n\n` +
    `All content is confidential to the owner. Never reproduce credentials; keep [REDACTED:*] markers as-is.`
  );
}

export function createBrainServer(d: Deps): McpServer {
  const { cfg, index, policy, audit } = d;
  const server = new McpServer({ name: "second-brain", version: "0.1.0" }, { instructions: instructions(cfg) });

  const readable = (rows: NoteRow[], p: Principal) => rows.filter((n) => policy.canRead(n, p));

  // ------------------------------------------------------------ identity
  server.registerTool(
    "brain_identity",
    {
      title: "Load the owner's identity and standing context",
      description:
        "Call this FIRST in every conversation. Returns who the owner is, their preferences and feedback rules, the projects they run, and what they touched recently. Adopt it as your persona and working context. Pass `topic` (a few words about what the conversation is about) to get a smaller bundle with only the memory notes that apply.",
      inputSchema: {
        topic: z.string().max(200).optional().describe("What this conversation is about, e.g. 'interview prep' or 'database backups'. Omit for the full bundle."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_identity", p, args, () => {
        const { text: t, notes } = buildIdentity(cfg, index, policy, p, args.topic);
        const r = policy.redact(t);
        return { result: text(r.text), notes, redactions: r.count };
      });
    },
  );

  // ------------------------------------------------------------ context
  server.registerTool(
    "brain_context",
    {
      title: "Get the vault sections that answer a question",
      description:
        "One call that returns the most relevant sections from across the vault for a question, with source note ids. Use this before brain_search when you need to answer or reason about something the owner may have written down. Ask in plain words; it works on keywords, so include the specific nouns.",
      inputSchema: {
        question: z.string().min(3).max(500).describe("The question or topic, in plain words with specific nouns"),
        project: z.string().optional().describe("Restrict to one project"),
        budget_chars: z.number().int().min(2000).max(60000).optional().describe("Size cap for the returned pack (default from config, ~18000)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_context", p, args, () => {
        const r = buildContext(cfg, index, policy, p, args.question, { project: args.project, budgetChars: args.budget_chars });
        return { result: text(r.text), notes: r.notes };
      });
    },
  );

  // ------------------------------------------------------------ search
  server.registerTool(
    "brain_search",
    {
      title: "Search the vault",
      description:
        "Full-text search across every note with optional filters. Returns ranked hits with snippets and note ids for brain_read. Use short keyword queries (2-5 terms), not sentences.",
      inputSchema: {
        query: z.string().min(1).describe("Keywords to search for"),
        project: z.string().optional().describe("Restrict to one project, e.g. 'Website Redesign'"),
        type: z.enum(["note", "runbook", "agent", "progress", "research", "architecture", "plan", "decision", "audit", "spec", "hub", "concept"]).optional(),
        topic: z.string().optional().describe("Restrict to notes tagged with a concept, e.g. 'OAuth'"),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only notes modified on/after this date"),
        limit: z.number().int().min(1).max(50).optional().default(10),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_search", p, args, () => {
        const hits = index.search(args.query, { project: args.project, type: args.type, topic: args.topic, since: args.since, limit: args.limit * 2 });
        const visible = hits.filter((h) => policy.canRead({ id: h.id, project: h.project, visibility: index.get(h.id)?.visibility ?? null }, p)).slice(0, args.limit);
        if (!visible.length) return { result: text(`No notes matched "${args.query}". Try fewer or different keywords, or drop the filters.`), notes: [] };
        const lines = visible.map((h) => `- **${h.title}** \`${h.id}\` — ${h.type}${h.project ? ` · ${h.project}` : ""} · ${h.modified}\n  ${policy.redact(h.snippet.replace(/\s+/g, " ")).text}`);
        return { result: text(`${visible.length} hit(s) for "${args.query}":\n\n${lines.join("\n")}`), notes: visible.map((h) => h.id) };
      });
    },
  );

  // ------------------------------------------------------------ read
  server.registerTool(
    "brain_read",
    {
      title: "Read a note",
      description: "Return one note in full (or one section of it) by note id, title, or wikilink target. Includes frontmatter metadata, topics, and links.",
      inputSchema: {
        note: z.string().min(1).describe("Note id (vault path), exact title, or [[wikilink]]"),
        section: z.string().optional().describe("Heading text to return only that section"),
        include_connections: z.boolean().optional().default(false).describe("Keep the generated '## Connections' trailer"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_read", p, args, () => {
        const n = index.resolve(args.note);
        if (!n || !policy.canRead(n, p)) return { result: fail(`No readable note matches "${args.note}". Use brain_search to find the id.`), notes: [] };
        let body = stripTitleHeading(args.include_connections ? n.body : stripConnections(n.body), n.title);
        if (args.section) {
          const s = section(body, args.section);
          if (!s) return { result: fail(`Note "${n.title}" has no section titled "${args.section}".`), notes: [n.id] };
          body = s;
        }
        const r = policy.redact(body.trim());
        const out = n.project ? [n.project] : [];
        const related = index.outgoing(n.id).filter((l) => l.note && l.note.id !== n.id).map((l) => l.note!.title).filter((t) => !out.includes(t));
        const header = `# ${n.title}\n\`${n.id}\` · ${meta(n, index)}${related.length ? `\nlinks: ${[...new Set(related)].slice(0, 25).join(", ")}` : ""}\n\n`;
        return { result: text(header + r.text), notes: [n.id], redactions: r.count };
      });
    },
  );

  // ------------------------------------------------------------ project
  server.registerTool(
    "brain_project",
    {
      title: "Project briefing",
      description:
        "One-call briefing on a project: what it is, its notes grouped by type, latest progress entries, decisions, and what changed recently. Call this before discussing any project. Omit the project name to list all projects.",
      inputSchema: {
        project: z.string().optional().describe("Project / hub name, e.g. 'Website Redesign'. Omit to list projects."),
        recent_days: z.number().int().min(1).max(365).optional().default(30),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_project", p, args, () => {
        if (!args.project) {
          const hubs = readable(index.hubs(), p);
          const lines = hubs.map((h) => `- **${h.title}** — ${firstParagraph(h.body).slice(0, 200)}`);
          return { result: text(`Projects (${hubs.length}):\n\n${lines.join("\n")}`), notes: hubs.map((h) => h.id) };
        }
        const hub = index.hubs().find((h) => h.title.toLowerCase() === args.project!.toLowerCase()) ?? index.resolve(args.project);
        const name = hub?.type === "hub" ? hub.title : args.project;
        const notes = readable(index.list({ project: name, limit: 500 }), p);
        if (!notes.length && !(hub && policy.canRead(hub, p))) return { result: fail(`No project named "${args.project}". Call brain_project with no arguments to list projects.`), notes: [] };
        const byType = new Map<string, NoteRow[]>();
        for (const n of notes) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
        const sections: string[] = [];
        sections.push(`# ${name}\n`);
        if (hub && policy.canRead(hub, p)) sections.push(`${firstParagraph(hub.body)}\n`);
        const progress = (byType.get("progress") ?? []).slice(0, 5);
        if (progress.length) {
          sections.push(`## Latest progress\n\n${progress.map((n) => `### ${n.title} · ${n.modified}\n${policy.redact(stripTitleHeading(stripConnections(n.body), n.title)).text.trim().slice(0, 900)}`).join("\n\n")}\n`);
        }
        const decisions = byType.get("decision") ?? [];
        if (decisions.length) sections.push(`## Decisions\n\n${decisions.map((n) => line(n, index, firstParagraph(n.body).slice(0, 160))).join("\n")}\n`);
        const since = daysAgo(args.recent_days);
        const changed = notes.filter((n) => n.modified >= since).slice(0, 15);
        if (changed.length) sections.push(`## Changed in the last ${args.recent_days} days\n\n${changed.map((n) => line(n, index)).join("\n")}\n`);
        const order = ["architecture", "spec", "plan", "runbook", "agent", "research", "audit", "note"];
        for (const t of [...order, ...[...byType.keys()].filter((k) => !order.includes(k) && k !== "progress" && k !== "decision")]) {
          const rows = byType.get(t);
          if (!rows?.length) continue;
          sections.push(`## ${t} (${rows.length})\n\n${rows.slice(0, 40).map((n) => `- **${n.title}** \`${n.id}\` · ${n.modified}`).join("\n")}${rows.length > 40 ? `\n- … ${rows.length - 40} more` : ""}\n`);
        }
        return { result: text(sections.join("\n")), notes: [hub?.id, ...notes.map((n) => n.id)].filter((x): x is string => !!x) };
      });
    },
  );

  // ------------------------------------------------------------ graph
  server.registerTool(
    "brain_graph",
    {
      title: "Explore the link graph",
      description:
        "Neighbours of a note, hub, or concept: outgoing links, backlinks, and notes sharing the same topics. For a concept (e.g. 'OAuth') this shows every project that touches it. Use it to hop sideways between projects.",
      inputSchema: {
        note: z.string().min(1).describe("Note id, title, concept name, or [[wikilink]]"),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_graph", p, args, () => {
        const n = index.resolve(args.note);
        if (!n || !policy.canRead(n, p)) return { result: fail(`No readable note matches "${args.note}".`), notes: [] };
        const out = index.outgoing(n.id).filter((l) => l.note && l.note.id !== n.id && policy.canRead(l.note, p));
        const back = readable(index.backlinks(n.id, args.limit), p);
        const shared = index.sharedTopicNeighbours(n.id, args.limit).filter((s) => policy.canRead(s.note, p));
        const parts = [`# ${n.title}\n\`${n.id}\` · ${meta(n, index)}\n`];
        if (out.length) parts.push(`## Links out (${out.length})\n\n${out.slice(0, args.limit).map((l) => line(l.note!, index)).join("\n")}\n`);
        if (back.length) {
          const byProject = new Map<string, NoteRow[]>();
          for (const b of back) byProject.set(b.project ?? "(no project)", [...(byProject.get(b.project ?? "(no project)") ?? []), b]);
          const blocks = [...byProject.entries()].map(([proj, rows]) => `**${proj}**\n${rows.map((r) => line(r, index)).join("\n")}`);
          parts.push(`## Backlinks (${back.length})\n\n${blocks.join("\n\n")}\n`);
        }
        if (shared.length) parts.push(`## Shares topics with\n\n${shared.map((s) => line(s.note, index, `shares ${s.shared.join(", ")}`)).join("\n")}\n`);
        if (parts.length === 1) parts.push("No links in either direction.");
        return { result: text(parts.join("\n")), notes: [n.id, ...out.map((l) => l.note!.id), ...back.map((b) => b.id)] };
      });
    },
  );

  // ------------------------------------------------------------ recent
  server.registerTool(
    "brain_recent",
    {
      title: "What changed recently",
      description: "Notes modified in the last N days, newest first. Answers 'what am I working on' and 'what did I do last week'. Hubs and concepts are excluded unless include_structural is set.",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().default(14),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(30),
        include_structural: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_recent", p, args, () => {
        const rows = readable(index.recent(daysAgo(args.days), { limit: args.limit, project: args.project, includeStructural: args.include_structural }), p);
        if (!rows.length) return { result: text(`Nothing modified in the last ${args.days} days${args.project ? ` in ${args.project}` : ""}.`), notes: [] };
        const lines = rows.map((n) => line(n, index, policy.redact(firstParagraph(stripConnections(n.body))).text.slice(0, 160)));
        return { result: text(`${rows.length} note(s) modified since ${daysAgo(args.days)}:\n\n${lines.join("\n")}`), notes: rows.map((n) => n.id) };
      });
    },
  );

  // ------------------------------------------------------------ capture (write)
  const captureDirAbs = path.join(cfg.vaultDir, cfg.captureDir);
  const writeCaptured = (rel: string, content: string) => {
    const abs = path.resolve(cfg.vaultDir, rel);
    if (!abs.startsWith(captureDirAbs + path.sep) && abs !== captureDirAbs) throw new Error("write outside capture folder refused");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    index.upsertFile(abs);
    return abs;
  };

  server.registerTool(
    "brain_capture",
    {
      title: "Save a durable note",
      description:
        "Write a new note into the vault's capture folder with graph-ready frontmatter. Use for plans, decisions, ideas, meeting notes, or session logs the owner wants to keep. Not for one-line facts (use brain_remember).",
      inputSchema: {
        title: z.string().min(3).max(140).describe("Specific noun phrase, not a filename"),
        body: z.string().min(1).describe("Markdown body. Link concepts inline with [[Concept]] on first mention."),
        kind: z.enum(["note", "idea", "decision", "plan", "log", "research"]).optional().default("note"),
        project: z.string().optional().describe("Project hub name this belongs to, e.g. 'Website Redesign'"),
        topics: z.array(z.string()).max(8).optional().describe("Concept names, e.g. ['OAuth', 'RAG']"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_capture", p, args, () => {
        if (!policy.canWrite(p)) return { result: fail("This connection has no write scope."), notes: [] };
        const date = today();
        let rel = `${cfg.captureDir}/${date} ${safeFileName(args.title)}.md`;
        for (let i = 2; fs.existsSync(path.join(cfg.vaultDir, rel)); i++) rel = `${cfg.captureDir}/${date} ${safeFileName(args.title)} (${i}).md`;
        const projectHub = args.project ? index.hubs().find((h) => h.title.toLowerCase() === args.project!.toLowerCase()) : undefined;
        const warn = args.project && !projectHub ? `\n\nNote: no hub named "${args.project}" exists; the project link will stay unresolved until one is created.` : "";
        const fmLines = [
          "---",
          `title: ${yq(args.title)}`,
          `type: ${args.kind}`,
          ...(args.project ? [`project: ${yq(`[[${projectHub?.title ?? args.project}]]`)}`] : []),
          ...(args.topics?.length ? ["topics:", ...args.topics.map((t) => `  - ${yq(`[[${t}]]`)}`)] : []),
          "tags:",
          "  - captured",
          `  - type/${args.kind}`,
          ...(projectHub ? [`  - project/${projectHub.title.toLowerCase().replace(/\s+/g, "-")}`] : []),
          `source: ${yq(`mcp:${p.clientId}`)}`,
          `captured: ${date}`,
          `modified: ${date}`,
          "---",
          "",
        ];
        const content = fmLines.join("\n") + `# ${args.title}\n\n${args.body.trim()}\n`;
        writeCaptured(rel, content);
        return { result: text(`Saved \`${rel}\`.${warn}`), notes: [rel] };
      });
    },
  );

  server.registerTool(
    "brain_remember",
    {
      title: "Remember a durable fact",
      description:
        "Append one durable fact about the owner to their memory file: a preference, a correction on how to work, a project constraint, or a reference. It becomes part of brain_identity immediately. Include why it matters and how to apply it. Near-duplicates of existing memory are refused; pass force=true to store anyway. Do not store session trivia.",
      inputSchema: {
        fact: z.string().min(5).max(2000),
        category: z.enum(["user", "feedback", "project", "reference"]).describe("user = who they are; feedback = how to work with them; project = ongoing work; reference = pointer"),
        why: z.string().max(1000).optional(),
        how_to_apply: z.string().max(1000).optional(),
        force: z.boolean().optional().default(false).describe("Store even if it looks like a duplicate"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      return audit.run("brain_remember", p, args, () => {
        if (!policy.canWrite(p)) return { result: fail("This connection has no write scope."), notes: [] };
        const abs = path.join(cfg.vaultDir, cfg.memoryFile);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        let existing = "";
        if (fs.existsSync(abs)) existing = fs.readFileSync(abs, "utf8");
        else
          existing =
            ["---", 'title: "Memory"', "type: note", `project: ${yq(`[[${cfg.identity.memoryProject}]]`)}`, "tags:", "  - captured", "  - memory", `captured: ${today()}`, `modified: ${today()}`, "---", "", "# Memory", "", "Facts recorded through the second-brain MCP. Newest at the bottom.", ""].join("\n");
        const blocks = parseMemoryBlocks(existing);
        const verdict = judge(args.fact, blocks);
        if (verdict.kind === "duplicate" && !args.force) {
          const m = verdict.match!;
          return {
            result: fail(`Not stored: this looks like a duplicate of the ${m.category} fact recorded ${m.id}:\n\n> ${m.text.split("\n")[0]}\n\nIf it is genuinely new, call again with force=true.`),
            notes: [cfg.memoryFile],
          };
        }
        // Related generated memory notes, for the caller's awareness only.
        const related = index
          .search(args.fact, { project: cfg.identity.memoryProject, limit: 3 })
          .filter((h) => h.id !== cfg.memoryFile)
          .map((h) => h.title);
        existing = existing.replace(/^modified: .*$/m, `modified: ${today()}`);
        const supersedes = verdict.kind === "update" ? ["", `**Supersedes:** ${verdict.match!.id} · ${verdict.match!.category}`] : [];
        const block = [`## ${stamp} · ${args.category}`, "", args.fact.trim(), ...(args.why ? ["", `**Why:** ${args.why.trim()}`] : []), ...(args.how_to_apply ? ["", `**How to apply:** ${args.how_to_apply.trim()}`] : []), ...supersedes, "", `*via mcp:${p.clientId}*`, ""].join("\n");
        writeCaptured(cfg.memoryFile, existing.trimEnd() + "\n\n" + block);
        const notes: string[] = [];
        if (verdict.kind === "update") notes.push(`Marked as superseding the ${verdict.match!.category} fact from ${verdict.match!.id}.`);
        if (related.length) notes.push(`Related memory notes already exist: ${related.join("; ")}.`);
        if (blocks.length + 1 >= 200) notes.push(`Memory file now holds ${blocks.length + 1} facts; consider pruning.`);
        return { result: text(`Remembered (${args.category}). It is now part of brain_identity.${notes.length ? "\n" + notes.join("\n") : ""}`), notes: [cfg.memoryFile] };
      });
    },
  );

  // ------------------------------------------------------------ resources
  server.registerResource(
    "identity",
    "brain://identity",
    { title: "Owner identity bundle", description: "Persona and standing context, same as brain_identity", mimeType: "text/markdown" },
    async (uri, extra) => {
      const p = principalOf(extra as Extra, d);
      const { text: t } = buildIdentity(cfg, index, policy, p);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: policy.redact(t).text }] };
    },
  );

  server.registerResource(
    "note",
    new ResourceTemplate("brain://note/{+path}", { list: undefined }),
    { title: "Vault note", description: "A single note by vault path", mimeType: "text/markdown" },
    async (uri, vars, extra) => {
      const p = principalOf(extra as Extra, d);
      const n = index.resolve(decodeURIComponent(String(vars.path)));
      if (!n || !policy.canRead(n, p)) throw new Error(`Note not found: ${String(vars.path)}`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: policy.redact(n.body).text }] };
    },
  );

  // ------------------------------------------------------------ prompts
  server.registerPrompt(
    "assume_persona",
    { title: "Assume the owner's assistant persona", description: "Loads the identity bundle into the conversation" },
    async (extra) => {
      const p = principalOf(extra as Extra, d);
      const { text: t } = buildIdentity(cfg, index, policy, p);
      return { messages: [{ role: "user", content: { type: "text", text: `${policy.redact(t).text}\n\nAcknowledge briefly and continue as this assistant.` } }] };
    },
  );

  server.registerPrompt(
    "project_briefing",
    { title: "Brief me on a project", description: "Pulls the project briefing and asks for a summary", argsSchema: { project: z.string().describe("Project name") } },
    async (args, extra) => {
      const p = principalOf(extra as Extra, d);
      const hub = index.hubs().find((h) => h.title.toLowerCase() === args.project.toLowerCase());
      const notes = hub ? readable(index.list({ project: hub.title, limit: 100 }), p) : [];
      const listing = notes.map((n) => `- ${n.title} (${n.type}, ${n.modified})`).join("\n");
      return {
        messages: [
          { role: "user", content: { type: "text", text: `Brief me on ${args.project}. Start from this note list, then call brain_project and brain_read as needed.\n\n${listing || "(no notes found; call brain_project with no arguments to list projects)"}` } },
        ],
      };
    },
  );

  return server;
}

export function fullPrincipal(transport: "stdio" | "http", clientId: string): Principal {
  return { clientId, scopes: new Set(ALL_SCOPES), transport };
}
