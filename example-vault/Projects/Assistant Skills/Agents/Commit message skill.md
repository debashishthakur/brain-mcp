---
title: "Commit message skill"
type: agent
project: "[[Assistant Skills]]"
topics:
  - "[[Git]]"
  - "[[Writing]]"
related:
  - "[[Writing style]]"
tags:
  - project/assistant-skills
  - type/agent
modified: 2026-09-12
---
# Commit message skill

When asked to commit, write the message in Ines's format: a summary line of at most 60 characters in the imperative mood, prefixed with the area it touches, then a blank line and a short body that says why.

## Format

```
importer: skip rows whose fingerprint already exists

Re-importing a statement doubled every amount. Rows are now
fingerprinted on account, date, amount and description.
```

## Rules

- Area prefixes in use: `importer`, `web`, `rules`, `listener`, `digest`, `infra`, `docs`.
- The body explains the reason, not the diff. Wrap at 72 characters.
- Reference an issue with `Refs #12` on the last line when there is one.
- Follow [[Writing style]]: no em dashes, no filler.
