// Verifies the hybrid ranker's last step without the models: a stand-in dense index scores sections and passages
// by rule, so each case sets up exactly the lists and reranker scores it needs. Covers a shortlist with nothing to
// rerank, a note with no sections (only its title would reach the reranker), and agreeOverride. Needs no models.
// Run after `npm run build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { VaultIndex } from "../dist/vault/index.js";

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failed++;
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "brain-ranking-"));
const vault = path.join(ROOT, "vault");
const put = (rel, s) => (fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }), fs.writeFileSync(path.join(vault, rel), s));
const note = (title, body) => `---\ntitle: "${title}"\ntype: note\n---\n# ${title}\n\n${body}\n`;
put("Notes/Lantern.md", note("Lantern", "## Brass\n\nThe brass lantern hangs on the quay by the old harbour wall.\n\n## Oil\n\nIt burns lamp oil, refilled on Sundays."));
put("Notes/Harbour.md", note("Harbour", "## Walls\n\nThe harbour wall was rebuilt in stone after the storm."));
put("Notes/Tides.md", note("Tides", "## Tables\n\nTide tables for the harbour are printed every month."));
put("Notes/Dentist appointments.md", "---\ntitle: Dentist appointments\ntags: [health]\n---\n");
fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(new URL("../brain.config.json", import.meta.url), "utf8")), vaultPath: "vault", dataDir: "data", retrieval: { hybrid: false } }));
process.env.BRAIN_MCP_LOG_DIR = path.join(ROOT, "logs");
const cfg = loadConfig(path.join(ROOT, "config.json"));
const index = new VaultIndex(cfg);
index.fullReindex();
const keys = index.db.prepare("SELECT note_id, ord FROM sections ORDER BY note_id, ord").all();

// The stand-in: cos[key] for meaning search (0.05 otherwise), prob(passage) for the reranker.
const fake = {
  cos: {},
  prob: () => 0.001,
  passages: [],
  ready: async () => true,
  correct: () => null,
  schedule() {},
  forget() {},
  stop() {},
  async scoreAll() {
    const hits = keys.map((k) => ({ ...k, score: this.cos[`${k.note_id}#${k.ord}`] ?? 0.05 }));
    return hits.sort((a, b) => b.score - a.score || (a.note_id < b.note_id ? -1 : a.note_id > b.note_id ? 1 : a.ord - b.ord));
  },
  async search(q, k = 40) {
    return (await this.scoreAll(q)).slice(0, k);
  },
  async rerank(_q, ps) {
    this.passages.push(...ps);
    return ps.map((p) => this.prob(p));
  },
};
index.dense = fake;
const rc = cfg.retrieval;
const run = async (q, set = {}) => {
  const saved = { ...rc };
  Object.assign(rc, set);
  fake.passages = [];
  try {
    return await index.rankSections(q, { k: 24, debug: true });
  } catch (e) {
    return { error: e.message };
  } finally {
    Object.assign(rc, saved);
  }
};

// Nothing to rerank: rerankN 0 without first picks. Refused, whatever agreeOverride says, never a crash.
fake.cos = { "Notes/Lantern.md#1": 0.9 };
for (const agree of [false, true]) {
  const r = await run("brass lantern quay", { rerankN: 0, firstPicks: false, agreeOverride: agree });
  check(`an empty shortlist is refused, not a crash (agreeOverride ${agree})`, !r.error && r.coverage === "none" && r.sections.length === 0, r.error ?? `${r.coverage} ${r.sections?.length}`);
}

// A note with no sections: its title alone would score high, but it has nothing to return.
fake.cos = {};
fake.prob = (p) => (p.trim() === "Dentist appointments" ? 0.99 : 0.001);
const empty = await run("when are my dentist appointments");
check(
  "a note with no sections never reaches the reranker, so it cannot win coverage for unrelated hits",
  empty.coverage === "none" && empty.sections.length === 0 && !fake.passages.some((p) => p.startsWith("Dentist appointments")),
  JSON.stringify({ coverage: empty.coverage, n: empty.sections.length, note: empty.debug?.lists.note }),
);

// agreeOverride: keyword and meaning search agree on a section, the reranker scores everything under the floor.
fake.cos = { "Notes/Lantern.md#1": 0.9 };
fake.prob = () => 0.001;
const pre = await run("brass lantern quay");
const agreed = pre.debug.lists.lex[0] === "Notes/Lantern.md#1" && pre.debug.lists.den[0] === "Notes/Lantern.md#1";
check("(setup) both searches put Lantern's brass section first", agreed, JSON.stringify({ lex: pre.debug.lists.lex.slice(0, 3), den: pre.debug.lists.den.slice(0, 3) }));
check("agreeOverride off (the default): refused", pre.coverage === "none" && pre.sections.length === 0, `${pre.coverage} ${pre.sections.length}`);
const on = await run("brass lantern quay", { agreeOverride: true });
check(
  "agreeOverride on: thin, with the agreed note's sections only",
  on.coverage === "thin" && on.sections.length > 0 && on.sections.every((s) => s.note_id === "Notes/Lantern.md"),
  JSON.stringify({ coverage: on.coverage, notes: on.sections.map((s) => s.note_id) }),
);
fake.cos = { "Notes/Lantern.md#2": 0.9 };
const sameNote = await run("brass lantern quay", { agreeOverride: true });
check("agreeOverride on, same note but another section: refused", sameNote.coverage === "none", `${sameNote.coverage} lex ${sameNote.debug.lists.lex[0]} den ${sameNote.debug.lists.den[0]}`);

await index.close();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall ranking checks passed");
process.exit(failed ? 1 : 0);
