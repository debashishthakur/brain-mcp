# Contributing to brain-mcp

Thank you for helping. brain-mcp is meant to be learned from and experimented on: a small, readable MCP server with a measurable retrieval problem at its centre. Students, engineers and researchers are all welcome, and so are first-time contributors.

## Ways to help

| If you have | Try |
| --- | --- |
| An hour | Add eval questions ([#4](https://github.com/debashishthakur/brain-mcp/issues/4)), fix a doc, report a confusing setup step |
| A weekend | A Docker image ([#5](https://github.com/debashishthakur/brain-mcp/issues/5)), an importer ([#6](https://github.com/debashishthakur/brain-mcp/issues/6)), passkey sign-in ([#7](https://github.com/debashishthakur/brain-mcp/issues/7)) |
| A research question | Embeddings ([#1](https://github.com/debashishthakur/brain-mcp/issues/1)), graph expansion ([#2](https://github.com/debashishthakur/brain-mcp/issues/2)), abstention ([#3](https://github.com/debashishthakur/brain-mcp/issues/3)), temporal memory ([#8](https://github.com/debashishthakur/brain-mcp/issues/8)) |

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
node scripts/verify-oauth.mjs    # the full OAuth 2.1 flow against a throwaway auth database
node scripts/eval-retrieval.mjs  # retrieval quality
```

All of these run against the bundled `example-vault/`. The scripts that write to the vault put it back exactly as they found it, so `git status` should be clean afterwards. If it is not, that is a bug worth reporting.

`npm install` may ask you to approve install scripts. Only `better-sqlite3` and `esbuild` need them, and both are already listed under `allowScripts` in `package.json`.

## The ranking rule

Any change that affects ranking (search, `brain_context` packing, fusion weights, stemming, stopwords, rerankers, embeddings) must beat the current numbers from:

```bash
node scripts/eval-retrieval.mjs
```

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
