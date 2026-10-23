---
id: n-nwtax00001
title: Tax engine
type: component
company: "[[Northwind]]"
created: 2026-09-19
modified: 2026-09-19
---
# Tax engine
Computes VAT and US sales tax for every invoice line.

## Observations
- [gotcha] EU reverse charge applies when the buyer has a valid VAT number (user, 2026-09-19) ^f-tax0000001
- [convention] All tax math happens in integer cents (user, 2026-09-19) ^f-tax0000002

## Relations
- part_of [[billing-worker]] ^r-tax0000001
- depends_on [[Money as integer cents]] ^r-tax0000002
