---
id: n-nwcen00001
title: Money as integer cents
type: convention
company: "[[Northwind]]"
created: 2026-09-11
modified: 2026-09-11
---
# Money as integer cents
Store every money amount as integer cents with a currency code. Never use floats for prices, totals or tax.

## Observations
- [convention] Amount columns are BIGINT cents plus a 3-letter currency column (user, 2026-09-11) ^f-cen0000001
- [convention] Round only at display time, half-even (user, 2026-09-11) ^f-cen0000002

## Relations
- relates_to [[Tax engine]] ^r-cen0000001
