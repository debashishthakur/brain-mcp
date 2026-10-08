#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ROOT_DIR } from "./config.js";
import { VaultIndex } from "./vault/index.js";
import { Policy } from "./policy.js";
import { Audit } from "./audit.js";
import { createBrainServer, fullPrincipal } from "./tools.js";
import { startHttp, grantsFromEnv } from "./http.js";
import { startRemote } from "./remote.js";
import { AuthStore } from "./auth/store.js";
import { runAdmin } from "./auth/admin.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const HELP = `debawho-brain-mcp: your Obsidian vault as live context for Claude and any MCP client

  init                point it at your notes and connect Claude Code (run this first)
  --stdio             serve over stdio, which is what MCP clients run (the default)
  --http              serve over HTTP on 127.0.0.1:3737, bearer token required
  --oauth             serve over HTTP with OAuth 2.1, for remote clients
  --reindex           rebuild the search index and exit; add --warm to also fetch the search models
  auth <command>      manage the OAuth owner and clients: init, status, clients, revoke-all, ...
  --gen-token         print a random token for BRAIN_MCP_TOKEN

  --config <file>     use this config instead of the default
  --version           print the version
`;

async function main(): Promise<void> {
  if (process.argv[2] === "init") {
    await import(pathToFileURL(path.join(ROOT_DIR, "scripts", "setup.mjs")).href);
    return;
  }
  if (has("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (has("--version")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")) as { version: string };
    process.stdout.write(pkg.version + "\n");
    return;
  }
  if (has("--gen-token")) {
    process.stdout.write(crypto.randomBytes(32).toString("hex") + "\n");
    return;
  }
  const cfg = loadConfig(arg("--config"));
  if (process.argv[2] === "auth") {
    await runAdmin(cfg, process.argv.slice(3));
    return;
  }
  const index = new VaultIndex(cfg);
  const policy = new Policy(cfg);
  const audit = new Audit(cfg.logDir);

  const shown = path.relative(cfg.rootDir, cfg.configPath);
  console.error(`[config] ${shown.startsWith("..") ? cfg.configPath : shown}, owner ${cfg.owner}`);
  const stats = index.fullReindex();
  console.error(`[index] ${stats.indexed} notes indexed, ${stats.removed} removed, ${stats.ms} ms (${cfg.vaultDir})`);
  if (has("--reindex")) {
    // `init` runs this so the first question from a client does not wait on a 300 MB download. The embed
    // runs here instead of in the background, so it finishes before the database closes.
    if (has("--warm") && index.dense) {
      console.error(`[dense] fetching the search models into ${cfg.modelsDir} (about 300 MB, only the first time)`);
      index.dense.stop();
      await index.dense.embedMissing();
      if (!index.dense.stats().loaded) process.exitCode = 1;
    }
    await index.close();
    return;
  }
  index.startWatcher();

  const shutdown = async () => {
    await index.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (has("--http") || has("--oauth")) {
    const mode = has("--oauth") ? "oauth" : cfg.auth.mode;
    const makeServer = () => createBrainServer({ cfg, index, policy, audit, defaultPrincipal: fullPrincipal("http", "anonymous") });
    const srv = mode === "oauth" ? startRemote(cfg, makeServer, new AuthStore(cfg.dataDir)) : startHttp(cfg, makeServer, grantsFromEnv());
    process.on("SIGINT", () => srv.close());
    return;
  }

  // default: stdio. The OS user running this process is the principal.
  const server = createBrainServer({ cfg, index, policy, audit, defaultPrincipal: fullPrincipal("stdio", `stdio:${process.env.USERNAME ?? process.env.USER ?? "local"}`) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[stdio] second-brain MCP ready");
}

main().catch((e) => {
  console.error(`[fatal] ${(e as Error).stack ?? e}`);
  process.exit(1);
});
