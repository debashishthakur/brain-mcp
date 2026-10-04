# brain-mcp

An MCP server that turns an Obsidian vault into live context for Claude and any other MCP client. Connect a client and it learns who you are, how you like to work, what your projects are and what you touched this week, then searches, follows links and writes back to the vault as you talk.

It runs locally over stdio, on your network over HTTP with a bearer token, or on the public internet behind an OAuth 2.1 login with a password and an authenticator code. There is no model inside the server: ranking is SQLite FTS5 plus fixed fusion rules, so results are reproducible and cheap to evaluate.

## What it does

| Tool | Purpose |
| --- | --- |
| `brain_identity` | Persona bundle: profile note, memory notes, facts captured with `brain_remember`, skills, project list and recent focus. The server instructions ask the client to call this first. Pass `topic` for a smaller bundle that keeps only the memory notes that apply. |
| `brain_context` | One call that returns the sections most relevant to a question, with source note ids. Section-level FTS fused with note-level FTS, a graph-neighbour bonus and a title-match bonus, packed under a size budget. |
| `brain_search` | FTS5 full-text search with project, type, topic and since-date filters. BM25 rank fused with title overlap. |
| `brain_read` | One note (or one section of it) with metadata, topics and resolved links. |
| `brain_project` | Briefing on a project: description, latest progress, decisions, recent changes and notes grouped by type. With no argument it lists projects. |
| `brain_graph` | Links out, backlinks grouped by project, and notes that share topics. |
| `brain_recent` | Notes modified in the last N days, newest first. |
| `brain_capture` | Writes a new note with graph-ready frontmatter into the capture folder. |
| `brain_remember` | Appends a fact to the memory file; it joins `brain_identity` straight away. Near-duplicates are refused (token Jaccard ≥ 0.6 or containment ≥ 0.85), partial overlaps are stored with a `Supersedes` line, and `force=true` overrides. |

Also exposed: the resources `brain://identity` and `brain://note/{path}`, and the prompts `assume_persona` and `project_briefing`.

The index is SQLite with FTS5 in `data/index.db`. It is rebuilt from scratch on every start (about 10 ms for the 15-note example vault) and kept current by a file watcher, so edits made in Obsidian show up within a second. Every tool call is appended to `logs/audit.jsonl`.

## Quick start

Requires Node 22 or newer. Clone this repository, then:

```bash
cd brain-mcp
npm install
npm run build
node scripts/smoke.mjs
```

The repository ships with `example-vault/`, a small fictional vault belonging to Ines Varga, a backend engineer with two side projects. `brain.config.json` points at it, so the smoke test drives every tool, resource and prompt over stdio against real notes and then restores the vault.

If `npm install` reports held-back install scripts, the two packages that need them (`better-sqlite3` and `esbuild`) are already approved under `allowScripts` in `package.json`. Run `npm install-scripts approve better-sqlite3 esbuild` if your npm still asks.

The other checks:

```bash
npm run typecheck
node scripts/verify.mjs          # redaction, file watcher, HTTP bearer auth, audit log
node scripts/verify-memory.mjs   # brain_remember dedupe, topic identity, brain_context; restores the memory file
node scripts/verify-oauth.mjs    # the full OAuth 2.1 flow against a throwaway auth database (26 checks)
node scripts/eval-retrieval.mjs  # natural-language questions with expected notes
```

### Retrieval eval

`scripts/eval-retrieval.mjs` asks 12 natural-language questions about the example vault and checks whether the expected note comes back. Current numbers, deterministic ranking only:

| Metric | Result |
| --- | --- |
| `brain_search` top-1 | 42% |
| `brain_search` top-5 | 100% |
| `brain_context` first source correct | 58% |
| `brain_context` expected note in pack | 100% |

The last row is the one a client model experiences, since it reads the whole pack. Most misses are a sibling note from the same project ranking first, and "who am I and where do I work", which shares no keywords with the profile note. That is the kind of question embeddings would fix. When you point the server at your own vault, replace the cases with questions about your notes.

## Point it at your own vault

Edit `brain.config.json`:

```json
{
  "vaultPath": "../my-vault",
  "owner": "Your Name",
  "privatePaths": ["Private/**", "Journal/**"],
  "identity": {
    "profileNote": "About me",
    "memoryProject": "Assistant Memory",
    "skillsProject": "Assistant Skills"
  }
}
```

`vaultPath` is resolved relative to the config file. Use `--config <path>` or `BRAIN_MCP_CONFIG` to keep your config outside the repository. Then run `npm run reindex` to check the note count.

