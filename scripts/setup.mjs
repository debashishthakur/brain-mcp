#!/usr/bin/env node
// `npm run setup` in a clone, `npx debawho-brain-mcp init` from npm: make brain-mcp yours. Asks for your
// name and where your notes live, then writes your config, which the server uses instead of the example
// vault. With no existing vault it creates a starter one from templates/starter-vault.
//
// A clone writes brain.config.local.json (kept out of git), so the example vault and every check keep
// working. An npm install writes ~/.brain-mcp/config.json, since npx can wipe its own folder at any time,
// fetches the search models once, and offers to connect Claude Code.
//
//   npm run setup
//   npm run setup -- --name "Ada Lovelace" --vault ~/Notes --yes
//   npx debawho-brain-mcp init
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "templates", "starter-vault");
const ENTRY = path.join(ROOT, "dist", "index.js");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
// Same rules as src/config.ts, which this script cannot import before the first build.
const INSTALLED = ROOT.split(path.sep).includes("node_modules");
const HOME_DIR = path.resolve(process.env.BRAIN_MCP_HOME ?? path.join(os.homedir(), ".brain-mcp"));
const DEFAULT_CONFIG = INSTALLED ? path.join(HOME_DIR, "config.json") : path.join(ROOT, "brain.config.local.json");
const STARTER = INSTALLED ? path.join(os.homedir(), "second-brain") : path.join(ROOT, "my-vault");
const USAGE = INSTALLED ? `npx ${PKG} init` : "npm run setup --";
const WIN = process.platform === "win32";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const home = os.homedir();
const shown = (p) =>
  p.startsWith(ROOT + path.sep) && !INSTALLED
    ? "./" + path.relative(ROOT, p).split(path.sep).join("/")
    : p.startsWith(home + path.sep)
      ? "~" + p.slice(home.length)
      : p;

if (flag("--help") || flag("-h")) {
  console.log(`Usage: ${USAGE} [options]

  --name <name>     your name (default: git config user.name)
  --vault <path>    your existing vault, or a new folder for a starter vault (default: ${shown(STARTER)})
  --config <file>   where to write the config (default: ${shown(DEFAULT_CONFIG)})
  --yes             ask nothing, take the defaults
  --force           replace an existing config${INSTALLED ? "\n  --no-models       skip fetching the search models now; the server fetches them on first use" : ""}`);
  process.exit(0);
}

const rl = !flag("--yes") && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, def = "") => (rl ? (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def : def);
// Without a terminal a yes/no question takes `fallback`, so nothing is replaced or written into a vault unasked.
const confirm = async (q, def, fallback = false) => {
  if (!rl) return fallback;
  const a = (await rl.question(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim();
  return a ? /^y(es)?$/i.test(a) : def;
};
const fail = (msg) => {
  rl?.close();
  console.error(`\n${msg}`);
  process.exit(1);
};

// The name becomes part of a file name and a quoted YAML string, so characters that break either are dropped.
const clean = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
const fromUser = (p) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p.replace(/^~(?=$|[\\/])/, home));
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time

function guessName() {
  let n = "";
  try {
    n = execFileSync("git", ["config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  if (!n) {
    try {
      n = os.userInfo().username;
    } catch {}
  }
  n = clean(n);
  // "ADA LOVELACE" reads better as "Ada Lovelace"
  return n && n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase()) : n;
}

/** Vaults the Obsidian app knows about, the open or most recently used first. */
function obsidianVaults() {
  const file =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "obsidian", "obsidian.json")
      : WIN
        ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian", "obsidian.json")
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "obsidian", "obsidian.json");
  try {
    const vaults = Object.values(JSON.parse(fs.readFileSync(file, "utf8")).vaults ?? {});
    return vaults
      .filter((v) => typeof v?.path === "string" && fs.existsSync(v.path))
      .sort((a, b) => Number(!!b.open) - Number(!!a.open) || (b.ts ?? 0) - (a.ts ?? 0))
      .map((v) => v.path);
  } catch {
    return [];
  }
}

function markdownFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(abs));
    else if (e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

/** Copy template notes into `dir`, filling in the name and date. Never overwrites a note that exists. */
function render(dir, name, only = () => true) {
  const created = [];
  for (const src of markdownFiles(TEMPLATE)) {
    const rel = path.relative(TEMPLATE, src);
    if (!only(rel)) continue;
    const target = path.join(dir, rel.replaceAll("{{name}}", name));
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(src, "utf8").replaceAll("{{name}}", name).replaceAll("{{date}}", today));
    created.push(target);
  }
  return created;
}

