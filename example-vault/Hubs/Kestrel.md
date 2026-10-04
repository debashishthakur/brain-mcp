---
title: "Kestrel"
type: hub
topics:
  - "[[Raspberry Pi]]"
  - "[[PostgreSQL]]"
tags:
  - hub
  - project/kestrel
note-count: 2
last-touched: 2026-09-29
modified: 2026-09-29
---
# Kestrel

A Raspberry Pi in the back garden that listens for bird calls, identifies the species on the device, and logs each detection to the home server.

[[Run bird detection on the device]] explains why audio never leaves the garden, and [[Kestrel progress 2026-09]] tracks the hardware and tuning work.

## Shape of the system

- A Raspberry Pi 5 with a USB measurement microphone in a weatherproof box on the fence.
- `listener/`: records three-second windows, runs a quantised TensorFlow Lite classifier, keeps detections above the confidence threshold.
- Detections are written to the `kestrel` schema in the same PostgreSQL instance that [[Harbor Ledger]] uses.
- A Sunday job sends a weekly digest of species counts.
