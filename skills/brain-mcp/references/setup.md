# Setting up brain-mcp

This skill needs the brain-mcp server connected to your AI client. Show these steps to the user; they run them.

## One command (Node 22 or newer)

```bash
npx debawho-brain-mcp init
```

It lists the Obsidian vaults on the machine and asks which one to serve (or creates a starter vault in `~/second-brain`), asks for the owner's name, downloads the local search models once (about 300 MB), and offers to connect Claude Code. Notes stay where they are; the config, index and logs go in `~/.brain-mcp/`. Nothing is uploaded: the server and its models run on the user's machine.

## Connect a client by hand

Claude Code:

```bash
claude mcp add --scope user brain -- npx -y debawho-brain-mcp --stdio
```

Hermes Agent:

```bash
hermes mcp add brain --command npx --args -y debawho-brain-mcp --stdio
```

Cursor, Claude Desktop and other clients that read an `mcpServers` config:

```json
{
  "mcpServers": {
    "brain": { "command": "npx", "args": ["-y", "debawho-brain-mcp", "--stdio"] }
  }
}
```

On Windows, put `cmd /c` in front of `npx`: `"command": "cmd", "args": ["/c", "npx", "-y", "debawho-brain-mcp", "--stdio"]`.

Restart the client after adding the server, then ask: "what do you know about me?"

## Remote access

To reach the same vault from claude.ai or a phone, brain-mcp can run as an OAuth 2.1 server behind a TLS proxy such as Cloudflare Tunnel. See the "Remote access" section of the README: https://github.com/debashishthakur/brain-mcp

## Links

- Source and docs: https://github.com/debashishthakur/brain-mcp
- npm: https://www.npmjs.com/package/debawho-brain-mcp
- MCP Registry: `io.github.debashishthakur/brain-mcp`
