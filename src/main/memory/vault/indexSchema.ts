/**
 * <userData>/passport-index.db schema (PASSPORT.md §6.1). One file for every company: `company_id` is on every row
 * and every query binds it. WAL with its own `user_version`; only main migrates.
 *
 * Derived tables are rebuilt per company from the vault files. Their keys are scoped by company
 * (`PRIMARY KEY (company_id, id)`): a copied vault, or `h:<path>` keys of two vaults with the same layout, must
 * never collide across companies. Two kinds of derived rows outlive a rebuild because the files no longer
 * carry them: notes whose file was deleted outside Principia (`removed_at` set) and fact rows marked
 * `removed_external`. They back the Restore / Accept removal review item and keep the content reachable.
 *
 * Operational tables (grants, events, proposals, conflicts, layout, op replays, settings) are not derivable and
 * survive every rebuild.
 */
export const INDEX_SCHEMA_VERSION = 1
/** Bump to force a full rebuild of every vault when the shared grammar changes what it extracts. */
export const PARSER_VERSION = 1
/** `.principia/vault.json` formatVersion. */
export const VAULT_FORMAT_VERSION = 1

export const INDEX_PRAGMAS = ['journal_mode = WAL', 'busy_timeout = 5000', 'synchronous = NORMAL']

/** Tables a rebuild clears per company (minus the surviving removed rows, see above). */
export const DERIVED_TABLES = ['mem_alias', 'mem_link', 'mem_tag', 'mem_fts_map', 'mem_fact', 'mem_note'] as const

export const INDEX_DDL_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS mem_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- derived --------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mem_vault (
  company_id        TEXT PRIMARY KEY,
  root              TEXT NOT NULL,
  format_version    INTEGER NOT NULL DEFAULT ${VAULT_FORMAT_VERSION},
  parser_version    INTEGER NOT NULL DEFAULT 0,
  last_full_scan_at TEXT,
  state             TEXT NOT NULL DEFAULT 'missing' CHECK (state IN ('missing','seeding','indexing','ready','readonly','error'))
);

CREATE TABLE IF NOT EXISTS mem_note (
  id                  TEXT NOT NULL,
  company_id          TEXT NOT NULL,
  path                TEXT NOT NULL,
  path_norm           TEXT NOT NULL,
  basename_norm       TEXT NOT NULL,
  title               TEXT NOT NULL,
  norm_title          TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'note',
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  pinned              INTEGER NOT NULL DEFAULT 0,
  summary             TEXT NOT NULL DEFAULT '',
  frontmatter_json    TEXT NOT NULL DEFAULT '{}',
  repo_id             TEXT,
  repo_ids_json       TEXT NOT NULL DEFAULT '[]',
  hash                TEXT NOT NULL,
  mtime_ms            INTEGER NOT NULL DEFAULT 0,
  size                INTEGER NOT NULL DEFAULT 0,
  created             TEXT,
  modified            TEXT,
  parse_warnings_json TEXT NOT NULL DEFAULT '[]',
  indexed_at          TEXT NOT NULL,
  removed_at          TEXT,
  PRIMARY KEY (company_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_note_path ON mem_note(company_id, path_norm);
CREATE INDEX IF NOT EXISTS mem_note_basename ON mem_note(company_id, basename_norm);
CREATE INDEX IF NOT EXISTS mem_note_title ON mem_note(company_id, norm_title);

CREATE VIEW IF NOT EXISTS mem_entity AS
  SELECT id, company_id, title AS name, norm_title AS norm_name, type, summary,
         ifnull(created, indexed_at) AS created_at, ifnull(modified, indexed_at) AS updated_at
  FROM mem_note WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS mem_alias (
  company_id TEXT NOT NULL,
  note_id    TEXT NOT NULL,
  alias      TEXT NOT NULL,
  norm_alias TEXT NOT NULL,
  PRIMARY KEY (company_id, note_id, norm_alias)
);
CREATE INDEX IF NOT EXISTS mem_alias_norm ON mem_alias(company_id, norm_alias);

CREATE TABLE IF NOT EXISTS mem_fact (
  id            TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  block_id      TEXT,
  line          INTEGER NOT NULL,
  section       TEXT NOT NULL CHECK (section IN ('obs','history')),
  category      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('fact','decision','convention','gotcha','other')),
  text          TEXT NOT NULL,
  text_hash     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','pending','superseded','invalid','removed_external')),
  superseded_by TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  reviewed      INTEGER NOT NULL DEFAULT 0,
  actor         TEXT NOT NULL DEFAULT 'user',
  run_id        TEXT,
  session_id    TEXT,
  date          TEXT,
  repo_id       TEXT,
  -- a copied line whose block id another note owns: the copy is keyed softly and never targeted (smallest path owns)
  dup_of        TEXT,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS mem_fact_dup ON mem_fact(company_id, dup_of) WHERE dup_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_fact_note ON mem_fact(company_id, note_id, status);
CREATE INDEX IF NOT EXISTS mem_fact_hash ON mem_fact(company_id, text_hash);
CREATE INDEX IF NOT EXISTS mem_fact_block ON mem_fact(company_id, block_id) WHERE block_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mem_link (
  id              TEXT NOT NULL,
  company_id      TEXT NOT NULL,
  from_note       TEXT NOT NULL,
  from_fact       TEXT,
  line            INTEGER NOT NULL,
  rel             TEXT NOT NULL,
  norm_rel        TEXT NOT NULL,
  origin          TEXT NOT NULL CHECK (origin IN ('body','relation','property','bullet','fact')),
  to_note         TEXT,
  to_text         TEXT NOT NULL,
  to_norm         TEXT NOT NULL,
  to_heading      TEXT,
  to_block        TEXT,
  display         TEXT,
  embed           INTEGER NOT NULL DEFAULT 0,
  ambiguous       INTEGER NOT NULL DEFAULT 0,
  candidates_json TEXT,
  context         TEXT,
  block_id        TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','invalid')),
  actor           TEXT,
  run_id          TEXT,
  date            TEXT,
  dup_of          TEXT,
  PRIMARY KEY (company_id, id)
);
CREATE INDEX IF NOT EXISTS mem_link_dup ON mem_link(company_id, dup_of) WHERE dup_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_link_to ON mem_link(company_id, to_note);
CREATE INDEX IF NOT EXISTS mem_link_ghost ON mem_link(company_id, to_norm) WHERE to_note IS NULL;
CREATE INDEX IF NOT EXISTS mem_link_norm ON mem_link(company_id, to_norm);
CREATE INDEX IF NOT EXISTS mem_link_from ON mem_link(company_id, from_note);
CREATE INDEX IF NOT EXISTS mem_link_block ON mem_link(company_id, block_id) WHERE block_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS mem_relation AS
  SELECT id, company_id, from_note AS from_id, to_note AS to_id, rel AS type, norm_rel AS norm_type, to_text, to_norm,
         context, block_id, status, actor, run_id, date, line
  FROM mem_link WHERE origin = 'relation';

CREATE TABLE IF NOT EXISTS mem_tag (
  company_id  TEXT NOT NULL,
  note_id     TEXT NOT NULL,
  fact_id     TEXT,
  tag_norm    TEXT NOT NULL,
  tag_display TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('frontmatter','body')),
  line        INTEGER
);
CREATE INDEX IF NOT EXISTS mem_tag_norm ON mem_tag(company_id, tag_norm);
CREATE INDEX IF NOT EXISTS mem_tag_note ON mem_tag(company_id, note_id);

-- FTS rows are addressed through mem_fts_map (rowid shared with mem_fts) so a note's rows can be deleted by index
-- instead of scanning the UNINDEXED columns.
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  ref_kind UNINDEXED, ref_id UNINDEXED, company_id UNINDEXED, note_id UNINDEXED,
  title, body, tokenize = "porter unicode61 remove_diacritics 2 tokenchars '_'");
