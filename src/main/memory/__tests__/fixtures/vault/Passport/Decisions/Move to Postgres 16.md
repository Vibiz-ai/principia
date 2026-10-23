---
id: n-nwpg000001
title: Move to Postgres 16
type: decision
company: "[[Northwind]]"
created: 2026-09-20
modified: 2026-10-08
---
# Move to Postgres 16
Upgrade the main database from Postgres 13 to 16 before the Q4 invoice peak.

## Observations
- [decision] Upgrade during the November maintenance window (user, 2026-09-20) ^f-pg00000001
- [gotcha] pg_dump of the audit table takes 40 minutes; use logical replication for the cutover (claude run#55, 2026-10-08) ^f-pg00000002

## Relations
- decided_by [[Bruno Costa]] ^r-pg00000001
- relates_to [[billing-worker]] ^r-pg00000002
