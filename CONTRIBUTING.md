# Contributing

Thanks for helping. This is a small project, so the process is light: open an issue for anything bigger than a bug fix, then send a pull request.

## Setup

You need Node 22 or newer.

```bash
npm install
npm run build
npm run typecheck
node scripts/smoke.mjs          # every tool over stdio against example-vault/
node scripts/verify.mjs         # redaction, watcher, HTTP auth, audit log
node scripts/verify-memory.mjs  # brain_remember dedupe, topic identity, brain_context
node scripts/verify-oauth.mjs   # the full OAuth 2.1 flow against a throwaway auth database
node scripts/eval-retrieval.mjs # retrieval quality
```

All of these run against the bundled `example-vault/`. The scripts that write to the vault put it back exactly as they found it, so `git status` should be clean afterwards. If it is not, that is a bug.

`npm install` may ask you to approve install scripts. Only `better-sqlite3` and `esbuild` need them, and both are already listed under `allowScripts` in `package.json`.

## The ranking rule

Any change that affects ranking (search, `brain_context` packing, fusion weights, stemming, stopwords, rerankers, embeddings) must beat the current numbers from:

```bash
node scripts/eval-retrieval.mjs
```

Put the before and after output in the pull request. "Beat" means no metric goes down and at least one goes up. If your change needs new eval cases to show its value, add them in a separate commit first, record the baseline with the old code, then apply your change. Keep questions phrased the way a person would ask them, not copied from the note.

## Where help is most useful

- **Retrieval:** local embeddings for paraphrased questions, and rerankers. Both stay off by default until they pass the ranking rule.
- **Graph expansion:** better use of wikilinks, backlinks and shared topics when building a context pack.
- **Security:** redaction patterns for more credential formats, tighter scope checks, and passkey (WebAuthn) login as an alternative to password plus authenticator code.
- **Importers:** turning other note tools (Logseq, Notion exports, plain Markdown folders) into vault notes with the frontmatter this server reads.
- **Deploy:** setup scripts for more platforms, containers, and other tunnels or reverse proxies.
- **Docs:** clearer setup guides, and examples of real vault layouts.

## Style

- TypeScript in `strict` mode, ES modules, no new runtime dependency without a reason in the pull request.
- Keep the server deterministic: same vault, same question, same answer.
- Never commit a real vault, `data/`, `logs/` or `.env`. Test fixtures belong in `example-vault/` and must be fictional.
