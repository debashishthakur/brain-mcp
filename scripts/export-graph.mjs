#!/usr/bin/env node
// Export a vault's link graph to graph.json for the graph visualizer (visualizer/index.html).
//
//   npm run graph                       this clone, its config, writes visualizer/graph.json
//   node scripts/export-graph.mjs [<brain-mcp dir>] [--config <file>] [--out <file>] [--include-private]
//
// The brain-mcp dir defaults to this repository; point it at another install to export that one.
// Uses brain-mcp's own LinkGraph, so links resolve and strengths score exactly as search sees them. Reads the
// index read-only. Denied paths are always left out; private notes are left out unless --include-private.
// Each note also gets `sem`: the first three principal components of its mean section embedding, scaled to
// [-1, 1], which the viewer turns into a colour gradient (notes with similar meaning get similar colours).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brainDir = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : repoDir);
const out = path.resolve(flag("--out") ?? path.join(repoDir, "visualizer", "graph.json"));
const includePrivate = args.includes("--include-private");

const load = (rel) => import(pathToFileURL(path.join(brainDir, "dist", rel)).href);
const { loadConfig } = await load("config.js");
const { Policy, SCOPE_READ, SCOPE_PRIVATE } = await load("policy.js");
const { LinkGraph, clampGraph } = await load("vault/graph.js");
const Database = createRequire(path.join(brainDir, "package.json"))("better-sqlite3");

const cfg = loadConfig(flag("--config"));
const dbPath = path.join(cfg.dataDir, "index.db");

// The live server holds the index open in WAL mode; if a read-only open fails, read a private copy instead.
let db;
let tmp;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.prepare("SELECT 1 FROM notes LIMIT 1").get();
} catch {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-graph-"));
  for (const ext of ["", "-wal"]) if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, path.join(tmp, "index.db" + ext));
  db = new Database(path.join(tmp, "index.db"));
}

const policy = new Policy(cfg);
const principal = { clientId: "graph-export", scopes: new Set(includePrivate ? [SCOPE_READ, SCOPE_PRIVATE] : [SCOPE_READ]), transport: "stdio" };
const graph = new LinkGraph(db, { graph: clampGraph({ ...(cfg.retrieval.graph ?? {}), enabled: true }), aliases: cfg.retrieval.aliases });

const rows = db.prepare("SELECT id, title, type, project, visibility, modified FROM notes ORDER BY id").all();
const readable = new Map(rows.filter((r) => policy.canRead(r, principal)).map((r) => [r.id, r]));
const topics = new Map();
for (const t of db.prepare("SELECT note_id, topic FROM note_topics").all()) {
  if (!topics.has(t.note_id)) topics.set(t.note_id, []);
  topics.get(t.note_id).push(t.topic);
}

// ---- links: one per note pair, the stronger of the two directions (as search keeps it)
const pairs = new Map();
for (const id of readable.keys()) {
  for (const nb of graph.neighbours(id)) {
    if (!readable.has(nb.id) || nb.strength <= 0) continue;
    const [source, target] = nb.dir === "out" ? [id, nb.id] : [nb.id, id];
    const key = id < nb.id ? `${id}\n${nb.id}` : `${nb.id}\n${id}`;
    const cur = pairs.get(key);
    if (cur && cur.strength >= nb.strength) continue;
    const ctx = graph.ctx(nb.from, nb.pos);
    pairs.set(key, {
      source,
      target,
      strength: Math.round(nb.strength * 1000) / 1000,
      kind: nb.kind,
      sentence: ctx ? policy.redact(ctx.length > 220 ? ctx.slice(0, 219).trimEnd() + "…" : ctx).text : null,
    });
  }
}
const links = [...pairs.values()];
const degree = new Map();
for (const l of links) for (const n of [l.source, l.target]) degree.set(n, (degree.get(n) ?? 0) + 1);

// ---- meaning: mean section vector per note, then PCA to three components
const vecs = new Map();
let dim = 0;
for (const r of db.prepare("SELECT note_id, dim, v FROM section_vectors WHERE model = ?").iterate(cfg.retrieval.embedModel)) {
  if (!readable.has(r.note_id)) continue;
  dim = r.dim;
  const v = new Float32Array(r.v.buffer, r.v.byteOffset, r.dim);
  const acc = vecs.get(r.note_id) ?? { sum: new Float64Array(r.dim), n: 0 };
  for (let j = 0; j < r.dim; j++) acc.sum[j] += v[j];
  acc.n++;
  vecs.set(r.note_id, acc);
}
const sem = new Map();
if (vecs.size >= 4) {
  const ids = [...vecs.keys()];
  const X = ids.map((id) => {
    const { sum } = vecs.get(id);
    const norm = Math.hypot(...sum) || 1;
    return Float64Array.from(sum, (x) => x / norm);
  });
  const mean = new Float64Array(dim);
  for (const x of X) for (let j = 0; j < dim; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < dim; j++) x[j] -= mean[j];
  // Power iteration with deflation on X^T X, without forming the dim x dim matrix.
  const comps = [];
  for (let c = 0; c < 3; c++) {
    let w = Float64Array.from({ length: dim }, (_, j) => Math.sin(j * (c + 1) + 1));
    for (let it = 0; it < 100; it++) {
      const next = new Float64Array(dim);
      for (const x of X) {
        let p = 0;
        for (let j = 0; j < dim; j++) p += x[j] * w[j];
        for (let j = 0; j < dim; j++) next[j] += p * x[j];
      }
      for (const u of comps) {
        let p = 0;
        for (let j = 0; j < dim; j++) p += next[j] * u[j];
        for (let j = 0; j < dim; j++) next[j] -= p * u[j];
      }
      const n = Math.hypot(...next) || 1;
      w = next.map((x) => x / n);
    }
    comps.push(w);
  }
  const proj = X.map((x) => comps.map((u) => x.reduce((s, xj, j) => s + xj * u[j], 0)));
  const scale = [0, 1, 2].map((c) => Math.max(...proj.map((p) => Math.abs(p[c]))) || 1);
  ids.forEach((id, i) => sem.set(id, proj[i].map((p, c) => Math.round((p / scale[c]) * 1000) / 1000)));
}

const nodes = [...readable.values()].map((r) => ({
  id: r.id,
  title: r.title,
  type: r.type,
  project: r.project ?? null,
  topics: topics.get(r.id) ?? [],
  modified: r.modified,
  structural: graph.isStructural(r.id),
  degree: degree.get(r.id) ?? 0,
  sem: sem.get(r.id) ?? null,
}));

const result = {
  generated: new Date().toISOString(),
  vault: path.basename(cfg.vaultDir),
  includesPrivate: includePrivate,
  embedModel: cfg.retrieval.embedModel,
  strength: "brain-mcp LinkGraph.strength: where the link sits x repeats x reciprocity x target rarity (0.8x for backlinks); search follows links >= " + clampGraph(cfg.retrieval.graph ?? {}).minWeight,
  nodes,
  links,
};
fs.writeFileSync(out, JSON.stringify(result));
db.close();
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${out}: ${nodes.length} notes, ${links.length} links, ${sem.size} with meaning colours`);