const quote = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
const hasClaude = () => spawnSync("claude", ["--version"], { stdio: "ignore", shell: WIN }).status === 0;

console.log(
  INSTALLED
    ? `\nbrain-mcp setup\n\nThis points brain-mcp at your own notes. Your settings go in ${shown(DEFAULT_CONFIG)}.\n`
    : "\nbrain-mcp setup\n\nThis points brain-mcp at your own notes. Your settings go in a config file that git ignores,\nso the example vault and every check keep working.\n",
);

const configPath = path.resolve(opt("--config") ? fromUser(opt("--config")) : DEFAULT_CONFIG);
if (fs.existsSync(configPath) && !flag("--force")) {
  let owner = "someone";
  try {
    owner = JSON.parse(fs.readFileSync(configPath, "utf8")).owner ?? owner;
  } catch {}
  if (!(await confirm(`${shown(configPath)} already exists (set up for ${owner}). Replace it?`, false)))
    fail(`Kept the existing ${shown(configPath)}. Run again with --force to replace it.`);
}

const name = clean(opt("--name") ?? (await ask("Your name", guessName())));
if (!name) fail(`A name is needed: ${USAGE} --name "Your Name"`);

// Only offered at a terminal: a vault full of real notes is never picked without someone saying so.
let answer = opt("--vault");
if (answer === undefined) {
  const found = rl ? obsidianVaults() : [];
  if (found.length) {
    console.log(`\nObsidian vaults on this machine:\n${found.map((v, i) => `  ${i + 1}. ${shown(v)}`).join("\n")}\n`);
    const pick = await ask(`Which one? A number, a path, or "new" for a starter vault in ${shown(STARTER)}`, "1");
    if (pick === "new") answer = "";
    else if (/^\d+$/.test(pick)) answer = found[Number(pick) - 1] ?? fail(`There is no vault number ${pick}.`);
    else answer = pick;
  } else {
    answer = await ask(`Where are your notes? Paste the path to your vault, or press Enter for a new starter vault in ${shown(STARTER)}`);
  }
}
const vaultDir = answer ? fromUser(answer) : STARTER;
if (fs.existsSync(vaultDir) && !fs.statSync(vaultDir).isDirectory()) fail(`${vaultDir} is a file, not a folder.`);

const existing = fs.existsSync(vaultDir) ? markdownFiles(vaultDir) : [];
let profileNote = `About ${name}`;
let profileFile = null;
let created = [];
if (existing.length) {
  // An existing vault: use its profile note if it has one. Nothing is written into it without a yes.
  const wanted = [`about ${name}`, `about ${name.split(" ")[0]}`, "about me"].map((w) => w.toLowerCase());
  const found = existing.find((f) => wanted.includes(path.basename(f, ".md").toLowerCase()));
  if (found) {
    profileNote = path.basename(found, ".md");
    profileFile = found;
  } else if (await confirm(`Found ${existing.length} notes but no profile note. Add Notes/About ${name}.md so every client knows who you are?`, true)) {
    created = render(vaultDir, name, (rel) => rel.includes("About {{name}}"));
    profileFile = created[0] ?? null;
  }
} else {
  created = render(vaultDir, name);
  profileFile = created.find((f) => path.basename(f).startsWith("About ")) ?? null;
}

