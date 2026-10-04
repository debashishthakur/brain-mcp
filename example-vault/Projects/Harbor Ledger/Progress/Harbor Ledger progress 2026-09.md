---
title: "Harbor Ledger progress 2026-09"
type: progress
project: "[[Harbor Ledger]]"
topics:
  - "[[Python]]"
  - "[[PostgreSQL]]"
related:
  - "[[Use PostgreSQL for the ledger]]"
tags:
  - project/harbor-ledger
  - type/progress
modified: 2026-09-27
---
# Harbor Ledger progress 2026-09

## 2026-09-27

- The budget view is in. Each category gets a monthly limit in `budgets.yaml`, and the web view colours a row amber at 80% and red at 100%.
- Recategorising a transaction by hand now writes an override row instead of editing the original, so a re-import never undoes a manual fix.

## 2026-09-18

- Duplicate detection. Importing the same statement twice used to double every amount. Each transaction now gets a fingerprint: a SHA-256 of account, booking date, amount and the normalised description. The importer skips any row whose fingerprint already exists, and logs how many it skipped.
- Two real transactions with identical fingerprints (two coffees, same amount, same day) are kept apart by adding the row position within the statement to the hash.

## 2026-09-09

- Parsers for both banks are done. The credit card export uses semicolons and a comma decimal separator; the parser normalises both before building the record.
- Moved from SQLite to PostgreSQL, see [[Use PostgreSQL for the ledger]].

## Next

- Split transactions (one supermarket receipt, two categories).
- A yearly summary page.
