---
title: "Run bird detection on the device"
type: decision
project: "[[Kestrel]]"
topics:
  - "[[Raspberry Pi]]"
  - "[[Privacy]]"
related:
  - "[[Kestrel progress 2026-09]]"
tags:
  - project/kestrel
  - type/decision
status: accepted
modified: 2026-09-03
---
# Run bird detection on the device

Kestrel classifies bird calls on the Raspberry Pi itself. Raw audio is never uploaded anywhere. Decided on 2026-09-03.

## Context

The microphone sits on a fence that faces the neighbours' patio. A cloud classification API would have meant streaming garden audio, including conversations, to a third party. The free tier of the API I tried also capped requests at a few thousand a day, and a dawn chorus produces more windows than that.

## Options considered

1. Stream audio to a cloud classification API. Best accuracy, worst privacy, ongoing cost.
2. Record locally, upload clips once a day for batch classification. Still ships audio off site.
3. Run a quantised TensorFlow Lite classifier on the Pi 5 and keep only the label, confidence and timestamp.

## Decision

Option 3. The Pi keeps a rolling 60-second audio buffer in memory and writes nothing to disk except detection rows. Inference on a three-second window takes about 120 ms, well inside the budget.

## Consequences

- Accuracy is a little lower than the cloud model, so the confidence threshold matters. Tuning notes are in [[Kestrel progress 2026-09]].
- Model updates are a manual copy of a new `.tflite` file.
- Nothing about this project needs to touch the internet except the weekly digest email.
