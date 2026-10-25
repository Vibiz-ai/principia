/**
 * DIAGRAMS.md §3: the agent's diagram note. One short prompt module, added once per conversation through the
 * artifacts hint (claude: --append-system-prompt on new conversations only, so a --resume turn never repeats it).
 * It says when a diagram helps and the format with one tiny example; the full schema lives in shared/diagram.ts.
 */
export const DIAGRAM_HINT =
  'Diagrams: when structure reads better drawn (architecture, flows, dependencies, plans), add one ```principia-graph block of JSON and Principia draws it. Not for every answer. ' +
  'E.g. {"title":"Signup","nodes":[{"id":"web","kind":"client","label":"Web"},{"id":"db","kind":"database","label":"Users"}],"edges":[{"from":"web","to":"db","kind":"data"}]}. ' +
  'Node kinds: client service database queue storage external person function file decision note task milestone metric group. Edge kinds: flow call data async depends blocks. ' +
  'Optional: detail (markdown), status (task only: todo in_progress in_review blocked done), group, direction "down", steps. No coordinates.'
