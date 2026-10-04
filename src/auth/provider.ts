import crypto from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { AuthStore, now } from "./store.js";
import type { ResolvedConfig } from "../config.js";
import { ALL_SCOPES } from "../policy.js";

export interface PendingAuth {
  id: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PENDING_TTL_SEC = 600;
const CODE_TTL_SEC = 300;

const randomToken = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;

/**
 * Authorization server logic. The SDK's router owns the endpoints and PKCE verification;
 * this class owns storage, the human login hand-off, token issuance and rotation.
 */
export class BrainOAuthProvider implements OAuthServerProvider {
  readonly pending = new Map<string, PendingAuth>();
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    readonly store: AuthStore,
    readonly cfg: ResolvedConfig,
  ) {
    this.clientsStore = {
      getClient: (id) => store.getClient(id),
      registerClient: (client) => {
        for (const uri of client.redirect_uris) {
          const u = new URL(uri);
          const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
          if (!ok) throw new InvalidClientMetadataError(`redirect_uri must be https or loopback: ${uri}`);
        }
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) full.client_id = crypto.randomUUID();
        if (!full.client_id_issued_at) full.client_id_issued_at = now();
        store.saveClient(full);
        console.error(`[oauth] registered client ${full.client_id} (${full.client_name ?? "unnamed"}) → ${full.redirect_uris.join(", ")}`);
        return full;
      },
    };
  }

  private scopesFor(requested: string[] | undefined): string[] {
    const supported = new Set<string>(ALL_SCOPES);
    const asked = (requested ?? []).filter((s) => supported.has(s));
    return asked.length ? asked : [...this.cfg.auth.defaultScopes];
  }

  // ------------------------------------------------------------ authorize → human login
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweepPending();
    const id = crypto.randomBytes(16).toString("base64url");
    this.pending.set(id, { id, client, params: { ...params, scopes: this.scopesFor(params.scopes) }, createdAt: now() });
    res.redirect(302, `/login?req=${encodeURIComponent(id)}`);
  }

  takePending(id: string): PendingAuth | undefined {
    this.sweepPending();
    const p = this.pending.get(id);
    return p;
  }

  finishPending(id: string): void {
    this.pending.delete(id);
  }

  private sweepPending(): void {
    const cutoff = now() - PENDING_TTL_SEC;
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
  }

  /** Called by the consent page after a successful login and an Allow click. */
  issueCode(p: PendingAuth, scopes: string[]): string {
    const code = randomToken("bmcp_ac");
    this.store.saveCode(code, {
      client_id: p.client.client_id,
      redirect_uri: p.params.redirectUri,
      code_challenge: p.params.codeChallenge,
      scopes: scopes.join(" "),
      resource: p.params.resource?.href ?? null,
      expires_at: now() + CODE_TTL_SEC,
    });
    return code;
  }

  // ------------------------------------------------------------ code exchange
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.store.getCode(code);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Unknown authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const row = this.store.getCode(code);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Unknown authorization code");
    if (row.expires_at < now()) throw new InvalidGrantError("Authorization code expired");
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
    if (row.resource && resource && resource.href !== row.resource) throw new InvalidGrantError("resource does not match");
    if (!this.store.consumeCode(code)) {
      // Replay of a used code: RFC 6749 §4.1.2 says revoke everything issued from it.
      throw new InvalidGrantError("Authorization code already used");
    }
    const family = crypto.randomUUID();
    return this.issueTokens(client.client_id, family, row.scopes.split(" "), row.resource);
  }

  // ------------------------------------------------------------ refresh (rotating)
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.store.getToken(refreshToken);
    if (!row || row.kind !== "refresh" || row.client_id !== client.client_id) throw new InvalidGrantError("Unknown refresh token");
    if (row.revoked_at) {
      // A revoked refresh token being presented again means it leaked or was replayed. Kill the whole family.
      const n = this.store.revokeFamily(row.family);
      console.error(`[oauth] refresh token reuse detected for client ${client.client_id}; revoked ${n} token(s) in family ${row.family}`);
      throw new InvalidGrantError("Refresh token reuse detected; grant revoked");
    }
    if (row.expires_at < now()) throw new InvalidGrantError("Refresh token expired");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource does not match");
    const granted = row.scopes.split(" ");
    let effective = granted;
    if (scopes?.length) {
      if (scopes.some((s) => !granted.includes(s))) throw new InvalidGrantError("Requested scope exceeds the original grant");
      effective = scopes;
    }
    this.store.revokeToken(refreshToken);
    return this.issueTokens(client.client_id, row.family, effective, row.resource);
  }

  private issueTokens(clientId: string, family: string, scopes: string[], resource: string | null): OAuthTokens {
    const t = now();
    const access = randomToken("bmcp_at");
    const refresh = randomToken("bmcp_rt");
    this.store.saveToken(access, { kind: "access", client_id: clientId, family, scopes: scopes.join(" "), resource, created_at: t, expires_at: t + this.cfg.auth.accessTokenTtlSec });
    this.store.saveToken(refresh, { kind: "refresh", client_id: clientId, family, scopes: scopes.join(" "), resource, created_at: t, expires_at: t + this.cfg.auth.refreshTokenTtlSec });
    return { access_token: access, token_type: "Bearer", expires_in: this.cfg.auth.accessTokenTtlSec, scope: scopes.join(" "), refresh_token: refresh };
  }

  // ------------------------------------------------------------ verification
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.store.getToken(token);
    if (!row || row.kind !== "access") throw new InvalidTokenError("Unknown token");
    if (row.revoked_at) throw new InvalidTokenError("Token revoked");
    if (row.expires_at < now()) throw new InvalidTokenError("Token expired");
    const client = this.store.getClient(row.client_id);
    if (!client) throw new InvalidTokenError("Client revoked");
    this.store.touchToken(token);
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(" "),
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { clientName: client.client_name ?? row.client_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.store.getToken(request.token);
    if (!row || row.client_id !== client.client_id) return;
    if (row.kind === "refresh") this.store.revokeFamily(row.family);
    else this.store.revokeToken(request.token);
  }
}
