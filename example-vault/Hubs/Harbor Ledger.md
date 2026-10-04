---
title: "Harbor Ledger"
type: hub
topics:
  - "[[PostgreSQL]]"
  - "[[Python]]"
tags:
  - hub
  - project/harbor-ledger
note-count: 3
last-touched: 2026-09-27
modified: 2026-09-27
---
# Harbor Ledger

A self-hosted importer that turns bank and card CSV exports into one categorised ledger in PostgreSQL, with a small web view for monthly spending.

This hub is the entry point for the project. [[Use PostgreSQL for the ledger]] records why the store is Postgres and not SQLite, [[Harbor Ledger progress 2026-09]] has the latest work, and [[Restore the ledger database]] is the runbook for bringing the database back from a backup.

## Shape of the system

- `importer/`: one parser per bank export format, all producing the same `Transaction` record.
- `rules.yaml`: categorisation rules, matched top to bottom, first match wins.
- `web/`: a read-only FastAPI app that renders monthly totals per category.
- The database lives on the home server described in [[Home server facts]].
