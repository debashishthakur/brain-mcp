---
title: "Restore the ledger database"
type: runbook
project: "[[Harbor Ledger]]"
topics:
  - "[[PostgreSQL]]"
  - "[[Backups]]"
related:
  - "[[Home server facts]]"
  - "[[Use PostgreSQL for the ledger]]"
tags:
  - project/harbor-ledger
  - type/runbook
modified: 2026-09-14
---
# Restore the ledger database

Use this when the `ledger` schema is corrupted, a migration went wrong, or the home server disk has been replaced. Last tested end to end on 2026-09-14; a full restore took about six minutes.

## Before you start

- The nightly dump is made by `pg_dump --format=custom` at 02:30 and shipped off the box by restic. See [[Home server facts]] for where the repository lives.
- You need the restic repository password. It is in the password manager under "restic home server". Export it as `RESTIC_PASSWORD=<from the password manager>`; never paste it into a note.
- Stop the importer timer first so nothing writes during the restore: `systemctl stop harbor-import.timer`.

## Steps

1. List snapshots and pick the newest one from before the problem: `restic snapshots --tag pg-dump`.
2. Restore the dump file to a scratch folder: `restic restore <snapshot-id> --target /tmp/ledger-restore --include /var/backups/pg/ledger.dump`.
3. Recreate the schema in place: `pg_restore --clean --if-exists --schema=ledger --dbname=household /tmp/ledger-restore/var/backups/pg/ledger.dump`.
4. Check row counts against the snapshot date: `select count(*), max(booking_date) from ledger.transactions;`.
5. Start the importer again: `systemctl start harbor-import.timer`. The fingerprint check means re-importing the last few statements is safe.

## If it fails

- `role "importer" does not exist`: the server was rebuilt. Run `make roles` in the repo before step 3.
- Restic says the repository is locked: another backup is running. Wait, or run `restic unlock` if no backup process exists.
