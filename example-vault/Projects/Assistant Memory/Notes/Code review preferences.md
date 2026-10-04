---
title: "Code review preferences"
type: note
project: "[[Assistant Memory]]"
topics:
  - "[[Python]]"
  - "[[Testing]]"
related:
  - "[[About Ines]]"
tags:
  - project/assistant-memory
  - memory/feedback
modified: 2026-09-16
---
# Code review preferences

How Ines wants code written and reviewed when an assistant works in her repositories.

- Keep each change small enough to review in one sitting. If a task needs more, propose the split first.
- Write or update the failing test before the fix, and show it failing.
- Do not add a new dependency without asking. Say what it replaces and what it costs.
- Python: type hints on every public function, `ruff` clean, no bare `except`.
- Point out anything you were unsure about at the end instead of hiding it in the diff.

**Why:** In August an assistant rewrote the whole importer module to fix one parser bug, and the review took longer than the bug.

**How to apply:** Before editing, state the smallest change that fixes the problem and the test that proves it. Ask before touching files outside that scope.
