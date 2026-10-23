---
id: n-nwaut00001
title: Auth service
type: component
company: "[[Northwind]]"
created: 2026-09-19
modified: 2026-09-19
---
# Auth service
Sessions, single sign-on and API tokens for the web app.

## Observations
- [fact] SAML single sign-on is only enabled for Enterprise Plan workspaces (user, 2026-09-19) ^f-aut0000001
- [gotcha] API tokens are hashed with argon2 and cannot be shown again (user, 2026-09-19) ^f-aut0000002

## Relations
- part_of [[northwind-web]] ^r-aut0000001
