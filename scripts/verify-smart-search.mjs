// Verifies the smart-search add-on as a new user gets it: installs the packed package in the OS temp
// folder, runs `init` with smart search on, and checks that the add-on holds only this machine's ONNX
// runtime (no CUDA on Linux, no browser runtime), that the server ranks with it, and that
// `smart-search remove` goes back to keyword search.
// Needs a build first (npm run build). Fetches the models (about 300 MB) unless SMART_SEARCH_MODELS names a
// models folder to copy from (CI caches data/models). A copy, because `smart-search remove` deletes the models.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "brain-smart-"));
const HOME = path.join(TMP, "home");
const WIN = process.platform === "win32";
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failed++;
};
const npm = (args, cwd) => spawnSync(WIN ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: WIN });
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);
const sizeMB = (dir) => Math.round(files(dir).reduce((n, f) => n + (fs.statSync(path.join(dir, f)).isFile() ? fs.statSync(path.join(dir, f)).size : 0), 0) / 1e6);
const env = { ...process.env, BRAIN_MCP_HOME: HOME };
for (const k of ["BRAIN_MCP_CONFIG", "BRAIN_MCP_DATA_DIR", "BRAIN_MCP_LOG_DIR", "BRAIN_MCP_HYBRID"]) delete env[k];
const cachedModels = process.env.SMART_SEARCH_MODELS ? path.resolve(process.env.SMART_SEARCH_MODELS) : null;
if (cachedModels && fs.existsSync(cachedModels)) fs.cpSync(cachedModels, path.join(HOME, "data", "models"), { recursive: true });

async function contextHeader(entry) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--stdio"], cwd: TMP, env, stderr: "pipe" });
  const client = new Client({ name: "verify-smart-search", version: "0.0.1" });
  await client.connect(transport);
  const res = await client.callTool({ name: "brain_context", arguments: { question: "where do my notes go?" } });
  await client.close();
  return res.content.map((c) => c.text).join("\n");
}

try {
  // 1. The package as npx gets it
  const packed = npm(["pack", "--pack-destination", TMP, "--silent"], ROOT);
  const tarball = path.join(TMP, packed.stdout.trim().split(/\r?\n/).pop() ?? "");
  const app = path.join(TMP, "app");
  fs.mkdirSync(app);
  const installed = npm(["install", tarball, "--omit=dev", "--no-audit", "--no-fund"], app);
  check("npm install of the tarball", packed.status === 0 && installed.status === 0, installed.stderr.slice(-500));
  const entry = path.join(app, "node_modules", PKG.name, "dist", "index.js");
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: TMP, encoding: "utf8", env });

  // 2. init with smart search, the default answer
  const vault = path.join(TMP, "vault");
  const init = run("init", "--yes", "--name", "Ada Example", "--vault", vault);
  check("init with smart search exits cleanly", init.status === 0, (init.stderr || init.stdout).slice(-800));
  check("init installs the add-on and reports smart search", init.stdout.includes("Smart search installed") && init.stdout.includes("Search    smart"), init.stdout.slice(-800));
  const cfgPath = path.join(HOME, "config.json");
  check("the config keeps hybrid ranking on", JSON.parse(fs.readFileSync(cfgPath, "utf8")).retrieval?.hybrid !== false);

  // 3. The add-on holds what Node loads on this machine, and nothing else
  const addon = path.join(HOME, "smart-search", "node_modules");
  check("transformers.js is in the add-on", fs.existsSync(path.join(addon, "@huggingface", "transformers", "package.json")));
  const napi = path.join(addon, "onnxruntime-node", "bin", "napi-v6");
  const runtimes = fs.existsSync(napi) ? fs.readdirSync(napi).flatMap((p) => fs.readdirSync(path.join(napi, p)).map((a) => `${p}/${a}`)) : [];
  check(`only this machine's ONNX runtime is kept (${runtimes.join(", ")})`, runtimes.length === 1 && runtimes[0] === `${process.platform}/${process.arch}`, runtimes.join(", "));
  check("no browser runtime", !fs.existsSync(path.join(addon, "onnxruntime-web")));
  const gpu = files(addon).filter((f) => /providers_(cuda|tensorrt)/i.test(f));
  check("no CUDA or TensorRT libraries", !gpu.length, gpu.slice(0, 3).join(", "));
  const addonMB = sizeMB(path.join(HOME, "smart-search"));
  check(`the add-on is a reasonable size (${addonMB} MB)`, addonMB < 300, `${addonMB} MB`);

  // 4. The server ranks with it
  const hybrid = await contextHeader(entry);
  check("brain_context ranks with the models", hybrid.includes("hybrid retrieval") && hybrid.includes("Notes/Welcome.md"), hybrid.slice(0, 300));

  // 5. remove goes back to keyword search
  const removed = run("smart-search", "remove");
  check("smart-search remove exits cleanly", removed.status === 0 && removed.stdout.includes("removed"), (removed.stderr || removed.stdout).slice(-400));
  check("the add-on folder is gone", !fs.existsSync(path.join(HOME, "smart-search")));
  check("the config is back to keyword search", JSON.parse(fs.readFileSync(cfgPath, "utf8")).retrieval?.hybrid === false);
  const keyword = await contextHeader(entry);
  check("brain_context still answers, by keywords", !keyword.includes("hybrid retrieval") && keyword.includes("Notes/Welcome.md"), keyword.slice(0, 300));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll smart-search checks passed");
process.exit(failed ? 1 : 0);
