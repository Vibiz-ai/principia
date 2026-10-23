---
id: n-nwcut00001
title: Invoice cutoff timezone
type: gotcha
company: "[[Northwind]]"
created: 2026-09-13
modified: 2026-10-08
---
# Invoice cutoff timezone
The invoice run uses midnight UTC, so customers in Asia and the Americas see invoices dated a day early or late.

## Observations
- [gotcha] Cutoff is 00:00 UTC, not the customer's local midnight (user, 2026-09-13) ^f-cut0000001
- [todo] Store each customer's timezone and cut off per timezone (claude run#58, 2026-10-08) ^f-cut0000002

## Relations
- part_of [[billing-worker]] ^r-cut0000001
