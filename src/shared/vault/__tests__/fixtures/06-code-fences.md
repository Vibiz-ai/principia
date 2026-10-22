---
id: n-bbbbbbbbbb
title: Code note
type: gotcha
---
# Code note

```ts
const link = '[[Not A Link]]' // #nottag
- [fact] not an observation ^f-zzzzzzzzzz
```

~~~
[[Also Not]]
~~~

````md
```
[[Still Not]]
```
````

Inline `[[Nope]]` and ``code with ` [[Nope2]]`` but [[Yes Link]] here.

- [gotcha] Webhooks need the raw body, not `JSON.parse([[x]])` #stripe ^f-cccccccccc
