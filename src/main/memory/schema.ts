/**
 * <userData>/memory.db schema (docs/MEMORY.md §2 with PO1–PO10). Separate from hive.db: main AND every hivemem MCP
 * server process write it (WAL, BEGIN IMMEDIATE per write). Only main migrates (PRAGMA user_version).
 */
export const MEMORY_SCHEMA_VERSION = 1

export const MEMORY_PRAGMAS = ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000', 'synchronous = NORMAL']

export const MEMORY_DDL_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS mem_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS mem_grant (
  id            TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS mem_grant_run ON mem_grant(run_id);
CREATE INDEX IF NOT EXISTS mem_grant_session ON mem_grant(session_id);

CREATE TABLE IF NOT EXISTS mem_entity (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT,
  name        TEXT NOT NULL,
  norm_name   TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'concept',
  summary     TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL CHECK (actor IN ('agent','user')),
  grant_id    TEXT REFERENCES mem_grant(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_entity_name ON mem_entity(ifnull(repo_id,''), norm_name);

CREATE TABLE IF NOT EXISTS mem_alias (
  entity_id   TEXT NOT NULL REFERENCES mem_entity(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  norm_alias  TEXT NOT NULL,
  PRIMARY KEY (entity_id, norm_alias)
);
CREATE INDEX IF NOT EXISTS mem_alias_norm ON mem_alias(norm_alias);

CREATE TABLE IF NOT EXISTS mem_fact (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL REFERENCES mem_entity(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  text_hash      TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','decision','convention','gotcha')),
  scope          TEXT NOT NULL CHECK (scope IN ('project','global')),
  repo_id        TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','invalid')),
  reviewed       INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  invalidated_at TEXT,
  invalid_reason TEXT,
  superseded_by  TEXT REFERENCES mem_fact(id) ON DELETE SET NULL,
  actor          TEXT NOT NULL CHECK (actor IN ('agent','user')),
  grant_id       TEXT REFERENCES mem_grant(id) ON DELETE SET NULL,
  edited_by_user INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mem_fact_entity ON mem_fact(entity_id, status);
CREATE INDEX IF NOT EXISTS mem_fact_scope  ON mem_fact(scope, repo_id, status);
CREATE INDEX IF NOT EXISTS mem_fact_grant  ON mem_fact(grant_id);
CREATE INDEX IF NOT EXISTS mem_fact_superseded ON mem_fact(superseded_by);
CREATE UNIQUE INDEX IF NOT EXISTS mem_fact_dedup ON mem_fact(entity_id, text_hash) WHERE status IN ('active','pending');

CREATE TABLE IF NOT EXISTS mem_relation (
  id             TEXT PRIMARY KEY,
  from_id        TEXT NOT NULL REFERENCES mem_entity(id) ON DELETE CASCADE,
  to_id          TEXT NOT NULL REFERENCES mem_entity(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  norm_type      TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('project','global')),
  repo_id        TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','invalid')),
  reviewed       INTEGER NOT NULL DEFAULT 0,
  invalidated_at TEXT, invalid_reason TEXT, superseded_by TEXT,
  actor          TEXT NOT NULL CHECK (actor IN ('agent','user')),
  grant_id       TEXT REFERENCES mem_grant(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_relation_dedup ON mem_relation(from_id, to_id, norm_type) WHERE status IN ('active','pending');
CREATE INDEX IF NOT EXISTS mem_relation_to ON mem_relation(to_id);
CREATE INDEX IF NOT EXISTS mem_relation_grant ON mem_relation(grant_id);

CREATE TABLE IF NOT EXISTS mem_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('create','update','invalidate','restore','approve','pin','unpin',
                                          'delete','merge','to_global','revert_run','pause')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('entity','fact','relation','alias','memory')),
  target_id   TEXT NOT NULL,
  entity_id   TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('agent','user','system')),
  grant_id    TEXT, run_id TEXT,
  before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS mem_event_entity ON mem_event(entity_id, seq);
CREATE INDEX IF NOT EXISTS mem_event_run    ON mem_event(run_id, seq);
CREATE INDEX IF NOT EXISTS mem_event_target ON mem_event(target_id);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  target_kind UNINDEXED, target_id UNINDEXED, entity_id UNINDEXED,
  name, body, tokenize = "porter unicode61 remove_diacritics 2 tokenchars '_'");
`