### What the server reads from a note

Any Markdown file in the vault is indexed. Frontmatter makes it richer:

| Field | Used for |
| --- | --- |
| `title` | Display name and title matching. Falls back to the file name. |
| `type` | `hub` marks a project hub, `concept` a shared topic note. `progress` and `decision` notes get their own sections in `brain_project`. Other useful values: `runbook`, `architecture`, `plan`, `research`, `spec`, `audit`, `agent`, `note`. |
| `project` | The project a note belongs to, usually a wikilink to its hub: `"[[Harbor Ledger]]"`. |
| `topics` | Concepts the note is about, as wikilinks. Drives the topic filter and shared-topic neighbours. |
| `related`, `part-of` | Extra links, added to the graph like body wikilinks. |
| `aliases` | Other names `brain_read` and `brain_graph` will resolve. |
| `visibility` | `private` hides the note from connections without the `brain:private` scope. |
| `modified` | Date used for recency, `brain_recent` and the identity focus list. Falls back to the file's mtime. |
| `note-count`, `last-touched` | Shown next to each hub in the identity bundle. |

Wikilinks in the body (`[[Note]]`, `[[Note#Heading]]`, `[[Note|alias]]`) become graph edges. A leading `# Title` that repeats the title is dropped from what clients read, and a generated `## Connections` trailer after a `---` rule is left out of search and context.

### How identity is assembled

- **Profile:** the note named by `identity.profileNote`, matched by title, alias, path or file name.
- **Memory:** every note whose `project` is `identity.memoryProject`. Write each one with a **How to apply** line; the bundle tells the client to follow them.
- **Captured facts:** the file at `memoryFile`, which `brain_remember` appends to.
- **Skills:** notes in `identity.skillsProject`, listed by their first paragraph.
- **Projects:** every note with `type: hub`.
- **Current focus:** content notes modified in the last `identity.focusWindowDays` days.

### Configuration reference

| Key | Meaning |
| --- | --- |
| `vaultPath` | Vault folder, relative to the config file. |
| `owner` | Name used in the server instructions and the identity bundle. |
| `captureDir` | The only folder the server writes to. |
| `memoryFile` | File `brain_remember` appends to. Must be inside `captureDir`. |
| `ignoreDirs` | Top-level folders that are never indexed. Any path segment starting with `.` is skipped too. |
| `denyPaths` | Globs that are never served to anyone. |
| `privateProjects`, `privatePaths` | Project names and globs that need the `brain:private` scope. |
| `context.*` | `brain_context` budget, per-section cap, sections per note and candidate pool sizes. |
| `identity.*` | Profile note, memory and skills projects, focus window and size caps. |
| `http.*` | Host, port and path for HTTP modes. The shipped config uses `127.0.0.1:3737/mcp`. |
| `auth.*` | Mode, public URL, token lifetimes, lockout policy and default scopes for OAuth. |

Environment overrides: `BRAIN_MCP_CONFIG`, `BRAIN_MCP_DATA_DIR`, `BRAIN_MCP_LOG_DIR`, `BRAIN_MCP_HOST`, `BRAIN_MCP_PORT`, `BRAIN_MCP_AUTH_MODE` (`token` or `oauth`) and `BRAIN_MCP_PUBLIC_URL`.

## Connect a client

### Claude Code

Register it for every project:

```bash
claude mcp add --scope user brain -- node /absolute/path/to/brain-mcp/dist/index.js --stdio
```

Or commit a `.mcp.json` to a project so it is available whenever that folder is open:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/absolute/path/to/brain-mcp/dist/index.js", "--stdio"]
    }
  }
}
```

### Claude Desktop

Add the server to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart the app:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/absolute/path/to/brain-mcp/dist/index.js", "--stdio"]
    }
  }
}
```

### HTTP on your own network

```bash
export BRAIN_MCP_TOKEN="$(node dist/index.js --gen-token)"   # keep this somewhere safe
node dist/index.js --http                                     # http://127.0.0.1:3737/mcp
```

`BRAIN_MCP_TOKEN` grants the read, write and private scopes. `BRAIN_MCP_TOKEN_RO` grants read only. Tokens shorter than 32 characters are ignored, and the server refuses to start in this mode with no token. It binds to loopback; only expose it over a private network such as Tailscale. Anything public should use `--oauth`.

### Remote access (claude.ai, phone, any MCP client)

