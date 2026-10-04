// Drive the built server over stdio like an MCP client and exercise the hybrid tool paths (read-only)
// against the bundled example vault: off-topic refusal, concept lookup, spelling correction,
// identifiers, a paraphrased context question.
// Run after `npm run build`:  node scripts/verify-hybrid.mjs
import "./use-example-vault.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../dist/config.js";

const cfg = loadConfig();
const transport = new StdioClientTransport({ command: "node", args: [`${cfg.rootDir}/dist/index.js`, "--stdio"], stderr: "pipe", env: { ...process.env } });
transport.stderr?.on("data", (d) => { const s = String(d); if (/\[dense\]|\[fatal\]|Error/.test(s)) process.stderr.write("[server] " + s); });
const client = new Client({ name: "verify-hybrid", version: "0.0.1" });
await client.connect(transport);
console.log("instructions mention coverage:", /coverage "none"/.test(client.getInstructions() ?? ""));

const CHECKS = [
  ["brain_search", { query: "best pizza in rome", limit: 5 }, /Coverage: none/],
  ["brain_search", { query: "which projects use PostgreSQL", limit: 5 }, /Concepts\/PostgreSQL\.md|Use PostgreSQL for the ledger/],
  // Asserts the spelling correction only: whether this query clears the relevance floor is borderline
  // and differs across CPUs (issue #3), so the eval scripts score it instead of failing CI.
  ["brain_search", { query: "postgress restore steps", limit: 3 }, /spelling read as postgress→postgresql/],
  ["brain_search", { query: "harbor-import.timer", limit: 3 }, /Restore the ledger database/],
  ["brain_context", { question: "how do I get the ledger back after the home server disk died", budget_chars: 6000 }, /Coverage: (good|thin)[\s\S]*Restore the ledger database/],
  ["brain_context", { question: "recipe for chicken biryani" }, /does not record anything/],
];
let ok = 0;
for (const [name, args, expect] of CHECKS) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
  const pass = expect.test(text);
  ok += pass ? 1 : 0;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)}  ${Date.now() - t0} ms, ${text.length} chars`);
  console.log("     " + text.split("\n").slice(0, 2).join(" | ").slice(0, 200));
}
console.log(`\n${ok}/${CHECKS.length} checks passed`);
await client.close();
process.exit(ok === CHECKS.length ? 0 : 1);