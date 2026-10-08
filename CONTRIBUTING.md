# Contributing to brain-mcp

Thank you for helping. brain-mcp is meant to be learned from and experimented on: a small, readable MCP server with a measurable retrieval problem at its centre. Students, engineers and researchers are all welcome, and so are first-time contributors.

## Ways to help

| If you have | Try |
| --- | --- |
| An hour | Add eval questions ([#4](https://github.com/debashishthakur/brain-mcp/issues/4)), fix a doc, report a confusing setup step |
| A weekend | A Docker image ([#5](https://github.com/debashishthakur/brain-mcp/issues/5)), an importer ([#6](https://github.com/debashishthakur/brain-mcp/issues/6)), passkey sign-in ([#7](https://github.com/debashishthakur/brain-mcp/issues/7)) |
| A research question | Abstention calibration ([#3](https://github.com/debashishthakur/brain-mcp/issues/3)), a faster reranker ([#10](https://github.com/debashishthakur/brain-mcp/issues/10)), graph expansion ([#2](https://github.com/debashishthakur/brain-mcp/issues/2)), temporal memory ([#8](https://github.com/debashishthakur/brain-mcp/issues/8)) |

### Architecture ideas welcome

The current design is deliberately simple: one process, one SQLite file, and a hybrid ranker (keywords, local embeddings, a reranker) built from fixed rules. Knobs exist today in the `retrieval` and `context` blocks of `brain.config.json`, and in constants such as `RRF_K` and `TITLE_BONUS` in `src/vault/index.ts`. Making more of it configurable or swappable, such as retrievers, storage, graph strategies and query rewriting, is a direction we would like help with. Ideas are welcome as issues, with or without code.

Open an issue before starting anything larger than a bug fix, so we can agree on the shape first. Research ideas are welcome as issues even before you have code: use the **Research proposal** template.

## Setup

You need Node 22 or newer.

```bash
git clone https://github.com/debashishthakur/brain-mcp.git
cd brain-mcp
npm install
npm run build
```

Then run the same checks CI runs:

```bash
npm run typecheck
node scripts/smoke.mjs           # every tool over stdio against example-vault/
node scripts/verify.mjs          # redaction, watcher, HTTP auth, audit log
node scripts/verify-memory.mjs   # brain_remember dedupe, topic identity, brain_context
node scripts/verify-write.mjs    # write, edit, move and delete on a throwaway vault
node scripts/verify-oauth.mjs    # the full OAuth 2.1 flow against a throwaway auth database
node scripts/verify-hybrid.mjs   # hybrid search checks
node scripts/verify-setup.mjs    # npm run setup, in a temp folder
node scripts/verify-package.mjs  # the npm package as a new user gets it: pack, install, init, serve
node scripts/eval-retrieval.mjs  # retrieval quality, keyword vs hybrid
node scripts/eval-hybrid.mjs     # the harder question set
```

All of these run against the bundled `example-vault/`, even if you have run `npm run setup` to point the server at your own notes. The scripts that write to the vault put it back exactly as they found it, so `git status` should be clean afterwards. If it is not, that is a bug worth reporting.

`npm install` may ask you to approve install scripts. Only `better-sqlite3` and `esbuild` need them, and both are already listed under `allowScripts` in `package.json`.

## The ranking rule

Any change that affects ranking (search, `brain_context` packing, fusion weights, stemming, stopwords, rerankers, embeddings, the relevance floor) must beat the current numbers from both evals:

```bash
node scripts/eval-retrieval.mjs   # 12 everyday questions
node scripts/eval-hybrid.mjs      # 15 harder ones, including off-topic questions that should be refused
```

To see why a query ranks the way it does, trace it with `node scripts/debug-rank.mjs "your question"`. It uses the same config as the server, so after `npm run setup` it traces your own notes; prefix it with `BRAIN_MCP_CONFIG=brain.config.json` to trace the example vault.

Put the before and after output in the pull request. "Beat" means no metric goes down and at least one goes up.

If your change needs new eval cases to show its value:

1. Add the cases in a separate commit first.
2. Record the baseline with the old code.
3. Apply your change and record the new numbers.

Keep questions phrased the way a person would ask them, not copied from the note.

## Running experiments

The eval is deterministic, so results are reproducible: same vault, same question, same answer. For research work:

- Keep new retrieval methods **off by default** behind a config flag, so the baseline stays comparable.
- Run everything locally. The server must not make network calls with note content.
- Report per-question changes, not only the totals, so others can see where a method helps and where it hurts.
- Note the model names, versions and parameters you used in the pull request.

## Pull requests

- One topic per pull request.
- Fill in the template: what changed, why, how you tested it, eval numbers when ranking is affected.
- CI must pass.

## Style

- TypeScript in `strict` mode, ES modules, no new runtime dependency without a reason in the pull request.
- Keep the server deterministic.
- Never commit a real vault, `data/`, `logs/` or `.env`. Test fixtures belong in `example-vault/` and must be fictional.

## Code of conduct

Please follow the [code of conduct](CODE_OF_CONDUCT.md). Be kind, be specific, and assume good intent.