`--oauth` starts the public transport: an OAuth 2.1 authorization server plus the protected `/mcp` endpoint, meant to listen on loopback behind Cloudflare Tunnel or another TLS-terminating proxy. `node scripts/verify-oauth.mjs` checks the whole flow end to end.

**What a client goes through.** Discovery (`/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`), dynamic client registration at `/register` (https or loopback redirect URIs only), `/authorize` with PKCE S256, a login page (password plus a 6-digit authenticator code, both checked every time; five failures pause sign-in for 15 minutes), a consent page listing the scopes, then `/token`. Access tokens live one hour. Refresh tokens rotate on every use and live 30 days, and presenting a rotated-out refresh token revokes the whole grant. Tokens are opaque and stored only as SHA-256 hashes; the password is stored as an scrypt hash.

**Set it up on a Linux box** (Node 22+). Clone the repository to `~/brain-mcp`, put your vault where `vaultPath` expects it, set `auth.publicUrl` to your hostname (for example `https://brain.example.com`), then:

```bash
~/brain-mcp/deploy/setup-linux.sh                      # builds, installs the systemd unit
cd ~/brain-mcp && node dist/index.js auth init         # password + QR code for your authenticator app
sudo systemctl start brain-mcp
```

Then follow the Cloudflare Tunnel steps the script prints: log in, create a tunnel, route your hostname to it, install the service. `deploy/cloudflared-config.yml` is the ingress template.

**Or on a Windows box** (elevated PowerShell, Node 22+ via `winget install OpenJS.NodeJS.LTS`). Clone to `$HOME\brain-mcp`, then:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& "$HOME\brain-mcp\deploy\setup-windows.ps1"   # builds, registers a boot-time task as SYSTEM, disables sleep
cd $HOME\brain-mcp; node dist\index.js auth init
Start-ScheduledTask -TaskName brain-mcp
```

The script prints the cloudflared steps for Windows afterwards. Logs go to `logs\service.log`.

**Connect clients**

- claude.ai: Settings → Connectors → Add custom connector → `https://brain.example.com/mcp`. Sign in once on the page that opens.
- Claude Code: `claude mcp add --scope user --transport http brain https://brain.example.com/mcp`, then run `/mcp` and authenticate.
- Anything else that speaks MCP over HTTP with OAuth: the same URL.

**Manage access** from the box:

```bash
node dist/index.js auth status          # configured? counts, recent failures
node dist/index.js auth clients         # every registered client and its live grants
node dist/index.js auth grants          # active refresh grants with last-used time
node dist/index.js auth revoke-client <client_id>
node dist/index.js auth revoke-all
node dist/index.js auth set-password    # or rotate-totp
```

`journalctl -u brain-mcp -f` shows registrations, logins, consents and refresh-reuse alarms. `logs/audit.jsonl` shows every tool call with the client id.

**Keeping the vault fresh on the box.** Sync the vault folder from your laptop with Syncthing, or a git push and a pull on a timer. The watcher picks changes up within a second.

## Security model

- **Transport.** stdio inherits the OS user. HTTP needs a bearer token compared in constant time, and each session is bound to the client id that opened it.
- **Scopes.** `brain:read`, `brain:write`, `brain:private`. Notes marked `visibility: private`, or matched by `privateProjects` or `privatePaths`, need the private scope. `denyPaths` are never served. The example vault keeps one note under `Private/` so you can watch this work.
- **Redaction.** Credential-shaped strings (Anthropic, OpenAI, GitHub, AWS, Google, Slack and Stripe keys, JWTs, private keys, `password=` style assignments, credentials embedded in URLs) are masked before they leave the server. Placeholders such as `<your-key>` and `${ENV}` are left alone.
- **Writes** are confined to `captureDir`. Path traversal outside it is refused.
- **Audit.** Every call records timestamp, transport, client, session, tool, truncated arguments, note ids returned and redaction count.

If a script regenerates your vault, keep `captureDir` out of whatever it deletes, so notes written through the server survive. Notes the script generates should not be edited through the server, since the next run would overwrite them.

## Roadmap

- Local embeddings for recall on paraphrased questions, the remaining eval misses.
- A local reranker, enabled only if it beats `scripts/eval-retrieval.mjs`.
- Passkey (WebAuthn) login as an alternative to password plus authenticator code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The one hard rule: any change to ranking must beat `node scripts/eval-retrieval.mjs`.

## License

MIT, see [LICENSE](LICENSE).

Created by [Debashish Thakur](https://github.com/debashishthakur).
