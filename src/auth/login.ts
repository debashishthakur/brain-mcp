import crypto from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { BrainOAuthProvider, PendingAuth } from "./provider.js";
import { AuthStore, now } from "./store.js";
import { verifyPassword } from "./password.js";
import { verifyTotp } from "./totp.js";
import type { ResolvedConfig } from "../config.js";
import { ALL_SCOPES } from "../policy.js";

const COOKIE = "brain_auth";
const SESSION_TTL_SEC = 600;

const SCOPE_LABELS: Record<string, string> = {
  "brain:read": "Read notes, search, project briefings",
  "brain:write": "Save notes and remember facts",
  "brain:private": "Read notes marked private",
};

// ------------------------------------------------------------ HTML
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark;
    --bg: #f6f5f2; --panel: #ffffff; --ink: #1c1b18; --muted: #6b675f; --line: #d9d6cf; --accent: #2f5d50; --accent-ink: #ffffff; --danger: #a33a2a; --focus: #2f5d50; }
  @media (prefers-color-scheme: dark) { :root {
    --bg: #14130f; --panel: #1e1d18; --ink: #ece9e1; --muted: #a49f93; --line: #33312a; --accent: #7fb7a3; --accent-ink: #10201a; --danger: #e08a7a; --focus: #7fb7a3; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
  main { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  p { margin: 0 0 16px; color: var(--muted); }
  p.client { color: var(--ink); }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input[type=password], input[type=text] { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .row { display: flex; gap: 10px; margin-top: 22px; }
  button { font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; flex: 1; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .error { color: var(--danger); font-weight: 600; margin: 12px 0 0; }
  ul.scopes { list-style: none; padding: 0; margin: 8px 0 0; }
  ul.scopes li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--line); }
  ul.scopes li:first-child { border-top: 0; }
  ul.scopes input { margin-top: 5px; }
  ul.scopes span { color: var(--muted); display: block; font-size: 0.925rem; }
  code { font-size: 0.925em; }
  footer { margin-top: 20px; font-size: 0.85rem; color: var(--muted); }
</style>
</head>
<body><main>${body}</main></body></html>`;
}

function loginForm(p: PendingAuth, error?: string): string {
  const client = p.client.client_name ?? p.client.client_id;
  return page(
    "Sign in · second brain",
    `<h1>Sign in to your second brain</h1>
<p class="client"><strong>${esc(client)}</strong> wants to connect.</p>
<p>Your password and the 6-digit code from your authenticator app.</p>
<form method="post" action="/login" autocomplete="on">
  <input type="hidden" name="req" value="${esc(p.id)}">
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
  <label for="code">Authenticator code</label>
  <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="7" required>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <div class="row"><button class="primary" type="submit">Continue</button></div>
</form>
<footer>Every connection requires this sign-in. Nothing is remembered in the browser.</footer>`,
  );
}

function consentForm(p: PendingAuth): string {
  const client = p.client.client_name ?? p.client.client_id;
  const host = new URL(p.params.redirectUri).host;
  const scopes = p.params.scopes ?? [];
  const items = ALL_SCOPES.map(
    (s) =>
      `<li><input type="checkbox" id="s-${esc(s)}" name="scope" value="${esc(s)}" ${scopes.includes(s) ? "checked" : ""}>
       <label for="s-${esc(s)}" style="margin:0;font-weight:600">${esc(s)}<span>${esc(SCOPE_LABELS[s] ?? "")}</span></label></li>`,
  ).join("");
  return page(
    "Allow access · second brain",
    `<h1>Allow ${esc(client)}?</h1>
<p>It will be sent back to <code>${esc(host)}</code> with its own token, which you can revoke later with <code>brain-mcp auth revoke-client</code>.</p>
<form method="post" action="/consent">
  <input type="hidden" name="req" value="${esc(p.id)}">
  <ul class="scopes">${items}</ul>
  <div class="row">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button class="primary" type="submit" name="decision" value="allow">Allow</button>
  </div>
</form>`,
  );
}

const message = (title: string, text: string) => page(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);

// ------------------------------------------------------------ signed session cookie
function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}
function makeSession(secret: string, reqId: string): string {
  const payload = Buffer.from(JSON.stringify({ req: reqId, exp: now() + SESSION_TTL_SEC })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}
function readSession(secret: string, cookie: string | undefined): { req: string } | null {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const expected = sign(secret, payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { req: string; exp: number };
    return data.exp > now() ? { req: data.req } : null;
  } catch {
    return null;
  }
}
function getCookie(req: Request): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

// ------------------------------------------------------------ routes
export function createLoginRouter(cfg: ResolvedConfig, store: AuthStore, provider: BrainOAuthProvider): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "8kb" }));
  const secure = cfg.auth.publicUrl.startsWith("https://");
  const cookieSecret = () => store.getSetting("cookie_secret") ?? "";
  const configured = () => !!store.getSetting("password_hash") && !!store.getSetting("totp_secret") && !!cookieSecret();

  const noStore = (res: Response) => res.setHeader("Cache-Control", "no-store");

  router.get("/login", (req, res) => {
    noStore(res);
    if (!configured()) return void res.status(503).send(message("Not set up", "The server has no login configured. Run `brain-mcp auth init` on the host first."));
    const p = provider.takePending(String(req.query.req ?? ""));
    if (!p) return void res.status(400).send(message("Request expired", "Start the connection again from your client."));
    res.type("html").send(loginForm(p));
  });

  router.post("/login", (req, res) => {
    noStore(res);
    if (!configured()) return void res.status(503).send(message("Not set up", "The server has no login configured."));
    const p = provider.takePending(String(req.body?.req ?? ""));
    if (!p) return void res.status(400).send(message("Request expired", "Start the connection again from your client."));

    const failures = store.recentFailures(cfg.auth.lockoutWindowSec);
    if (failures >= cfg.auth.lockoutAfterFailures) {
      console.error(`[auth] login locked out (${failures} failures) from ${req.ip}`);
      return void res.status(429).send(message("Too many attempts", `Sign-in is paused for ${Math.ceil(cfg.auth.lockoutWindowSec / 60)} minutes.`));
    }
    const pw = String(req.body?.password ?? "");
    const code = String(req.body?.code ?? "");
    // Evaluate both factors every time so a wrong password does not return faster than a wrong code.
    const pwOk = verifyPassword(pw, store.getSetting("password_hash")!);
    const codeOk = verifyTotp(store.getSetting("totp_secret")!, code);
    if (!(pwOk && codeOk)) {
      store.recordLogin(req.ip ?? "?", false);
      console.error(`[auth] failed login from ${req.ip} for client ${p.client.client_id}`);
      return void res.status(401).type("html").send(loginForm(p, "That password and code did not match."));
    }
    store.recordLogin(req.ip ?? "?", true);
    res.setHeader("Set-Cookie", `${COOKIE}=${makeSession(cookieSecret(), p.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure ? "; Secure" : ""}`);
    res.type("html").send(consentForm(p));
  });

  router.post("/consent", (req, res) => {
    noStore(res);
    const reqId = String(req.body?.req ?? "");
    const session = readSession(cookieSecret(), getCookie(req));
    const p = provider.takePending(reqId);
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
    if (!p || !session || session.req !== reqId) return void res.status(400).send(message("Request expired", "Sign in again from your client."));
    provider.finishPending(reqId);

    const target = new URL(p.params.redirectUri);
    if (p.params.state) target.searchParams.set("state", p.params.state);
    if (req.body?.decision !== "allow") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "The owner declined.");
      console.error(`[auth] consent denied for client ${p.client.client_id}`);
      return void res.redirect(302, target.href);
    }
    const chosenRaw = req.body?.scope;
    const chosen = (Array.isArray(chosenRaw) ? chosenRaw : chosenRaw ? [chosenRaw] : []).map(String).filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
    const scopes = chosen.length ? chosen : ["brain:read"];
    const code = provider.issueCode(p, scopes);
    target.searchParams.set("code", code);
    console.error(`[auth] consent granted to client ${p.client.client_id} (${p.client.client_name ?? "unnamed"}) scopes=${scopes.join(",")}`);
    res.redirect(302, target.href);
  });

  return router;
}