const isDefault = configPath === DEFAULT_CONFIG;
// What an MCP client runs. An npm install goes through npx, which needs cmd /c on Windows.
const server = INSTALLED
  ? { command: WIN ? "cmd" : "npx", args: [...(WIN ? ["/c", "npx"] : []), "-y", PKG, "--stdio"] }
  : { command: "node", args: [ENTRY, "--stdio"] };
if (!isDefault) server.args.push("--config", configPath);
const addArgs = ["mcp", "add", "--scope", "user", "brain", "--", server.command, ...server.args];
const addLine = `claude ${addArgs.map((a) => (a === ENTRY || a === configPath ? `"${a}"` : quote(a))).join(" ")}`;
const connect = rl && hasClaude() && (await confirm("Connect Claude Code now?", true));
rl?.close();

// The vault path is stored relative to the config when the vault sits beside it, so the folder can move as a whole.
const rel = path.relative(path.dirname(configPath), vaultDir);
const vaultPath = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? "./" + rel.split(path.sep).join("/") : vaultDir;
const { vaultPath: _example, ...base } = JSON.parse(fs.readFileSync(path.join(ROOT, "brain.config.json"), "utf8"));
const config = {
  vaultPath,
  // A separate index, so your notes and the example vault never share one; the models in data/models are shared.
  dataDir: "./data/local",
  ...base,
  owner: name,
  identity: { ...base.identity, profileNote },
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

// Index the vault and fetch the models now, so the first question from a client is not stuck behind a download.
if (INSTALLED && !flag("--no-models") && process.env.BRAIN_MCP_HYBRID !== "0") {
  console.log("\nIndexing your notes and fetching the search models (about 300 MB, only the first time)...\n");
  const warm = () => spawnSync(process.execPath, [ENTRY, "--reindex", "--warm", "--config", configPath], { stdio: ["ignore", "inherit", "inherit"] }).status === 0;
  // One retry: a dropped connection is the usual failure, and files that finished downloading are kept.
  let ok = warm();
  if (!ok) {
    console.log("\nRetrying once...\n");
    ok = warm();
  }
  if (!ok)
    console.log(`\nThe models could not be fetched now. Search works by keyword until the server fetches them on first use,\nor run this again: npx ${PKG} --reindex --warm`);
}

let connected = false;
if (connect) {
  const r = WIN ? spawnSync(addLine, { encoding: "utf8", shell: true }) : spawnSync("claude", addArgs, { encoding: "utf8" });
  connected = r.status === 0;
  if (!connected) console.log(`\nclaude mcp add did not work: ${(r.stderr || r.stdout || "").trim()}`);
}

const lines = [
  `Done. brain-mcp now serves ${name}'s notes from ${shown(vaultDir)}`,
  "",
  `  Config    ${shown(configPath)}${isDefault && !INSTALLED ? " (delete it to go back to the example vault)" : ""}`,
  profileFile
    ? `  Profile   ${shown(profileFile)}: fill it in first, every client reads it`
    : `  Profile   none yet: add a note titled "${profileNote}" and it becomes your profile`,
];
if (created.length) lines.push(`  Created   ${created.map((f) => path.relative(vaultDir, f)).join(", ")}`);
if (!fs.existsSync(ENTRY)) lines.push("", "Build the server first:", "", "  npm run build");
if (connected) lines.push("", "Claude Code is connected (server name: brain).");
else lines.push("", "Connect Claude Code:", "", `  ${addLine}`);
lines.push(
  "",
  "Claude Desktop, Cursor and other MCP clients: add this to their mcpServers config:",
  "",
  `  "brain": ${JSON.stringify(server)}`,
  "",
  'Then ask it: "what do you know about me?"',
  "Already connected? Restart your client so it loads the new vault.",
  "",
);
console.log("\n" + lines.join("\n"));
