---
title: "Kestrel progress 2026-09"
type: progress
project: "[[Kestrel]]"
topics:
  - "[[Raspberry Pi]]"
  - "[[PostgreSQL]]"
related:
  - "[[Run bird detection on the device]]"
tags:
  - project/kestrel
  - type/progress
modified: 2026-09-29
---
# Kestrel progress 2026-09

## 2026-09-29

- Weekly digest works: a Sunday 08:00 cron job emails species counts for the week, top five first, with any species never seen before called out at the top.
- Detections now go to the `kestrel` schema on the home server PostgreSQL instead of a local SQLite file, so the digest query runs on the server.

## 2026-09-20

- Wind was the biggest source of false positives: gusts were labelled as wood pigeon about forty times a day. Two fixes together solved most of it. A foam windshield on the microphone, and a high-pass filter at 150 Hz before inference.
- Raised the confidence threshold from 0.5 to 0.7. False positives dropped from roughly 60 a day to 5, and the only real species lost were faint distant calls.

## 2026-09-11

- Swapped the cheap USB lapel mic for a measurement microphone. The old one clipped on loud blackbird song, which the model then misread.
- The weatherproof box gets warm in direct sun; the Pi throttled at 82 °C one afternoon. Added a small shade and a heatsink case, now peaks at 64 °C.

## Next

- Night mode: owls call at a much lower volume, so try a separate threshold between 22:00 and 05:00.
