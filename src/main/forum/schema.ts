/**
 * FORUM.md §1: the Forum tables in hive.db. Created by healV2Columns (db/index.ts) and again, harmlessly, by
 * ForumStore's constructor, so a bare test db works too. No SCHEMA_VERSION bump: older builds ignore these tables.
 */
import type Database from 'better-sqlite3'

export const DDL_FORUM = /* sql */ `
CREATE TABLE IF NOT EXISTS forum_members (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  UNIQUE (company_id, handle)
);
CREATE INDEX IF NOT EXISTS forum_members_agent ON forum_members(agent_id) WHERE agent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS forum_channels (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  topic TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  system TEXT,
  dm_key TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS forum_channels_name ON forum_channels(company_id, name) WHERE name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS forum_channels_dm ON forum_channels(company_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS forum_channel_members (
  channel_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, member_id)
);
CREATE INDEX IF NOT EXISTS forum_channel_members_member ON forum_channel_members(member_id);
CREATE TABLE IF NOT EXISTS forum_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_seq INTEGER,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  origin TEXT NOT NULL DEFAULT 'local',
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS forum_messages_channel ON forum_messages(channel_id, thread_seq, seq);
CREATE INDEX IF NOT EXISTS forum_messages_thread ON forum_messages(thread_seq) WHERE thread_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS forum_messages_company ON forum_messages(company_id, seq);
CREATE INDEX IF NOT EXISTS forum_messages_author ON forum_messages(author_id, created_at);
CREATE TABLE IF NOT EXISTS forum_mentions (
  seq INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  read_at TEXT,
  PRIMARY KEY (seq, member_id)
);
CREATE INDEX IF NOT EXISTS forum_mentions_unread ON forum_mentions(member_id, read_at);
CREATE TABLE IF NOT EXISTS forum_invites (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  role TEXT NOT NULL,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS forum_invites_company ON forum_invites(company_id, created_at);
`

export function ensureForumSchema(db: Database.Database): void {
  db.exec(DDL_FORUM)
}
