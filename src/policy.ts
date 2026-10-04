import { minimatch } from "minimatch";
import type { ResolvedConfig } from "./config.js";

export const SCOPE_READ = "brain:read";
export const SCOPE_WRITE = "brain:write";
export const SCOPE_PRIVATE = "brain:private";
export const ALL_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE] as const;

export interface Principal {
  clientId: string;
  scopes: ReadonlySet<string>;
  transport: "stdio" | "http";
  sessionId?: string;
}

export interface NoteLike {
  id: string;
  project: string | null;
  visibility: string | null;
}

interface Pattern {
  kind: string;
  re: RegExp;
  /** which capture group holds the secret value; 0 = whole match */
  group: number;
}

const PLACEHOLDER = /^(<|\$|\{|your[-_ ]|xxx|\.\.\.|\*\*\*|redacted|example|changeme|placeholder|none|null|true|false)/i;

const PATTERNS: Pattern[] = [
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g, group: 0 },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, group: 0 },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, group: 0 },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, group: 0 },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, group: 0 },
  { kind: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, group: 0 },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, group: 0 },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, group: 0 },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0 },
  { kind: "bearer", re: /\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/g, group: 1 },
  {
    kind: "credential-assignment",
    re: /\b((?:client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key|password|passwd|auth[_-]?token)\s*[:=]\s*["'`]?)([^\s"'`,;]{8,})/gi,
    group: 2,
  },
  { kind: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s@/]{4,})@/gi, group: 1 },
];

export class Policy {
  constructor(private readonly cfg: ResolvedConfig) {}

  isDenied(id: string): boolean {
    return this.cfg.denyPaths.some((g) => minimatch(id, g, { nocase: true, dot: true }));
  }

  isPrivate(note: NoteLike): boolean {
    if (note.visibility === "private") return true;
    if (note.project && this.cfg.privateProjects.some((p) => p.toLowerCase() === note.project!.toLowerCase())) return true;
    return this.cfg.privatePaths.some((g) => minimatch(note.id, g, { nocase: true, dot: true }));
  }

  canRead(note: NoteLike, p: Principal): boolean {
    if (!p.scopes.has(SCOPE_READ)) return false;
    if (this.isDenied(note.id)) return false;
    if (this.isPrivate(note) && !p.scopes.has(SCOPE_PRIVATE)) return false;
    return true;
  }

  canWrite(p: Principal): boolean {
    return p.scopes.has(SCOPE_WRITE);
  }

  /** Mask credential-shaped strings before they leave the server. */
  redact(text: string): { text: string; count: number; kinds: string[] } {
    let count = 0;
    const kinds = new Set<string>();
    let out = text;
    for (const pat of PATTERNS) {
      out = out.replace(pat.re, (...m: unknown[]) => {
        const whole = m[0] as string;
        const value = pat.group === 0 ? whole : (m[pat.group] as string);
        if (!value || PLACEHOLDER.test(value)) return whole;
        count++;
        kinds.add(pat.kind);
        const mask = `[REDACTED:${pat.kind}]`;
        return pat.group === 0 ? mask : whole.replace(value, mask);
      });
    }
    return { text: out, count, kinds: [...kinds] };
  }
}
