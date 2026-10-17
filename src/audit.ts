import fs from "node:fs";
import path from "node:path";
import type { Principal } from "./policy.js";

export interface AuditEntry {
  ts: string;
  transport: string;
  client: string;
  session?: string;
  tool: string;
  args?: unknown;
  ok: boolean;
  ms: number;
  notes?: string[];
  redactions?: number;
  /** brain_search / brain_context: the coverage label and the ranker's counts (no text), so refusals can be measured. */
  coverage?: string;
  rank?: unknown;
  error?: string;
}

/** Extra fields a tool may add to its own audit line. */
export type AuditMeta = Pick<AuditEntry, "coverage" | "rank">;

const MAX_ARG_CHARS = 600;

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length <= MAX_ARG_CHARS ? v : s.slice(0, MAX_ARG_CHARS) + "…";
}

export class Audit {
  private readonly file: string;

  constructor(logDir: string) {
    this.file = path.join(logDir, "audit.jsonl");
  }

  write(entry: AuditEntry): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify({ ...entry, args: truncate(entry.args) }) + "\n");
    } catch (e) {
      console.error(`[audit] write failed: ${(e as Error).message}`);
    }
  }

  /** Time a tool call, log it, and rethrow on failure. */
  async run<T>(
    tool: string,
    p: Principal,
    args: unknown,
    fn: () =>
      | Promise<{ result: T; notes?: string[]; redactions?: number; meta?: AuditMeta }>
      | { result: T; notes?: string[]; redactions?: number; meta?: AuditMeta },
  ): Promise<T> {
    const t0 = Date.now();
    const base = { ts: new Date().toISOString(), transport: p.transport, client: p.clientId, session: p.sessionId, tool, args };
    try {
      const out = await fn();
      this.write({ ...base, ok: true, ms: Date.now() - t0, notes: out.notes, redactions: out.redactions, ...out.meta });
      return out.result;
    } catch (e) {
      this.write({ ...base, ok: false, ms: Date.now() - t0, error: (e as Error).message });
      throw e;
    }
  }
}