CREATE TABLE IF NOT EXISTS mem_fts_map (
  rowid      INTEGER PRIMARY KEY,
  company_id TEXT NOT NULL,
  note_id    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mem_fts_map_note ON mem_fts_map(company_id, note_id);

-- operational ------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mem_grant (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  vault_path    TEXT,
  spool_dir     TEXT,
  mode          TEXT NOT NULL CHECK (mode IN ('read','read-write')),
  adapter       TEXT NOT NULL,
  transport     TEXT NOT NULL CHECK (transport IN ('mcp','inject')),
  profile_id    TEXT, profile_name TEXT, model TEXT,
  repo_id       TEXT, repo_name TEXT,
  run_id        TEXT, run_title TEXT, workflow_id TEXT,
  step_id       TEXT, node_id TEXT, node_label TEXT,
  session_id    TEXT,
  writes        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  closed_at     TEXT
);
CREATE INDEX IF NOT EXISTS mem_grant_company ON mem_grant(company_id, created_at);
CREATE INDEX IF NOT EXISTS mem_grant_run ON mem_grant(run_id);
CREATE INDEX IF NOT EXISTS mem_grant_session ON mem_grant(session_id);

CREATE TABLE IF NOT EXISTS mem_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  company_id  TEXT NOT NULL,
  op          TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('note','fact','relation','alias','property','link','memory')),
  target_id   TEXT NOT NULL,
  entity_id   TEXT,
  path        TEXT,
  block_id    TEXT,
  actor       TEXT NOT NULL,
  grant_id    TEXT, run_id TEXT, op_id TEXT,
  base_hash   TEXT, new_hash TEXT,
  before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS mem_event_company ON mem_event(company_id, seq);
CREATE INDEX IF NOT EXISTS mem_event_entity ON mem_event(company_id, entity_id, seq);
CREATE INDEX IF NOT EXISTS mem_event_run ON mem_event(run_id, seq);
CREATE INDEX IF NOT EXISTS mem_event_block ON mem_event(company_id, block_id);

CREATE TABLE IF NOT EXISTS mem_proposal (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '[]',
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  score            REAL NOT NULL DEFAULT 0,
  source           TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  base_hashes_json TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','stale')),
  created_at       TEXT NOT NULL,
  decided_at       TEXT,
  decided_by       TEXT,
  UNIQUE (company_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS mem_proposal_open ON mem_proposal(company_id, status, kind);

CREATE TABLE IF NOT EXISTS mem_conflict (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  path         TEXT NOT NULL,
  op_json      TEXT NOT NULL,
  reason       TEXT NOT NULL,
  base_hash    TEXT,
  current_hash TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS mem_conflict_open ON mem_conflict(company_id, resolved_at);

CREATE TABLE IF NOT EXISTS mem_layout (
  company_id TEXT NOT NULL,
  note_id    TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, note_id)
);

-- writer idempotency (§6.4): opId = grantId + MCP call id; a replay returns the first result
CREATE TABLE IF NOT EXISTS mem_op (
  company_id  TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (company_id, op_id)
);

-- per-company knobs (suggestion acceptance rates, LLM caps, §12)
CREATE TABLE IF NOT EXISTS mem_settings (
  company_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, key)
);
`
