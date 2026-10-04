---
title: "Home server facts"
type: note
project: "[[Assistant Memory]]"
topics:
  - "[[PostgreSQL]]"
  - "[[Backups]]"
related:
  - "[[Restore the ledger database]]"
  - "[[Harbor Ledger]]"
  - "[[Kestrel]]"
tags:
  - project/assistant-memory
  - memory/project
modified: 2026-09-22
---
# Home server facts

Facts about the machine that hosts Ines's side projects, so nobody has to ask again.

- Hostname `pantry`, an Intel NUC under the stairs running Debian 12.
- PostgreSQL 16 holds the `household` database, with the `ledger` schema for [[Harbor Ledger]] and the `kestrel` schema for [[Kestrel]].
- Nightly at 02:30: `pg_dump --format=custom` to `/var/backups/pg/`, then restic ships it to a Backblaze B2 bucket. Snapshots are kept for 30 days.
- The restic and database passwords live in her password manager, never in the repo or the vault.
- SSH only from the home network; nothing on the box is exposed to the internet.

**Why:** Every restore or migration question starts with "where does the database live and where are the backups".

**How to apply:** Assume this layout when writing scripts or runbooks for either project, and point to [[Restore the ledger database]] for recovery.
