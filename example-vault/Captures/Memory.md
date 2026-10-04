---
title: "Memory"
type: note
project: "[[Assistant Memory]]"
tags:
  - captured
  - memory
captured: 2026-09-12
modified: 2026-09-21
---

# Memory

Facts recorded through the second-brain MCP. Newest at the bottom.

## 2026-09-12 19:40 · feedback

Use uv for Python virtual environments and pnpm for Node packages in Ines's own repositories. Never pip install into the system interpreter.

**Why:** The home server once broke after a global pip install upgraded a Debian-managed package.

**How to apply:** Start Python work with `uv sync`; start Node work with `pnpm install`.

*via mcp:stdio:ines*

## 2026-09-21 08:05 · project

Kestrel detections older than 18 months are archived to Parquet files on the home server, not deleted.

**Why:** Year-on-year comparisons of spring arrivals need the old rows.

**How to apply:** Any cleanup job for the kestrel schema must export before it deletes.

*via mcp:stdio:ines*
