---
id: n-nwbil00001
title: billing-worker
type: repo
repo_id: repo_nwbill0001
company: "[[Northwind]]"
created: 2026-09-10
modified: 2026-09-21
---
# billing-worker
Background jobs: the nightly invoice run, Dunning, Ledger Sync and tax calculation.

## Observations
- [fact] The invoice run starts at 00:05 UTC every day (user, 2026-09-10) ^f-bil0000001
- [gotcha] Payment webhooks are verified before any JSON parsing (claude run#12, 2026-09-21) ^f-bil0000002

## Relations
- part_of [[Northwind]] ^r-bil0000001
- uses [[Stripe]] ^r-bil0000002
- uses [[Postmark]] ^r-bil0000003
- uses [[Tax engine]] ^r-bil0000004
