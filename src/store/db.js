/**
 * Where the contacts, the reasons, the campaigns and every message live.
 *
 * SQLite, through `node:sqlite`, which is part of Node and not a dependency.
 * A campaign tool needs to answer "who did we write to, when, and what allowed
 * it" months later, in front of somebody who is annoyed — and that is a
 * question with joins in it, not one a folder of JSON answers.
 *
 * Two decisions are worth arguing for.
 *
 * **A consent is a row, not a column.** `contacts.consented = true` cannot say
 * when, where, or what somebody actually agreed to, and it cannot say what it
 * said before somebody changed it. The `bases` table is append-only: agreeing,
 * changing your mind and agreeing again leaves three rows, and the current
 * answer is the newest of them. A boolean would leave one, and it would be a
 * boolean nobody could defend.
 *
 * **A suppression is for ever, and it is not on the contact.** Deleting a
 * contact who unsubscribed feels tidy and is the bug: they are re-imported next
 * month from the same spreadsheet, arrive with no history, and are written to
 * again. So suppressions are keyed on the address and outlive any contact row.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
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
`;

export function store({ file = ':memory:', at = () => new Date().toISOString() } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const now = () => at();

  return {
    db,
    close: () => db.close(),

    // ------------------------------------------------------------ contacts

    /**
     * Adds or updates a contact, and never touches their basis.
     *
     * Re-importing a spreadsheet is the commonest thing anybody does with a
     * tool like this, and it must not be a way to reset what somebody agreed
     * to. The name and the fields are overwritten; the reason they may be
     * contacted is not, because it is not in this table.
     */
    remember(contact) {
      db.prepare(
        `INSERT INTO contacts (address, name, fields, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET name = excluded.name, fields = excluded.fields`
      ).run(contact.address, contact.name ?? null, JSON.stringify(contact.fields ?? {}), now());

      return db.prepare('SELECT * FROM contacts WHERE address = ?').get(contact.address);
    },

    /**
     * Records why somebody may be contacted. Appends; never replaces.
     *
     * The one exception is a row identical to one already there — same person,
     * same kind, same date, same source. Re-importing last month's spreadsheet
     * is the commonest thing anybody does with a tool like this, and it must
     * not turn one consent into four. A second row would not be a second
     * agreement; it would be the same agreement counted again, which is exactly
     * the sort of thing an audit trail is supposed not to do.
     */
    record({ address, kind, recordedAt, source, text = null }) {
      const already = db
        .prepare('SELECT id FROM bases WHERE address = ? AND kind = ? AND recorded_at = ? AND source = ?')
        .get(address, kind, recordedAt, source);

      if (already) return already;

      return db
        .prepare(
          `INSERT INTO bases (address, kind, recorded_at, source, text, noted_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get(address, kind, recordedAt, source, text, now());
    },

    /** Somebody asked to stop, or a message bounced for good. */
    suppress(address, why) {
      db.prepare(
        `INSERT INTO suppressions (address, why, at) VALUES (?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET why = excluded.why, at = excluded.at`
      ).run(address, why, now());
    },

    /**
     * A contact in the shape the permission rules expect.
     *
     * The newest basis, and whether they are suppressed, in one query. Asking
     * for those separately is how a check ends up being made against a contact
     * that was suppressed between the two questions.
     */
    contact(address) {
      const row = db
        .prepare(
          `SELECT c.address, c.name, c.fields,
                  b.kind        AS basis_kind,
                  b.recorded_at AS basis_recorded_at,
                  b.source      AS basis_source,
                  s.why         AS suppressed_why
             FROM contacts c
             LEFT JOIN suppressions s ON s.address = c.address
             LEFT JOIN bases b ON b.id = (
               SELECT id FROM bases WHERE address = c.address ORDER BY recorded_at DESC, id DESC LIMIT 1
             )
            WHERE c.address = ?`
        )
        .get(address);

      return row ? asContact(row) : null;
    },

    everybody({ limit = 5000 } = {}) {
      return db
        .prepare(
          `SELECT c.address, c.name, c.fields,
                  b.kind        AS basis_kind,
                  b.recorded_at AS basis_recorded_at,
                  b.source      AS basis_source,
                  s.why         AS suppressed_why
             FROM contacts c
             LEFT JOIN suppressions s ON s.address = c.address
             LEFT JOIN bases b ON b.id = (
               SELECT id FROM bases WHERE address = c.address ORDER BY recorded_at DESC, id DESC LIMIT 1
             )
            ORDER BY c.address
            LIMIT ?`
        )
        .all(limit)
        .map(asContact);
    },

    /** Everything ever recorded about one person, for when they ask. */
    historyOf(address) {
      return {
        address,
        bases: db.prepare('SELECT * FROM bases WHERE address = ? ORDER BY recorded_at').all(address),
        suppression: db.prepare('SELECT * FROM suppressions WHERE address = ?').get(address) ?? null,
        messages: db
          .prepare(
            `SELECT m.*, c.name AS campaign FROM messages m
               JOIN campaigns c ON c.id = m.campaign_id
              WHERE m.address = ? ORDER BY m.at`
          )
          .all(address),
      };
    },

    // ----------------------------------------------------------- campaigns

    createCampaign({ name, subject, body, fromName, fromAddress }) {
      const created = db
        .prepare(
          `INSERT INTO campaigns (name, subject, body, from_name, from_address, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
        )
        .get(name, subject, body, fromName, fromAddress, now());

      return created;
    },

    campaign: (id) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) ?? null,
    campaigns: () => db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all(),

    // ------------------------------------------------------------ messages

    /**
     * Writes down what was decided about one person, before anything is sent.
     *
     * Refusals are rows too. A refusal that is only a number in a summary
     * cannot answer "why did this person not get it", which is the question
     * somebody always asks.
     */
    decide({ campaignId, address, state, why, code = null, subject = null, body = null }) {
      return db
        .prepare(
          `INSERT INTO messages (campaign_id, address, state, why, code, subject, body, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (campaign_id, address) DO UPDATE
             SET state = excluded.state, why = excluded.why, code = excluded.code
           RETURNING *`
        )
        .get(campaignId, address, state, why, code, subject, body, now());
    },

    began: (id) => db.prepare("UPDATE messages SET state = 'sending' WHERE id = ?").run(id),

    finished(id, { ok, why }) {
      db.prepare('UPDATE messages SET state = ?, why = ?, finished_at = ? WHERE id = ?').run(
        ok ? 'sent' : 'failed',
        why,
        now(),
        id
      );
    },

    waiting: (campaignId) =>
      db
        .prepare("SELECT * FROM messages WHERE campaign_id = ? AND state IN ('allowed', 'sending') ORDER BY id")
        .all(campaignId),

    forCampaign: (campaignId) =>
      db.prepare('SELECT * FROM messages WHERE campaign_id = ? ORDER BY id').all(campaignId),

    /** How a campaign went, in the words somebody would use about it. */
    howItWent(campaignId) {
      const rows = db
        .prepare('SELECT state, code, count(*) AS howMany FROM messages WHERE campaign_id = ? GROUP BY state, code')
        .all(campaignId);

      const counted = { allowed: 0, refused: 0, sending: 0, sent: 0, failed: 0 };
      const refusals = {};

      for (const row of rows) {
        counted[row.state] = (counted[row.state] ?? 0) + row.howMany;
        if (row.state === 'refused' && row.code) refusals[row.code] = row.howMany;
      }

      return { ...counted, refusals };
    },

    counts: () => ({
      contacts: db.prepare('SELECT count(*) AS n FROM contacts').get().n,
      bases: db.prepare('SELECT count(*) AS n FROM bases').get().n,
      suppressed: db.prepare('SELECT count(*) AS n FROM suppressions').get().n,
      campaigns: db.prepare('SELECT count(*) AS n FROM campaigns').get().n,
      messages: db.prepare('SELECT count(*) AS n FROM messages').get().n,
    }),
  };
}

/** A database row, in the shape `mayReceive` reads. */
function asContact(row) {
  return {
    address: row.address,
    name: row.name,
    fields: JSON.parse(row.fields ?? '{}'),
    basis: row.basis_kind
      ? { kind: row.basis_kind, recordedAt: row.basis_recorded_at, source: row.basis_source }
      : null,
    suppressed: row.suppressed_why !== null && row.suppressed_why !== undefined,
    suppressedWhy: row.suppressed_why ?? null,
  };
}
