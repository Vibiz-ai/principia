/**
 * SQLite schema v1 for <userData>/hive.db (better-sqlite3). Normative: docs/CONTRACT.md section 3.
 * Conventions: snake_case, TEXT ids, ISO-UTC TEXT timestamps, JSON in TEXT (suffix _json), booleans INTEGER 0/1.
 * Write ownership: (M) = main, (E) = engine via EngineStore (implemented in main, called only by the engine).
 */
export const SCHEMA_VERSION = 2

export const PRAGMAS = ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000', 'synchronous = NORMAL']

export const DDL_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (               -- (M)
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (           -- (M) one row per Settings key, value = JSON
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (              -- (M)
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  path     TEXT NOT NULL UNIQUE,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (           -- (M)
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  adapter           TEXT NOT NULL CHECK (adapter IN ('claude','codex','cursor','gemini','shell')),
  model             TEXT,
  extra_args_json   TEXT NOT NULL DEFAULT '[]',
  permission_mode   TEXT NOT NULL DEFAULT 'bypass' CHECK (permission_mode IN ('default','bypass')),
  secret_names_json TEXT NOT NULL DEFAULT '["*"]',
  use_api_key_auth  INTEGER NOT NULL DEFAULT 0,   -- 0: strip adapter auth vars (ANTHROPIC_API_KEY / OPENAI_API_KEY)
  is_default        INTEGER NOT NULL DEFAULT 0,   -- seeded default profile for its adapter
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (           -- (M)
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  adapter       TEXT NOT NULL,
  repo_id       TEXT,
  cwd           TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','exited')),
  pid           INTEGER,
  cols          INTEGER NOT NULL,
  rows          INTEGER NOT NULL,
  exit_code     INTEGER,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  artifacts_dir TEXT NOT NULL,
  log_path      TEXT NOT NULL,
  from_run_id   TEXT,
  agent_session_id TEXT                          -- claude --session-id uuid; Restart = --resume
);
CREATE INDEX IF NOT EXISTS sessions_status ON sessions(status, started_at);

CREATE TABLE IF NOT EXISTS workflows (          -- (M)
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  inputs_json TEXT NOT NULL DEFAULT '[]',
  nodes_json  TEXT NOT NULL DEFAULT '[]',
  seed_key    TEXT UNIQUE,                       -- non-null for seeded workflows (never re-seeded once deleted)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (               -- (E)
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('prompt','workflow')),
  title          TEXT NOT NULL,
  target_json    TEXT NOT NULL,
  workflow_id    TEXT,
  workflow_json  TEXT,                           -- WorkflowDraft snapshot at start
  schedule_id    TEXT,
  parent_run_id  TEXT,
  trigger        TEXT NOT NULL CHECK (trigger IN ('manual','schedule','catchup','rerun')),
  status         TEXT NOT NULL CHECK (status IN ('queued','running','passed','failed','canceled')),
  reason         TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  ended_at       TEXT,
  artifacts_dir  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_status   ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS runs_schedule ON runs(schedule_id, created_at);
CREATE INDEX IF NOT EXISTS runs_workflow ON runs(workflow_id, created_at);

CREATE TABLE IF NOT EXISTS run_steps (          -- (E)
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  node_id           TEXT NOT NULL,
  node_type         TEXT NOT NULL CHECK (node_type IN ('agent','room','check','shell','prompt')),
  attempt           INTEGER NOT NULL DEFAULT 1,
  round             INTEGER,
  profile_id        TEXT,
  participant_label TEXT,
  adapter           TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  output            TEXT,
  verdict           TEXT CHECK (verdict IN ('PASS','FAIL')),
  exit_code         INTEGER,
  pid               INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed','canceled','skipped')),
  error             TEXT,
  source_step_ids_json TEXT NOT NULL DEFAULT '[]',
  agent_session_id  TEXT,
  log_path          TEXT NOT NULL,
  started_at        TEXT,
  ended_at          TEXT
);
CREATE INDEX IF NOT EXISTS run_steps_run ON run_steps(run_id, seq);

CREATE TABLE IF NOT EXISTS schedules (          -- config (M); fire-state columns marked (E)
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  target_json   TEXT NOT NULL,
  when_json     TEXT NOT NULL,
  preset_json   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,       -- (M) user toggle; (E) may set 0 for missed one-off
  last_fire_at  TEXT,                            -- (E)
  last_run_id   TEXT,                            -- (E)
  next_fire_at  TEXT,                            -- (E)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_events (    -- (E)
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('fired','skipped_overlap','missed','caught_up','error')),
  slot_at     TEXT NOT NULL,
  run_id      TEXT,
  message     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedule_events_sched ON schedule_events(schedule_id, created_at);

CREATE TABLE IF NOT EXISTS secrets (            -- (M) value only as safeStorage ciphertext
  name         TEXT PRIMARY KEY,
  label        TEXT NOT NULL DEFAULT '',
  cipher       BLOB NOT NULL,                     -- safeStorage.encryptString(value)
  masked       TEXT NOT NULL,                     -- "sk-…a1b2", computed at write time
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (          -- (M) index of <userData>/artifacts/**
  id         TEXT PRIMARY KEY,
  run_id     TEXT,
  session_id TEXT,
  path       TEXT NOT NULL UNIQUE,
  rel_path   TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  mtime      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_run     ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at);
`

/**
 * v1 -> v2 (docs/LIVE.md §2): live agent tree, activity events, asks; schedule skip marker; schedule_events kind
 * 'skipped' (CHECK change = table rebuild). Runs inside one transaction (db/index.ts).
 */
export const DDL_V2_TABLES = /* sql */ `
CREATE TABLE IF NOT EXISTS agents (             -- (E) steps + their subagents, (M) sessions + their subagents
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('session','step','subagent')),
  parent_id       TEXT REFERENCES agents(id) ON DELETE CASCADE,
  root_id         TEXT NOT NULL,
  session_id      TEXT, run_id TEXT, step_id TEXT,
  provider        TEXT NOT NULL,
  repo_id         TEXT, cwd TEXT NOT NULL,
  title           TEXT NOT NULL,
  agent_type      TEXT, external_id TEXT, tool_use_id TEXT, model TEXT,
  depth           INTEGER NOT NULL DEFAULT 0,
  background      INTEGER NOT NULL DEFAULT 0,
  attribution     TEXT NOT NULL DEFAULT 'exact' CHECK (attribution IN ('exact','timing','completion')),
  status          TEXT NOT NULL CHECK (status IN ('starting','working','needs_you','idle','done','failed','canceled')),
  needs           TEXT CHECK (needs IN ('permission','question','idle','trust')),
  seen            INTEGER NOT NULL DEFAULT 0,   -- A3: idle root whose pane was seen (not counted as Needs you)
  activity        TEXT, last_tool TEXT,
  tool_count      INTEGER NOT NULL DEFAULT 0,
  mem_reads       INTEGER NOT NULL DEFAULT 0,
  files_json      TEXT NOT NULL DEFAULT '[]',
  tokens_in       INTEGER, tokens_out INTEGER, cost_usd REAL,
  model_usage_json TEXT,
  report          TEXT,
  started_at      TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS agents_root    ON agents(root_id);
CREATE INDEX IF NOT EXISTS agents_status  ON agents(status, updated_at);
CREATE INDEX IF NOT EXISTS agents_run     ON agents(run_id);
CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id);
CREATE INDEX IF NOT EXISTS agents_step    ON agents(step_id);
CREATE INDEX IF NOT EXISTS agents_started ON agents(started_at);

CREATE TABLE IF NOT EXISTS agent_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('tool','text','thinking','status','ask','answer','error')),
  tool_use_id TEXT,
  name        TEXT,
  summary     TEXT NOT NULL,
  detail      TEXT,
  state       TEXT CHECK (state IN ('running','ok','error','denied'))
);
CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events(agent_id, seq);
CREATE INDEX IF NOT EXISTS agent_events_tool  ON agent_events(agent_id, tool_use_id);

CREATE TABLE IF NOT EXISTS asks (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  root_id      TEXT NOT NULL,
  session_id   TEXT, run_id TEXT, step_id TEXT,
  provider     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('permission','question','trust')),
  channel      TEXT NOT NULL CHECK (channel IN ('stdio','hook_gate','mcp','pty','acp')),
  gate_id      TEXT,
  title        TEXT NOT NULL, detail TEXT,
  tool_name    TEXT, tool_input_json TEXT, question TEXT,
  options_json TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL CHECK (status IN ('open','answered','expired','canceled')),
  answer_json  TEXT, answered_via TEXT CHECK (answered_via IN ('hive','terminal','timeout')),
  created_at   TEXT NOT NULL, answered_at TEXT, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS asks_open ON asks(status, created_at);
CREATE INDEX IF NOT EXISTS asks_root ON asks(root_id);
`

/** schedule_events rebuilt with the v2 CHECK (adds 'skipped'). */
export const DDL_V2_SCHEDULE_EVENTS = /* sql */ `
CREATE TABLE schedule_events_new (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('fired','skipped_overlap','missed','caught_up','error','skipped')),
  slot_at     TEXT NOT NULL,
  run_id      TEXT,
  message     TEXT,
  created_at  TEXT NOT NULL
);
INSERT INTO schedule_events_new(id, schedule_id, kind, slot_at, run_id, message, created_at)
  SELECT id, schedule_id, kind, slot_at, run_id, message, created_at FROM schedule_events;
DROP TABLE schedule_events;
ALTER TABLE schedule_events_new RENAME TO schedule_events;
CREATE INDEX IF NOT EXISTS schedule_events_sched ON schedule_events(schedule_id, created_at);
`

/**
 * CONTRACT §13 (usage limits, Stalled?, retry at reset): nullable columns added to v2 tables without a version bump,
 * so an older Hive still opens the db. Healed idempotently on every open (db/index.ts).
 */
export const V2_ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['runs', 'stop_reason', "TEXT CHECK (stop_reason IN ('rate_limited'))"],
  ['runs', 'reset_at', 'TEXT'],
  ['runs', 'retry_at', 'TEXT'],
  ['runs', 'retry_run_id', 'TEXT'],
  ['run_steps', 'stop_reason', "TEXT CHECK (stop_reason IN ('rate_limited'))"],
  ['run_steps', 'reset_at', 'TEXT'],
  ['agents', 'stop_reason', "TEXT CHECK (stop_reason IN ('rate_limited'))"],
  ['agents', 'reset_at', 'TEXT'],
  ['agents', 'retry_at', 'TEXT'],
  ['agents', 'stalled_since', 'TEXT']
]

/**
 * AUTHORING.md §10 / CONTRACT §14.4: authoring, worktrees and Claude history. No version bump (older Hive still opens
 * the db): CREATE IF NOT EXISTS on every open, plus the columns in AUTHORING_ADDED_COLUMNS.
 * CHECK constraints of v1/v2 tables are never rebuilt: values those CHECKs reject are stored compatibly and widened by
 * the mappers (runs.trigger 'agent' -> 'manual' + started_by_json; run_steps wait/notify -> 'shell' + node_type_ext;
 * asks 'approval'/'author' -> 'question'/'mcp' + draft_id).
 */
export const DDL_AUTHORING = /* sql */ `
CREATE TABLE IF NOT EXISTS author_drafts (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                   -- create | update | run
  status        TEXT NOT NULL,                   -- pending | approved | rejected | expired
  owner_kind    TEXT NOT NULL,                   -- 'session' (PO1: interactive panes only)
  session_id    TEXT, run_id TEXT, step_id TEXT, agent_id TEXT,
  owner_key     TEXT NOT NULL,
  owner_label   TEXT NOT NULL,
  adapter       TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  workflow_id   TEXT,
  workflow_name TEXT NOT NULL DEFAULT '',
  payload_json  TEXT NOT NULL,                   -- normalized WorkflowDraft (create/update) | {inputs, reason} (run)
  base_json     TEXT,                            -- update: the saved workflow at draft time
  schedule_json TEXT,                            -- PO2: {name, when, inputs, sentence, next}
  run_now_json  TEXT,                            -- PO2: {inputs}
  content_hash  TEXT NOT NULL,
  ask_id        TEXT,
  flags_json    TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  decision_note TEXT,
  decided_at    TEXT,
  edited        INTEGER NOT NULL DEFAULT 0,
  run_allowed   INTEGER NOT NULL DEFAULT 0,
  result_json   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS author_drafts_status ON author_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS author_drafts_owner  ON author_drafts(owner_key, status);

CREATE TABLE IF NOT EXISTS author_run_grants (
  workflow_id  TEXT NOT NULL,
  owner_key    TEXT NOT NULL,
  owner_label  TEXT NOT NULL,
  content_hash TEXT NOT NULL,                    -- PO3: valid only while the saved workflow hashes to this
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workflow_id, owner_key)
);

CREATE TABLE IF NOT EXISTS worktrees (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  repo_id     TEXT,
  repo_path   TEXT NOT NULL,
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  base        TEXT NOT NULL,
  base_ref    TEXT,
  base_sha    TEXT,
  heads_json  TEXT NOT NULL DEFAULT '[]',        -- PO6: refs/heads at ensure
  status      TEXT NOT NULL,
  kept_reason TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  removed_at  TEXT
);
CREATE INDEX IF NOT EXISTS worktrees_status ON worktrees(status);
CREATE INDEX IF NOT EXISTS worktrees_run ON worktrees(run_id);

-- local branches per repo when a run started: every branch created during the run (isolated or not) is reported,
-- cleaned when it carries no new unpushed work, and offered for deletion otherwise
CREATE TABLE IF NOT EXISTS run_refs (
  run_id      TEXT NOT NULL,
  repo_path   TEXT NOT NULL,
  heads_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  left_json   TEXT,                              -- after the sweep: branches still there [{name, newCommits, checkedOut}]
  swept_at    TEXT,
  PRIMARY KEY (run_id, repo_path)
);

CREATE TABLE IF NOT EXISTS claude_history (
  path         TEXT PRIMARY KEY,
  root         TEXT NOT NULL,
  project_dir  TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime_ms     REAL NOT NULL,
  cwd          TEXT,
  git_branch   TEXT,
  title        TEXT NOT NULL,
  title_source TEXT NOT NULL,
  first_prompt TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  turns        INTEGER,
  subagents    INTEGER NOT NULL DEFAULT 0,
  model        TEXT,
  version      TEXT,
  entrypoint   TEXT,
  indexed_at   TEXT NOT NULL,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS claude_history_ended ON claude_history(ended_at);
CREATE INDEX IF NOT EXISTS claude_history_session ON claude_history(session_id);
`

export const AUTHORING_ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['workflows', 'origin_json', 'TEXT'],
  ['workflows', 'worktree_json', 'TEXT'],
  ['runs', 'outcome', 'TEXT'],
  ['runs', 'worktree_id', 'TEXT'],
  ['runs', 'started_by_json', 'TEXT'],
  ['run_steps', 'halt', 'TEXT'],
  ['run_steps', 'node_type_ext', 'TEXT'],
  ['asks', 'draft_id', 'TEXT']
]

/**
 * SLACK.md §7.1 / CONTRACT "Slack.4": the Slack connector's tables. No version bump (older Hive still opens the db):
 * CREATE IF NOT EXISTS on every open, plus SLACK_ADDED_COLUMNS. Old CHECKs are not rebuilt: runs.trigger 'slack' is
 * stored as 'manual' + trigger_ext, asks 'slack_reply'/'slack' as 'question'/'mcp' + slack_draft_id.
 * Tokens live only in connector_secrets (never `secrets`, so never in any child env).
 */
export const DDL_SLACK = /* sql */ `
CREATE TABLE IF NOT EXISTS connector_secrets (
  connector  TEXT NOT NULL,
  name       TEXT NOT NULL,
  cipher     BLOB NOT NULL,
  masked     TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (connector, name)
);

CREATE TABLE IF NOT EXISTS slack_workspaces (
  team_id TEXT PRIMARY KEY, team_name TEXT NOT NULL, domain TEXT, url TEXT, enterprise_id TEXT,
  app_id TEXT, bot_user_id TEXT NOT NULL, bot_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]', connected_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slack_users (
  team_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, real_name TEXT, display_name TEXT, is_bot INTEGER NOT NULL DEFAULT 0, bot_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, tz TEXT, avatar_url TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, id)
);

CREATE TABLE IF NOT EXISTS slack_channels (
  team_id TEXT NOT NULL, id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('channel','private','dm','group_dm')),
  name TEXT NOT NULL,
  dm_user_id TEXT, topic TEXT, purpose TEXT,
  is_member INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, member_count INTEGER,
  last_message_ts TEXT, last_read_ts TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, id)
);

CREATE TABLE IF NOT EXISTS slack_messages (
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL, ts TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT, bot_id TEXT, subtype TEXT,
  text TEXT NOT NULL DEFAULT '',
  plain TEXT NOT NULL DEFAULT '',
  files_json TEXT, reactions_json TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0, latest_reply TEXT, reply_users_json TEXT,
  edited_ts TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  hive_ref TEXT,
  source TEXT NOT NULL CHECK (source IN ('backfill','event','gapfill','fetch','post')),
  received_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id, ts)
);
CREATE INDEX IF NOT EXISTS slack_messages_thread ON slack_messages(team_id, channel_id, thread_ts, ts);
CREATE INDEX IF NOT EXISTS slack_messages_user   ON slack_messages(team_id, user_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS slack_messages_fts USING fts5(
  plain, content='slack_messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS slack_messages_ai AFTER INSERT ON slack_messages BEGIN
  INSERT INTO slack_messages_fts(rowid, plain) VALUES (new.rowid, new.plain);
END;
CREATE TRIGGER IF NOT EXISTS slack_messages_ad AFTER DELETE ON slack_messages BEGIN
  INSERT INTO slack_messages_fts(slack_messages_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
END;
CREATE TRIGGER IF NOT EXISTS slack_messages_au AFTER UPDATE OF plain ON slack_messages BEGIN
  INSERT INTO slack_messages_fts(slack_messages_fts, rowid, plain) VALUES ('delete', old.rowid, old.plain);
  INSERT INTO slack_messages_fts(rowid, plain) VALUES (new.rowid, new.plain);
END;

CREATE TABLE IF NOT EXISTS slack_sync_state (
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  backfill_status TEXT NOT NULL CHECK (backfill_status IN ('pending','running','done','error','skipped')),
  backfill_days INTEGER NOT NULL, backfill_oldest_ts TEXT, backfill_cursor TEXT,
  latest_ts TEXT,
  error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id)
);
CREATE TABLE IF NOT EXISTS slack_thread_sync (
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL,
  synced_through_ts TEXT, fetched_at TEXT, status TEXT NOT NULL CHECK (status IN ('pending','done','error')),
  PRIMARY KEY (team_id, channel_id, thread_ts)
);

CREATE TABLE IF NOT EXISTS slack_event_log (
  event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL
);

-- one trigger-matching delivery per (team, channel, ts): app_mention + message, event + gap-fill, across restarts
CREATE TABLE IF NOT EXISTS slack_inbound_log (
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL, ts TEXT NOT NULL, received_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id, ts)
);

CREATE TABLE IF NOT EXISTS slack_triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_json TEXT NOT NULL,
  reply_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL,
  origin_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_trigger_state (
  trigger_id TEXT NOT NULL REFERENCES slack_triggers(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL, thread_key TEXT NOT NULL,
  pending_json TEXT NOT NULL DEFAULT '[]',
  window_ends_at TEXT, active_run_id TEXT,
  fired_at_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, channel_id, thread_key)
);
CREATE TABLE IF NOT EXISTS slack_trigger_events (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES slack_triggers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  channel_id TEXT, thread_ts TEXT, ts TEXT, run_id TEXT, message TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_trigger_events_t ON slack_trigger_events(trigger_id, created_at);

CREATE TABLE IF NOT EXISTS slack_drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT,
  text TEXT NOT NULL, original_text TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  session_id TEXT, run_id TEXT, step_id TEXT, agent_id TEXT, trigger_id TEXT,
  owner_label TEXT NOT NULL, note TEXT,
  ask_id TEXT, outbox_id TEXT, sent_ts TEXT, error TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_drafts_status ON slack_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS slack_drafts_run ON slack_drafts(run_id);

CREATE TABLE IF NOT EXISTS slack_outbox (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT,
  thread_key TEXT,
  text TEXT NOT NULL, draft_id TEXT, run_id TEXT, step_id TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, ts TEXT, error TEXT,
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS slack_outbox_auto ON slack_outbox(team_id, purpose, channel_id, created_at);
CREATE INDEX IF NOT EXISTS slack_outbox_status ON slack_outbox(status);
`

export const SLACK_ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['runs', 'trigger_ext', 'TEXT'],
  ['runs', 'slack_json', 'TEXT'],
  ['asks', 'slack_draft_id', 'TEXT'],
  ['workflows', 'slack_tools', 'INTEGER'],
  // SLACK.md §9.5: the slack_trigger riding on an agent's create/update draft
  ['author_drafts', 'slack_trigger_json', 'TEXT'],
  // SA2: the agent access of a Slack-triggered run (NULL = restricted, no keys)
  ['slack_triggers', 'access_json', 'TEXT'],
  // who may trigger (guests, Slack Connect externals): users.list / users.info fields
  ['slack_users', 'is_restricted', 'INTEGER NOT NULL DEFAULT 0'],
  ['slack_users', 'is_ultra_restricted', 'INTEGER NOT NULL DEFAULT 0'],
  ['slack_users', 'home_team_id', 'TEXT'],
  ['slack_users', 'enterprise_id', 'TEXT']
]
