---
title: "PostgreSQL"
type: concept
aliases:
  - Postgres
appears-in:
  - "[[Harbor Ledger]]"
  - "[[Kestrel]]"
tags:
  - concept
modified: 2026-09-20
---
# PostgreSQL

The relational database both side projects share. One instance runs on the home server, with one schema per project.

## Where it shows up

- [[Harbor Ledger]] stores every imported transaction in it; see [[Use PostgreSQL for the ledger]] for why.
- [[Kestrel]] writes bird detections to its own schema in the same instance.
- [[Restore the ledger database]] covers getting it back from a restic snapshot.
