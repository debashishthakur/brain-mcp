#!/usr/bin/env node
// `npm run setup`: make brain-mcp yours. Asks for your name and where your notes live, then writes
// brain.config.local.json (kept out of git), which the server uses instead of the example vault. With no
// existing vault it creates a starter one from templates/starter-vault. The example vault and every
// check keep working either way.
//
//   npm run setup
//   npm run setup -- --name "Ada Lovelace" --vault ~/Notes --yes
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "templates", "starter-vault");
const ENTRY = path.join(ROOT, "dist", "index.js");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag("--help") || flag("-h")) {
  console.log(`Usage: npm run setup [-- options]

  --name <name>     your name (default: git config user.name)
  --vault <path>    your existing vault, or a new folder for a starter vault (default: ./my-vault)
  --config <file>   where to write the config (default: brain.config.local.json)
  --yes             ask nothing, take the defaults
  --force           replace an existing config`);
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
const fromUser = (p) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p.replace(/^~(?=$|[\\/])/, os.homedir()));
const shown = (p) => (p.startsWith(ROOT + path.sep) ? "./" + path.relative(ROOT, p).split(path.sep).join("/") : p);
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

console.log("\nbrain-mcp setup\n\nThis points brain-mcp at your own notes. Your settings go in a config file that git ignores,\nso the example vault and every check keep working.\n");

const configPath = path.resolve(opt("--config") ? fromUser(opt("--config")) : path.join(ROOT, "brain.config.local.json"));
if (fs.existsSync(configPath) && !flag("--force")) {
  let owner = "someone";
  try {
    owner = JSON.parse(fs.readFileSync(configPath, "utf8")).owner ?? owner;
  } catch {}
  if (!(await confirm(`${shown(configPath)} already exists (set up for ${owner}). Replace it?`, false)))
    fail(`Kept the existing ${shown(configPath)}. Run again with --force to replace it.`);
}

const name = clean(opt("--name") ?? (await ask("Your name", guessName())));
if (!name) fail('A name is needed: npm run setup -- --name "Your Name"');

const answer = opt("--vault") ?? (await ask("Where are your notes? Paste the path to your vault, or press Enter for a new starter vault in ./my-vault"));
const vaultDir = answer ? fromUser(answer) : path.join(ROOT, "my-vault");
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

const isDefault = configPath === path.join(ROOT, "brain.config.local.json");
const lines = [
  `Done. brain-mcp now serves ${name}'s notes from ${shown(vaultDir)}`,
  "",
  `  Config    ${shown(configPath)}${isDefault ? " (delete it to go back to the example vault)" : ""}`,
  profileFile
    ? `  Profile   ${shown(profileFile)}: fill it in first, every client reads it`
    : `  Profile   none yet: add a note titled "${profileNote}" and it becomes your profile`,
];
if (created.length) lines.push(`  Created   ${created.map((f) => path.relative(vaultDir, f)).join(", ")}`);
if (!fs.existsSync(ENTRY)) lines.push("", "Build the server first:", "", "  npm run build");
lines.push(
  "",
  "Connect Claude Code:",
  "",
  `  claude mcp add --scope user brain -- node "${ENTRY}" --stdio${isDefault ? "" : ` --config "${configPath}"`}`,
  "",
  'Then ask it: "what do you know about me?"',
  "Already connected? Restart your client so it loads the new vault.",
  "",
);
console.log("\n" + lines.join("\n"));
