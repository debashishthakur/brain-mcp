// Verifies `npm run setup` in the OS temp folder: a starter vault for a new owner that the server serves as
// theirs, an existing vault left untouched, the overwrite guard, and brain.config.local.json taking over from
// the example config when present (only checked when you have not run setup yourself, and removed after).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "brain-setup-"));
const SETUP = path.join(ROOT, "scripts", "setup.mjs");
const LOCAL = path.join(ROOT, "brain.config.local.json");
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
};
const setup = (...args) => spawnSync("node", [SETUP, "--yes", ...args], { encoding: "utf8" });
const snapshot = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : "/"].join("\n"))
    .join("\n--\n");
let wroteLocal = false;

try {
  // 1. A starter vault for a new owner
  const cfgPath = path.join(TMP, "brain.config.local.json");
  const vault = path.join(TMP, "vault");
  const r = setup("--name", "Ada Example", "--vault", vault, "--config", cfgPath);
  check("setup exits cleanly", r.status === 0, r.stderr);
  check("starter notes are created", fs.existsSync(path.join(vault, "Notes", "About Ada Example.md")) && fs.existsSync(path.join(vault, "Notes", "Welcome.md")));
  const about = fs.readFileSync(path.join(vault, "Notes", "About Ada Example.md"), "utf8");
  check("templates are filled in", !about.includes("{{") && about.includes('title: "About Ada Example"'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  check("config names the owner and profile", cfg.owner === "Ada Example" && cfg.identity.profileNote === "About Ada Example", JSON.stringify(cfg.identity));
  check("config keeps its own index", cfg.vaultPath === "./vault" && cfg.dataDir === "./data/local", `${cfg.vaultPath} ${cfg.dataDir}`);
  check("setup prints the connect command", r.stdout.includes("claude mcp add") && r.stdout.includes(`--config "${cfgPath}"`));

  // 2. The server serves it as Ada's brain
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(ROOT, "dist", "index.js"), "--stdio", "--config", cfgPath],
    stderr: "pipe",
    env: { ...process.env, BRAIN_MCP_HYBRID: "0", BRAIN_MCP_LOG_DIR: path.join(TMP, "logs") },
  });
  const client = new Client({ name: "verify-setup", version: "0.0.1" });
  await client.connect(transport);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");
  const identity = await call("brain_identity");
  check("identity is the new owner", identity.includes("# Identity bundle · Ada Example") && identity.includes("has not filled in this profile yet"), identity.slice(0, 200));
  check("the example owner is gone", !identity.includes("Ines"));
  const remembered = await call("brain_remember", { fact: "Ada prefers tea over coffee during long debugging sessions.", category: "user" });
  check("brain_remember writes into the new vault", remembered.startsWith("Remembered") && fs.readFileSync(path.join(vault, "Captures", "Memory.md"), "utf8").includes("tea over coffee"), remembered);
  const context = await call("brain_context", { question: "where do my notes go?" });
  check("brain_context finds the welcome note", context.includes("Notes/Welcome.md"), context.slice(0, 200));
  await client.close();
  check("the index lives beside the config", fs.existsSync(path.join(TMP, "data", "local", "index.db")));

  // 3. The overwrite guard
  const before = fs.readFileSync(cfgPath, "utf8");
  const again = setup("--name", "Someone Else", "--vault", vault, "--config", cfgPath);
  check("an existing config is not replaced without --force", again.status === 1 && fs.readFileSync(cfgPath, "utf8") === before, again.stderr);

  // 4. An existing vault is used as it is
  const mine = path.join(TMP, "existing");
  fs.mkdirSync(path.join(mine, "Journal"), { recursive: true });
  fs.writeFileSync(path.join(mine, "About me.md"), "# About me\n\nI build sailing robots.\n");
  fs.writeFileSync(path.join(mine, "Journal", "2026-01-02.md"), "# 2 January\n\nTested the rudder.\n");
  const untouched = snapshot(mine);
  const cfg2 = path.join(TMP, "existing.json");
  const r2 = setup("--name", "Ada Example", "--vault", mine, "--config", cfg2);
  const c2 = JSON.parse(fs.readFileSync(cfg2, "utf8"));
  check("an existing vault keeps its own profile note", r2.status === 0 && c2.identity.profileNote === "About me", c2.identity.profileNote);
  check("nothing is written into an existing vault", snapshot(mine) === untouched);

  // 5. brain.config.local.json takes over from the example config, and the checks stay pinned
  if (fs.existsSync(LOCAL)) {
    console.log("SKIP  local config discovery: you already have brain.config.local.json");
  } else {
    fs.writeFileSync(LOCAL, JSON.stringify({ ...cfg, vaultPath: vault, dataDir: path.join(TMP, "data", "local") }));
    wroteLocal = true;
    const { loadConfig } = await import("../dist/config.js");
    const saved = process.env.BRAIN_MCP_CONFIG;
    delete process.env.BRAIN_MCP_CONFIG;
    check("the server picks up brain.config.local.json", loadConfig().owner === "Ada Example");
    await import("./use-example-vault.mjs");
    check("checks still use the example vault", loadConfig().owner === "Ines Varga");
    if (saved === undefined) delete process.env.BRAIN_MCP_CONFIG;
    else process.env.BRAIN_MCP_CONFIG = saved;
  }
} finally {
  if (wroteLocal) fs.rmSync(LOCAL, { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll setup checks passed");
process.exit(failed ? 1 : 0);
