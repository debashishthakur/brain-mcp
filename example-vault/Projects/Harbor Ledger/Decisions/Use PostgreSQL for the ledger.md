---
title: "Use PostgreSQL for the ledger"
type: decision
project: "[[Harbor Ledger]]"
topics:
  - "[[PostgreSQL]]"
related:
  - "[[Restore the ledger database]]"
  - "[[Home server facts]]"
tags:
  - project/harbor-ledger
  - type/decision
status: accepted
modified: 2026-09-06
---
# Use PostgreSQL for the ledger

Harbor Ledger stores transactions in PostgreSQL on the home server instead of a SQLite file next to the importer. Decided on 2026-09-06.

## Context

The first prototype wrote to SQLite. Two things broke that: the importer and the web view both write (the web view lets me recategorise a transaction by hand), and a nightly import once collided with a manual edit and failed with `database is locked`. Money amounts were also stored as floats, which produced a 0.01 drift in one monthly total.

## Options considered

1. Keep SQLite, turn on WAL mode and retry on lock. Cheapest, but the float problem stays unless every amount becomes integer cents.
2. PostgreSQL on the home server. Concurrent writers are a non-issue, `numeric(12,2)` is exact, and the server is already backed up every night.
3. A hosted database. Rejected: bank data should not leave the house.

## Decision

Option 2. Amounts are `numeric(12,2)`, every table lives in the `ledger` schema, and the importer connects with a role that can insert but not drop.

## Consequences

- Restores now go through `pg_restore`, written up in [[Restore the ledger database]].
- Running the tests needs a throwaway Postgres; the test suite starts one in Docker.
- [[Kestrel]] later reused the same instance with its own schema.
