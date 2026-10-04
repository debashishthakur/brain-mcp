#!/usr/bin/env node
import crypto from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
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

async function main(): Promise<void> {
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

  const stats = index.fullReindex();
  console.error(`[index] ${stats.indexed} notes indexed, ${stats.removed} removed, ${stats.ms} ms (${cfg.vaultDir})`);
  if (has("--reindex")) {
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
