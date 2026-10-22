---
id: n-nwstr00001
title: Stripe
type: product
company: "[[Northwind]]"
created: 2026-09-07
modified: 2026-09-07
---
# Stripe
Payment provider for card payments and payouts.

## Observations
- [fact] Account is in EU mode; payouts every Tuesday (user, 2026-09-07) ^f-str0000001
- [convention] All card charges go through billing-worker, never from the browser (user, 2026-09-07) ^f-str0000002

## Relations
- integrates_with [[billing-worker]] ^r-str0000001
