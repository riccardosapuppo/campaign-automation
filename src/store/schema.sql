-- Consent, suppression, and what was actually sent.
--
-- The two tables at the top are the ones this project is about: consent is
-- append-only, so withdrawing is a new row rather than an edit, and
-- suppression is keyed on the address rather than on the person -- because the
-- address is what a send has in its hand.
--
-- In its own file rather than a template literal in db.ts, so it can be opened
-- in something that knows SQL and diffed line by line. A schema is the part of
-- a system people argue about.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY,
  address     TEXT NOT NULL UNIQUE,
  name        TEXT,
  fields      TEXT NOT NULL DEFAULT '{}',   -- whatever else the import had
  added_at    TEXT NOT NULL
);

-- Append-only. Somebody agreeing, withdrawing and agreeing again leaves three
-- rows; the current answer is the newest.
CREATE TABLE IF NOT EXISTS bases (
  id          INTEGER PRIMARY KEY,
  address     TEXT NOT NULL,
  kind        TEXT NOT NULL,                -- consent | legitimate-interest
  recorded_at TEXT NOT NULL,
  source      TEXT NOT NULL,                -- where it came from, checkable
  text        TEXT,                         -- what they were actually shown
  noted_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bases_by_address ON bases (address, recorded_at DESC);

-- Keyed on the address, never on a contact id: a contact row can be deleted
-- and re-imported, and the suppression has to survive that.
CREATE TABLE IF NOT EXISTS suppressions (
  address     TEXT PRIMARY KEY,
  why         TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  from_name   TEXT NOT NULL,
  from_address TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- One row per person per campaign, written BEFORE anything is sent and
-- updated after. A row that says "sending" and never changed is a message
-- that may or may not have gone out, which is the honest state to be in after
-- a process is killed — and is exactly what a row written afterwards cannot
-- express.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id),
  address     TEXT NOT NULL,
  state       TEXT NOT NULL,                -- allowed | refused | sending | sent | failed
  why         TEXT,                         -- what allowed it, or what refused it
  code        TEXT,                         -- the refusal, for counting
  subject     TEXT,
  body        TEXT,
  at          TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (campaign_id, address)
);
CREATE INDEX IF NOT EXISTS messages_by_campaign ON messages (campaign_id, state);
