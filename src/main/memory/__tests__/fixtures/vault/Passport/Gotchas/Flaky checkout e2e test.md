---
id: n-nwflk00001
title: Flaky checkout e2e test
type: gotcha
company: "[[Northwind]]"
created: 2026-10-10
modified: 2026-10-10
---
# Flaky checkout e2e test
The checkout end-to-end test fails about 1 in 10 CI runs because Stripe test mode is slow.

## Observations
- [gotcha] Retry once with a 30 s timeout; the failure is a payment test-mode delay, not a bug (claude run#61, 2026-10-10) ^f-flk0000001

## Relations
- part_of [[northwind-web]] ^r-flk0000001
