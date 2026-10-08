// Verifies the npm package as a stranger gets it: packs this repo, installs the tarball into the OS temp
// folder, runs `init` and serves the new vault over stdio. Everything the user owns must land in
// BRAIN_MCP_HOME and nothing in the installed package folder, which npx can wipe at any time.
// Needs a build first (npm run build). This is the default install, keyword search only; the smart-search
// add-on is covered by verify-smart-search.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "brain-package-"));
const HOME = path.join(TMP, "home");
const WIN = process.platform === "win32";
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
};
const npm = (args, cwd) => spawnSync(WIN ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: WIN });
const sizeMB = (dir) => Math.round(fs.readdirSync(dir, { recursive: true }).reduce((n, f) => n + (fs.statSync(path.join(dir, f)).isFile() ? fs.statSync(path.join(dir, f)).size : 0), 0) / 1e6);
// The user's environment, minus anything that would point the server back at this repo.
const env = { ...process.env, BRAIN_MCP_HOME: HOME };
for (const k of ["BRAIN_MCP_CONFIG", "BRAIN_MCP_DATA_DIR", "BRAIN_MCP_LOG_DIR", "BRAIN_MCP_HYBRID"]) delete env[k];

try {
  // 1. Pack and install
  const packed = npm(["pack", "--pack-destination", TMP, "--silent"], ROOT);
  const tarball = path.join(TMP, packed.stdout.trim().split(/\r?\n/).pop() ?? "");
  check("npm pack", packed.status === 0 && fs.existsSync(tarball), packed.stderr);
  const app = path.join(TMP, "app");
  fs.mkdirSync(app);
  const installed = npm(["install", tarball, "--omit=dev", "--no-audit", "--no-fund"], app);
  check("npm install of the tarball", installed.status === 0, installed.stderr.slice(-500));
  const pkgDir = path.join(app, "node_modules", PKG.name);
  const entry = path.join(pkgDir, "dist", "index.js");
  const shipped = ["dist/index.js", "scripts/setup.mjs", "templates/starter-vault", "example-vault", "brain.config.json"];
  check("the package ships what init and the server need", shipped.every((f) => fs.existsSync(path.join(pkgDir, f))), shipped.filter((f) => !fs.existsSync(path.join(pkgDir, f))).join(", "));
  const leaked = ["src", "data", "logs", "my-vault", "brain.config.local.json", ".github"].filter((f) => fs.existsSync(path.join(pkgDir, f)));
  check("the package ships nothing private or dev-only", !leaked.length, leaked.join(", "));

  const run = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: TMP, encoding: "utf8", env });
  check("--version", run("--version").stdout.trim() === PKG.version);
  const sqlite = spawnSync(process.execPath, ["-e", "const D=require('better-sqlite3');new D(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')"], { cwd: app, encoding: "utf8" });
  check("SQLite with FTS5 loads on this OS", sqlite.status === 0, sqlite.stderr.slice(-300));
  // Smart search is an add-on (verify-smart-search.mjs), so none of its libraries come with the package.
  const nodeModules = path.join(app, "node_modules");
  const heavy = ["@huggingface/transformers", "onnxruntime-node", "onnxruntime-web", "onnxruntime-common", "sharp"].filter((p) => fs.existsSync(path.join(nodeModules, p)));
  check("the package leaves the smart-search libraries out", !heavy.length, heavy.join(", "));
  const installMB = sizeMB(nodeModules);
  check(`the install is small (${installMB} MB)`, installMB < 100, `${installMB} MB`);

  // 2. init, as `npx debawho-brain-mcp init --yes --no-smart-search` runs it
  const vault = path.join(TMP, "vault");
  const init = run("init", "--yes", "--no-smart-search", "--name", "Ada Example", "--vault", vault);
  check("init exits cleanly", init.status === 0, init.stderr);
  check("init writes the config to BRAIN_MCP_HOME", fs.existsSync(path.join(HOME, "config.json")));
  check("init creates the starter vault", fs.existsSync(path.join(vault, "Notes", "About Ada Example.md")));
  check("init prints the npx connect command", init.stdout.includes(`npx -y ${PKG.name} --stdio`), init.stdout.slice(-400));
  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8"));
  check("declining smart search sets keyword-only search", cfg.retrieval?.hybrid === false && init.stdout.includes("keywords only"), JSON.stringify(cfg.retrieval));

  // 3. The installed server finds that config on its own and serves Ada's vault
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--stdio"], cwd: TMP, env, stderr: "pipe" });
  let serverLog = "";
  transport.stderr?.on("data", (d) => (serverLog += d));
  const client = new Client({ name: "verify-package", version: "0.0.1" });
  await client.connect(transport);
  check("the server reports the package version", client.getServerVersion()?.version === PKG.version, client.getServerVersion()?.version);
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");
  const identity = await call("brain_identity");
  check("the server serves the init config", identity.includes("# Identity bundle · Ada Example"), identity.slice(0, 200));
  const remembered = await call("brain_remember", { fact: "Ada keeps her notes in plain markdown so any tool can read them.", category: "user" });
  check("brain_remember writes into the user's vault", fs.readFileSync(path.join(vault, "Captures", "Memory.md"), "utf8").includes("plain markdown"), remembered);
  const context = await call("brain_context", { question: "where do my notes go?" });
  check("brain_context answers from the user's vault", context.includes("Notes/Welcome.md"), context.slice(0, 200));
  await client.close();
  check("a keyword-only server never tries to load models", !serverLog.includes("[dense]"), serverLog.split("\n").find((l) => l.includes("[dense]")));

  // 4. State lives in BRAIN_MCP_HOME, not in the package folder
  check("the index lives in BRAIN_MCP_HOME", fs.existsSync(path.join(HOME, "data", "local", "index.db")));
  check("the audit log lives in BRAIN_MCP_HOME", fs.existsSync(path.join(HOME, "logs", "audit.jsonl")));
  check("nothing is written into the package folder", !["data", "logs", "brain.config.local.json"].some((f) => fs.existsSync(path.join(pkgDir, f))));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll package checks passed");
process.exit(failed ? 1 : 0);
