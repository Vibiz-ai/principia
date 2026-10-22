---
id: n-nwdun00001
title: Dunning
type: concept
company: "[[Northwind]]"
created: 2026-09-18
modified: 2026-09-18
---
# Dunning
Retrying failed card payments and reminding customers before an account is suspended.

## Observations
- [convention] Retry failed payments 3 times over 7 days, then suspend the workspace (user, 2026-09-18) ^f-dun0000001
- [fact] Reminder emails go out through Postmark (user, 2026-09-18) ^f-dun0000002

## Relations
- part_of [[billing-worker]] ^r-dun0000001
- relates_to [[Churn]] ^r-dun0000002
