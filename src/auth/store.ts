import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

// All secrets at rest are hashed. Access and refresh tokens are opaque random strings;
// the database holds only their SHA-256, so a copied database cannot be replayed.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  info TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- access | refresh
  client_id TEXT NOT NULL,
  family TEXT NOT NULL,            -- one grant = one family; rotation stays inside it
  scopes TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_client ON tokens(client_id);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_at ON login_attempts(at);
`;

export interface TokenRow {
  token_hash: string;
  kind: "access" | "refresh";
  client_id: string;
  family: string;
  scopes: string;
  resource: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
  used_at: number | null;
}

export const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const now = () => Math.floor(Date.now() / 1000);

export class AuthStore {
  readonly db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, "auth.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------ settings
  getSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ------------------------------------------------------------ clients
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT info, revoked_at FROM clients WHERE client_id = ?").get(clientId) as { info: string; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at) return undefined;
    return JSON.parse(row.info) as OAuthClientInformationFull;
  }
  saveClient(info: OAuthClientInformationFull): void {
    this.db.prepare("INSERT INTO clients (client_id, info, created_at) VALUES (?,?,?)").run(info.client_id, JSON.stringify(info), now());
  }
  listClients(): { client_id: string; client_name: string | undefined; created_at: number; revoked_at: number | null; tokens: number }[] {
    return this.db
      .prepare(
        `SELECT c.client_id, c.info, c.created_at, c.revoked_at,
                (SELECT COUNT(*) FROM tokens t WHERE t.client_id = c.client_id AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > ?) AS tokens
         FROM clients c ORDER BY c.created_at DESC`,
      )
      .all(now())
      .map((r: unknown) => {
        const row = r as { client_id: string; info: string; created_at: number; revoked_at: number | null; tokens: number };
        return { client_id: row.client_id, client_name: (JSON.parse(row.info) as OAuthClientInformationFull).client_name, created_at: row.created_at, revoked_at: row.revoked_at, tokens: row.tokens };
      });
  }
  revokeClient(clientId: string): number {
    const t = now();
    this.db.prepare("UPDATE clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").run(t, clientId);
    return this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").run(t, clientId).changes;
  }

  // ------------------------------------------------------------ auth codes
  saveCode(code: string, row: Omit<AuthCodeRow, "code_hash" | "used_at">): void {
    this.db
      .prepare("INSERT INTO auth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(hash(code), row.client_id, row.redirect_uri, row.code_challenge, row.scopes, row.resource, row.expires_at);
  }
  getCode(code: string): AuthCodeRow | undefined {
    return this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(hash(code)) as AuthCodeRow | undefined;
  }
  /** Marks a code used. Returns false if it was already used (replay). */
  consumeCode(code: string): boolean {
    return this.db.prepare("UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now(), hash(code)).changes === 1;
  }

  // ------------------------------------------------------------ tokens
  saveToken(token: string, row: Omit<TokenRow, "token_hash" | "revoked_at" | "last_used_at">): void {
    this.db
      .prepare("INSERT INTO tokens (token_hash, kind, client_id, family, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(hash(token), row.kind, row.client_id, row.family, row.scopes, row.resource, row.created_at, row.expires_at);
  }
  getToken(token: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(hash(token)) as TokenRow | undefined;
  }
  touchToken(token: string): void {
    this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").run(now(), hash(token));
  }
  revokeToken(token: string): void {
    this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now(), hash(token));
  }
  revokeFamily(family: string): number {
    return this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").run(now(), family).changes;
  }
  listGrants(): { client_id: string; family: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null }[] {
    return this.db
      .prepare("SELECT client_id, family, scopes, created_at, expires_at, last_used_at FROM tokens WHERE kind = 'refresh' AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
      .all(now()) as { client_id: string; family: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null }[];
  }
  purgeExpired(): void {
    const t = now();
    this.db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(t - 3600);
    this.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(t - 86400 * 7);
    this.db.prepare("DELETE FROM login_attempts WHERE at < ?").run(Date.now() - 86400_000 * 30);
  }

  // ------------------------------------------------------------ login attempts
  // login_attempts.at is in milliseconds so bursts inside one second are ordered correctly.
  recordLogin(ip: string, ok: boolean): void {
    this.db.prepare("INSERT INTO login_attempts (ip, at, ok) VALUES (?,?,?)").run(ip, Date.now(), ok ? 1 : 0);
  }
  /** Failed attempts (from any IP) since the last success within the window. Lockout is global: there is one user. */
  recentFailures(windowSec: number): number {
    const since = Date.now() - windowSec * 1000;
    const lastOk = (this.db.prepare("SELECT MAX(at) m FROM login_attempts WHERE ok = 1").get() as { m: number | null }).m ?? 0;
    return (this.db.prepare("SELECT COUNT(*) c FROM login_attempts WHERE ok = 0 AND at > ? AND at > ?").get(since, lastOk) as { c: number }).c;
  }
}
