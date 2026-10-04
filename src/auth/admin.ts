import crypto from "node:crypto";
import readline from "node:readline";
import qrcode from "qrcode-terminal";
import { AuthStore } from "./store.js";
import { hashPassword } from "./password.js";
import { generateTotpSecret, otpauthUrl, totpCode } from "./totp.js";
import type { ResolvedConfig } from "../config.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${question} must be provided with a flag or environment variable when not running in a terminal`);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (buf: Buffer) => {
      const ch = buf.toString();
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode?.(false);
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(value);
      } else if (ch === "") {
        process.exit(130);
      } else if (ch === "" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const fmtTs = (t: number | null) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) : "—");

export async function runAdmin(cfg: ResolvedConfig, args: string[]): Promise<void> {
  const store = new AuthStore(cfg.dataDir);
  const cmd = args[0];
  const out = (s: string): void => {
    process.stdout.write(s + "\n");
  };

  switch (cmd) {
    case "init": {
      const force = args.includes("--force");
      if (store.getSetting("password_hash") && !force) {
        out("Login is already configured. Use `auth set-password`, `auth rotate-totp`, or `auth init --force` to start over.");
        return;
      }
      const password = flag(args, "--password") ?? process.env.BRAIN_ADMIN_PASSWORD ?? (await promptHidden("Choose a login password (min 12 chars): "));
      if (password.length < 12) throw new Error("password must be at least 12 characters");
      const secret = flag(args, "--totp-secret") ?? generateTotpSecret();
      const account = flag(args, "--account") ?? cfg.owner;
      const issuer = new URL(cfg.auth.publicUrl || "http://localhost").host || "second-brain";
      store.setSetting("password_hash", hashPassword(password));
      store.setSetting("totp_secret", secret);
      if (!store.getSetting("cookie_secret") || force) store.setSetting("cookie_secret", crypto.randomBytes(32).toString("base64url"));
      const url = otpauthUrl(secret, account, issuer);
      out("\nLogin configured. Add this to your authenticator app (Google Authenticator, Aegis, 1Password, ...):\n");
      if (!args.includes("--no-qr")) await new Promise<void>((r) => qrcode.generate(url, { small: true }, (q) => { out(q); r(); }));
      out(`Secret (manual entry): ${secret}`);
      out(`otpauth URL: ${url}`);
      out(`\nCurrent code, to check the app is in sync: ${totpCode(secret)}`);
      out("\nKeep the secret somewhere safe. Losing both the app and the secret means `auth init --force` on the host.");
      return;
    }
    case "set-password": {
      const password = flag(args, "--password") ?? process.env.BRAIN_ADMIN_PASSWORD ?? (await promptHidden("New login password (min 12 chars): "));
      if (password.length < 12) throw new Error("password must be at least 12 characters");
      store.setSetting("password_hash", hashPassword(password));
      out("Password updated.");
      return;
    }
    case "rotate-totp": {
      const secret = generateTotpSecret();
      store.setSetting("totp_secret", secret);
      const url = otpauthUrl(secret, flag(args, "--account") ?? cfg.owner, new URL(cfg.auth.publicUrl || "http://localhost").host || "second-brain");
      await new Promise<void>((r) => qrcode.generate(url, { small: true }, (q) => { out(q); r(); }));
      out(`Secret: ${secret}\notpauth URL: ${url}`);
      return;
    }
    case "status": {
      out(`login configured: ${!!store.getSetting("password_hash") && !!store.getSetting("totp_secret")}`);
      out(`public URL:       ${cfg.auth.publicUrl || "(not set)"}`);
      out(`mode:             ${cfg.auth.mode}`);
      out(`clients:          ${store.listClients().filter((c) => !c.revoked_at).length}`);
      out(`active grants:    ${store.listGrants().length}`);
      out(`recent failures:  ${store.recentFailures(cfg.auth.lockoutWindowSec)} in the last ${cfg.auth.lockoutWindowSec / 60} min`);
      return;
    }
    case "clients": {
      const rows = store.listClients();
      if (!rows.length) return out("No clients registered.");
      out("client_id                              name                       registered         grants  status");
      for (const c of rows) out(`${c.client_id.padEnd(38)} ${(c.client_name ?? "").slice(0, 26).padEnd(26)} ${fmtTs(c.created_at)}   ${String(c.tokens).padStart(4)}   ${c.revoked_at ? "revoked" : "active"}`);
      return;
    }
    case "grants": {
      const rows = store.listGrants();
      if (!rows.length) return out("No active grants.");
      out("client_id                              scopes                                    issued             last used          expires");
      for (const g of rows) out(`${g.client_id.padEnd(38)} ${g.scopes.padEnd(41)} ${fmtTs(g.created_at)}   ${fmtTs(g.last_used_at)}   ${fmtTs(g.expires_at)}`);
      return;
    }
    case "revoke-client": {
      const id = args[1];
      if (!id) throw new Error("usage: auth revoke-client <client_id>");
      const n = store.revokeClient(id);
      out(`Client ${id} revoked; ${n} token(s) invalidated. It must register and sign in again to reconnect.`);
      return;
    }
    case "revoke-all": {
      let n = 0;
      for (const c of store.listClients()) if (!c.revoked_at) n += store.revokeClient(c.client_id);
      out(`All clients revoked; ${n} token(s) invalidated.`);
      return;
    }
    default:
      out(
        [
          "brain-mcp auth <command>",
          "",
          "  init [--password <pw>] [--totp-secret <base32>] [--account <name>] [--force] [--no-qr]",
          "        set the login password and authenticator secret (prints a QR code)",
          "  set-password [--password <pw>]     change the password",
          "  rotate-totp                        new authenticator secret",
          "  status                             configuration and counts",
          "  clients                            registered OAuth clients",
          "  grants                             active refresh-token grants",
          "  revoke-client <client_id>          cut one client off",
          "  revoke-all                         cut every client off",
          "",
          "BRAIN_ADMIN_PASSWORD can replace --password in scripts.",
        ].join("\n"),
      );
  }
}
