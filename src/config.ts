import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BrainConfig {
  vaultPath: string;
  owner: string;
  captureDir: string;
  memoryFile: string;
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

export interface ResolvedConfig extends BrainConfig {
  rootDir: string; // brain-mcp package root
  vaultDir: string; // absolute vault path
  dataDir: string;
  logDir: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts -> ../ ; dist/config.js -> ../
export const ROOT_DIR = path.resolve(here, "..");

export function loadConfig(overridePath?: string): ResolvedConfig {
  const cfgPath = overridePath ?? process.env.BRAIN_MCP_CONFIG ?? path.join(ROOT_DIR, "brain.config.json");
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as BrainConfig;
  const vaultDir = path.resolve(path.dirname(cfgPath), raw.vaultPath);
  if (!fs.existsSync(vaultDir)) throw new Error(`Vault path does not exist: ${vaultDir}`);
  const dataDir = process.env.BRAIN_MCP_DATA_DIR ? path.resolve(process.env.BRAIN_MCP_DATA_DIR) : path.join(ROOT_DIR, "data");
  const logDir = process.env.BRAIN_MCP_LOG_DIR ? path.resolve(process.env.BRAIN_MCP_LOG_DIR) : path.join(ROOT_DIR, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const auth = { ...AUTH_DEFAULTS, ...(raw.auth ?? {}) };
  if (process.env.BRAIN_MCP_AUTH_MODE === "token" || process.env.BRAIN_MCP_AUTH_MODE === "oauth") auth.mode = process.env.BRAIN_MCP_AUTH_MODE;
  if (process.env.BRAIN_MCP_PUBLIC_URL) auth.publicUrl = process.env.BRAIN_MCP_PUBLIC_URL;
  if (process.env.BRAIN_MCP_HOST) raw.http.host = process.env.BRAIN_MCP_HOST;
  if (process.env.BRAIN_MCP_PORT) raw.http.port = Number(process.env.BRAIN_MCP_PORT);
  return { ...raw, auth, rootDir: ROOT_DIR, vaultDir, dataDir, logDir };
}
