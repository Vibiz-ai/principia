---
id: n-nwled00001
title: Ledger Sync
type: product
company: "[[Northwind]]"
created: 2026-09-08
modified: 2026-10-05
---
# Ledger Sync
Two-way sync between Northwind invoices and [[QuickBooks]]. Runs inside billing-worker every 15 minutes.

## Observations
- [gotcha] QuickBooks rate-limits to 500 requests per minute per realm (claude run#47, 2026-10-05) ^f-led0000001
- [fact] Available on Growth Plan and Enterprise Plan (user, 2026-09-08) ^f-led0000002

## Relations
- built_in [[billing-worker]] ^r-led0000001
- integrates_with [[QuickBooks]] ^r-led0000002
