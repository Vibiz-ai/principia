---
id: n-nwwhk00001
title: Stripe webhook raw body
type: gotcha
company: "[[Northwind]]"
created: 2026-09-21
modified: 2026-09-22
---
# Stripe webhook raw body
Webhook signatures cover the exact request bytes, so parsing JSON before verifying breaks the signature check.

## Observations
- [gotcha] Mount the webhook route with a raw body parser before the JSON middleware (claude run#12, 2026-09-21) ^f-whk0000001
- [gotcha] Signature verification fails when clock skew is over 5 minutes (user, 2026-09-22) ^f-whk0000002

## Relations
- caused_by [[Stripe]] ^r-whk0000001
- part_of [[billing-worker]] ^r-whk0000002
