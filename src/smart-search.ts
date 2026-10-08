// Smart search: transformers.js and the ONNX runtime that run the embedding and reranking models. An npm
// install of brain-mcp leaves them out (about 500 MB, and on Linux onnxruntime-node's install script adds
// CUDA libraries on top), so `npx debawho-brain-mcp` stays small and starts on keyword search.
// `smart-search` installs a pinned copy into ~/.brain-mcp/smart-search with install scripts off, keeps only
// this machine's ONNX runtime, and fetches the models. A clone has transformers.js as a dev dependency.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, SMART_SEARCH_DIR, loadConfig, resolveConfigPath } from "./config.js";

/** The release the add-on installs; the same one the repository develops and tests against. */
export const SMART_SEARCH_PACKAGE = "@huggingface/transformers@4.3.1";

type Transformers = typeof import("@huggingface/transformers");

const addonPackageDir = () => path.join(SMART_SEARCH_DIR, "node_modules", "@huggingface", "transformers");

/** True when transformers.js resolves from brain-mcp's own dependencies (a clone, or the Docker image). */
function bundled(): boolean {
  try {
    import.meta.resolve("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

/** transformers.js from brain-mcp's own dependencies, else from the add-on. Throws when neither has it. */
export async function loadTransformers(): Promise<Transformers> {
  if (bundled()) return await import("@huggingface/transformers");
  const manifest = path.join(addonPackageDir(), "package.json");
  if (!fs.existsSync(manifest)) throw new Error('smart search is not installed; add it with "npx debawho-brain-mcp smart-search"');
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { exports: { node: { import: { default: string } } } };
  return (await import(pathToFileURL(path.join(addonPackageDir(), pkg.exports.node.import.default)).href)) as Transformers;
}

/** Runs npm through this node binary when npm's CLI sits beside it, so no shell is involved (paths may contain spaces). */
function npm(args: string[]) {
  const dir = path.dirname(process.execPath);
  const cli = [
    process.env.npm_execpath,
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((p): p is string => !!p && p.endsWith("npm-cli.js") && fs.existsSync(p));
  if (cli) return spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
  const win = process.platform === "win32";
  return spawnSync(win ? "npm.cmd" : "npm", win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { stdio: "inherit", shell: win });
}

/** Drop what Node never loads: other platforms' ONNX runtimes, the browser runtime and source maps. */
function prune(nodeModules: string): void {
  const napi = path.join(nodeModules, "onnxruntime-node", "bin", "napi-v6");
  if (fs.existsSync(napi)) {
    for (const os of fs.readdirSync(napi)) {
      const osDir = path.join(napi, os);
      if (os !== process.platform) {
        fs.rmSync(osDir, { recursive: true, force: true });
        continue;
      }
      for (const arch of fs.readdirSync(osDir)) if (arch !== process.arch) fs.rmSync(path.join(osDir, arch), { recursive: true, force: true });
    }
  }
  fs.rmSync(path.join(nodeModules, "onnxruntime-web"), { recursive: true, force: true });
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".map")) fs.rmSync(p);
    }
  };
  walk(nodeModules);
}

function sizeMB(dir: string): number {
  let bytes = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return Math.round(bytes / 1e6);
}

/** Turns hybrid ranking on or off in the user's config. The shipped example config is never edited. */
function setHybrid(configPath: string, on: boolean): void {
  if (configPath === DEFAULT_CONFIG || !fs.existsSync(configPath)) return;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as { retrieval?: Record<string, unknown> };
  if (on) {
    if (raw.retrieval?.hybrid !== false) return;
    delete raw.retrieval.hybrid;
    if (!Object.keys(raw.retrieval).length) delete raw.retrieval;
  } else {
    raw.retrieval = { ...raw.retrieval, hybrid: false };
  }
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
}

const opt = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * `smart-search [--config <file>] [--no-models]` installs the add-on and fetches the models.
 * `smart-search remove [--config <file>]` deletes the add-on and the models, back to keyword search.
 * Returns the process exit code.
 */
export async function runSmartSearch(args: string[], entry: string): Promise<number> {
  const configArg = opt(args, "--config");
  const configPath = resolveConfigPath(configArg);

  if (args[0] === "remove") {
    let modelsDir: string | null = null;
    try {
      modelsDir = loadConfig(configArg).modelsDir;
    } catch {}
    const freed = sizeMB(SMART_SEARCH_DIR) + (modelsDir ? sizeMB(modelsDir) : 0);
    fs.rmSync(SMART_SEARCH_DIR, { recursive: true, force: true });
    if (modelsDir) fs.rmSync(modelsDir, { recursive: true, force: true });
    setHybrid(configPath, false);
    console.log(`Smart search removed (${freed} MB freed). brain-mcp now uses keyword search.`);
    return 0;
  }

  if (bundled()) {
    console.log("Smart search is already part of this install: transformers.js is one of its dependencies.");
    return 0;
  }

  console.log(`\nInstalling smart search into ${SMART_SEARCH_DIR}: ${SMART_SEARCH_PACKAGE} with the ONNX runtime for ${process.platform}-${process.arch}.\n`);
  fs.mkdirSync(SMART_SEARCH_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SMART_SEARCH_DIR, "package.json"),
    JSON.stringify({ name: "brain-mcp-smart-search", private: true, description: "Local models for brain-mcp's hybrid search. Remove with: npx debawho-brain-mcp smart-search remove" }, null, 2) + "\n",
  );
  // Install scripts stay off: onnxruntime-node's would download CUDA libraries on Linux, and nothing here needs a build.
  const installed = npm(["install", SMART_SEARCH_PACKAGE, "--prefix", SMART_SEARCH_DIR, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"]);
  if (installed.status !== 0) {
    console.error("\nnpm could not install smart search, so brain-mcp keeps using keyword search. Run this command again to retry.");
    return 1;
  }
  prune(path.join(SMART_SEARCH_DIR, "node_modules"));
  try {
    await loadTransformers();
  } catch (e) {
    console.error(`\nSmart search was installed but does not load: ${(e as Error).message}`);
    return 1;
  }
  console.log(`Smart search installed (${sizeMB(SMART_SEARCH_DIR)} MB).`);
  setHybrid(configPath, true);
  if (args.includes("--no-models")) return 0;

  // One retry: a dropped connection is the usual failure, and files that finished downloading are kept.
  console.log("\nIndexing your notes and fetching the search models (about 300 MB, only the first time)...\n");
  const warm = () => spawnSync(process.execPath, [entry, "--reindex", "--warm", ...(configArg ? ["--config", configArg] : [])], { stdio: ["ignore", "inherit", "inherit"] }).status === 0;
  let ok = warm();
  if (!ok) {
    console.log("\nRetrying once...\n");
    ok = warm();
  }
  if (!ok) console.log('\nThe models could not be fetched now. Search works by keyword until they are; run "npx debawho-brain-mcp smart-search" again to retry.');
  return 0;
}
