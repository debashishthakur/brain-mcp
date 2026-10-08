import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DENSE_DEFAULTS, type DenseConfig } from "./vault/dense.js";

export interface BrainConfig {
  /** Hybrid retrieval (BM25 + local embeddings + reranker). Every field is optional; see DENSE_DEFAULTS. */
  retrieval?: Partial<DenseConfig>;
  vaultPath: string;
  /** Index and auth database folder, relative to the config file. Default: <package>/data, or ~/.brain-mcp/data when installed from npm. */
  dataDir?: string;
  owner: string;
  captureDir: string;
  memoryFile: string;
  /** Folders whose notes brain_write/edit/move/delete may change. Default: captureDir + "Notes". */
  writableDirs?: string[];
  ignoreDirs: string[];
  denyPaths: string[];
  privateProjects: string[];
  privatePaths: string[];
  identity: {
    profileNote: string;
    memoryProject: string;
    skillsProject: string;
    focusWindowDays: number;
    maxCharsPerMemoryNote: number;
    maxTotalChars: number;
  };
  context: {
    budgetChars: number;
    maxSectionChars: number;
    maxSectionsPerNote: number;
    candidateSections: number;
    candidateNotes: number;
  };
  http: { host: string; port: number; path: string };
  auth: {
    /** token = static bearer tokens from env (local only); oauth = OAuth 2.1 with login page (public) */
    mode: "token" | "oauth";
    /** Public origin clients use, e.g. https://brain.example.com. Required for oauth mode. */
    publicUrl: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    lockoutAfterFailures: number;
    lockoutWindowSec: number;
    defaultScopes: string[];
  };
}

const AUTH_DEFAULTS: BrainConfig["auth"] = {
  mode: "token",
  publicUrl: "",
  accessTokenTtlSec: 3600,
  refreshTokenTtlSec: 30 * 86400,
  lockoutAfterFailures: 5,
  lockoutWindowSec: 900,
  defaultScopes: ["brain:read", "brain:write", "brain:private"],
};

export interface ResolvedConfig extends Omit<BrainConfig, "retrieval"> {
  rootDir: string; // brain-mcp package root
  configPath: string; // the config file actually loaded
  vaultDir: string; // absolute vault path
  dataDir: string;
  modelsDir: string; // shared by every config, so switching vaults never re-downloads the models
  logDir: string;
  retrieval: DenseConfig;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts -> ../ ; dist/config.js -> ../
export const ROOT_DIR = path.resolve(here, "..");
/** The example vault's config, shipped with the repository. */
export const DEFAULT_CONFIG = path.join(ROOT_DIR, "brain.config.json");
/** Your own config, written by `npm run setup` and kept out of git. Used instead of the default when present. */
export const LOCAL_CONFIG = path.join(ROOT_DIR, "brain.config.local.json");
/** True when running from an npm install (npx or global) rather than a clone. npx may wipe its package folder at any time. */
export const INSTALLED = ROOT_DIR.split(path.sep).includes("node_modules");
/** Config, index, models and logs of an npm install, which cannot keep them in its own folder. */
export const HOME_DIR = path.resolve(process.env.BRAIN_MCP_HOME ?? path.join(os.homedir(), ".brain-mcp"));
/** Written by `npx debawho-brain-mcp init`; only read by an npm install, so a clone stays on its own configs. */
export const HOME_CONFIG = path.join(HOME_DIR, "config.json");
/** Where data/ and logs/ go when nothing else says: beside the package in a clone, in HOME_DIR when installed. */
const STATE_DIR = INSTALLED ? HOME_DIR : ROOT_DIR;

function defaultConfig(): string {
  if (fs.existsSync(LOCAL_CONFIG)) return LOCAL_CONFIG;
  if (INSTALLED && fs.existsSync(HOME_CONFIG)) return HOME_CONFIG;
  return DEFAULT_CONFIG;
}

export function loadConfig(overridePath?: string): ResolvedConfig {
  const cfgPath = path.resolve(overridePath ?? process.env.BRAIN_MCP_CONFIG ?? defaultConfig());
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as BrainConfig;
  const vaultDir = path.resolve(path.dirname(cfgPath), raw.vaultPath);
  if (!fs.existsSync(vaultDir)) throw new Error(`Vault path does not exist: ${vaultDir}`);
  const envData = process.env.BRAIN_MCP_DATA_DIR ? path.resolve(process.env.BRAIN_MCP_DATA_DIR) : undefined;
  const dataDir = envData ?? (raw.dataDir ? path.resolve(path.dirname(cfgPath), raw.dataDir) : path.join(STATE_DIR, "data"));
  const modelsDir = path.join(envData ?? path.join(STATE_DIR, "data"), "models");
  const logDir = process.env.BRAIN_MCP_LOG_DIR ? path.resolve(process.env.BRAIN_MCP_LOG_DIR) : path.join(STATE_DIR, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const auth = { ...AUTH_DEFAULTS, ...(raw.auth ?? {}) };
  if (process.env.BRAIN_MCP_AUTH_MODE === "token" || process.env.BRAIN_MCP_AUTH_MODE === "oauth") auth.mode = process.env.BRAIN_MCP_AUTH_MODE;
  if (process.env.BRAIN_MCP_PUBLIC_URL) auth.publicUrl = process.env.BRAIN_MCP_PUBLIC_URL;
  if (process.env.BRAIN_MCP_HOST) raw.http.host = process.env.BRAIN_MCP_HOST;
  if (process.env.BRAIN_MCP_PORT) raw.http.port = Number(process.env.BRAIN_MCP_PORT);
  const retrieval: DenseConfig = { ...DENSE_DEFAULTS, ...(raw.retrieval ?? {}), aliases: { ...DENSE_DEFAULTS.aliases, ...(raw.retrieval?.aliases ?? {}) } };
  if (process.env.BRAIN_MCP_HYBRID === "0") retrieval.hybrid = false; // emergency switch back to keyword-only ranking
  return { ...raw, auth, retrieval, rootDir: ROOT_DIR, configPath: cfgPath, vaultDir, dataDir, modelsDir, logDir };
}
