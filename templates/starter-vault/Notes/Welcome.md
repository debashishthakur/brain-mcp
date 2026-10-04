---
title: "Welcome"
type: note
modified: {{date}}
---
# Welcome

This folder is your second brain: plain Markdown notes that brain-mcp serves to Claude and any other MCP client. Open it as a vault in Obsidian, or edit the files in any text editor. Your AI sees a change within a second of you saving it.

## Start here

1. Fill in [[About {{name}}]]. It is the first thing every client reads.
2. Add notes about anything you want your AI to know: projects, decisions, how you do things.
3. Ask your AI "what do you know about me?"

## Where things go

- `Notes/` is for notes you write. Your AI can create and edit notes here too when you ask it to.
- `Captures/` is where your AI saves facts you ask it to remember and documents you ask it to keep.
- `Private/` is hidden from any connection without the `brain:private` permission.

## Linking notes

Put a note's title in double square brackets to link to it, the way this page links to your profile. Your AI follows those links to find related notes.

To start a project, create a note with `type: hub` in its frontmatter. Notes whose `project` field links to that hub become part of the project, and your AI can get a briefing on all of it in one call.
