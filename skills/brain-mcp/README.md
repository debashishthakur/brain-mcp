# brain-mcp skill

Teaches your AI agent to use your Obsidian vault as memory, through the brain-mcp server.

With brain-mcp connected, your agent can already search your notes. This skill teaches it to use them well:

- **Knows you from the first message.** It loads your profile, preferences and current projects when the conversation is about your work, and leaves them out when it isn't.
- **Answers from your notes, with sources.** It picks the right tool for the question (context, search, project briefing, links, recent work) and cites the notes it used.
- **Doesn't invent your decisions.** When your vault doesn't cover something, it says so instead of guessing.
- **Remembers with your consent.** It saves durable facts and documents when you ask, or offers in one line, and skips session trivia and duplicates.
- **Keeps private things private.** Redacted secrets stay redacted, and vault content stays out of things other people will read unless you say so.

## Requirements

- The brain-mcp server, free and open source (MIT): `npx debawho-brain-mcp init`. It needs Node 22 or newer and works with any folder of Markdown notes; Obsidian is optional.
- An agent that supports skills (SKILL.md) and MCP servers, such as Claude Code, Cursor or Hermes Agent.

Setup steps for each client are in `references/setup.md`.

## Install the skill

Copy the `brain-mcp` folder into your agent's skills folder, for example `~/.claude/skills/brain-mcp/` for Claude Code, then start a new session. It activates when you ask about your own work, notes or preferences.

## What's inside

- `SKILL.md`: when to use each tool, how to read the results, when to write back.
- `references/tools.md`: every tool and its arguments.
- `references/setup.md`: install and connect brain-mcp.

No scripts, no network calls of its own, nothing to install. The skill is instructions only; your notes stay on your machine with the server.

## About

Built by Debashish Thakur, the author of brain-mcp: https://github.com/debashishthakur/brain-mcp · https://2brain.debawho.xyz

MIT licence.
