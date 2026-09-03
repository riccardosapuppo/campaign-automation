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

import { readFileSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';
import type { Contact } from '../rules/permission.ts';

import fs from 'node:fs';
import path from 'node:path';

/**
 * The schema, read from the file next to this one.
 *
 * `schema.sql` rather than a template literal: it argues better as a file
 * something can open, colour and diff than as a string inside a module.
 */
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * A campaign, as the database holds it.
 *
 * Named because four other files take one as an argument, and passing them a
 * shapeless row meant every one of them had to say `Number(campaign.id)` and
 * hope. The index signature is honest: the table has more columns than these
 * and nothing here promises to know them all.
 */
export type CampaignRow = {
  id: number;
  name: string;
  subject: string;
  body: string;
  from_name: string;
  from_address: string;
  [more: string]: unknown;
};

/** How a campaign is going: one count per state, and why the refusals were. */
export type HowItWent = {
  allowed: number;
  refused: number;
  sending: number;
  sent: number;
  failed: number;
  refusals: Record<string, number>;
};

export type Store = ReturnType<typeof store>;

export function store({
  file = ':memory:',
  at = () => new Date().toISOString(),
}: { file?: string; at?: () => string } = {}) {
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
    remember(contact: Contact) {
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
    record({
      address,
      kind,
      recordedAt,
      source,
      text = null,
    }: { address: string; kind: string; recordedAt: string | null; source: string | null; text?: string | null }) {
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
    suppress(address: string, why: string) {
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
    contact(address: string) {
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

    everybody({ limit = 5000 }: { limit?: number } = {}) {
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
    historyOf(address: string) {
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

    createCampaign({
      name,
      subject,
      body,
      fromName,
      fromAddress,
    }: { name: string; subject: string; body: string; fromName: string; fromAddress: string }) {
      const created = db
        .prepare(
          `INSERT INTO campaigns (name, subject, body, from_name, from_address, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
        )
        .get(name, subject, body, fromName, fromAddress, now()) as CampaignRow;

      return created;
    },

    campaign: (id: number) =>
      (db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined) ?? null,
    campaigns: () => db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all() as CampaignRow[],

    // ------------------------------------------------------------ messages

    /**
     * Writes down what was decided about one person, before anything is sent.
     *
     * Refusals are rows too. A refusal that is only a number in a summary
     * cannot answer "why did this person not get it", which is the question
     * somebody always asks.
     */
    decide({
      campaignId,
      address,
      state,
      why,
      code = null,
      subject = null,
      body = null,
    }: {
      campaignId: number;
      address: string;
      state: string;
      why: string;
      code?: string | null;
      subject?: string | null;
      body?: string | null;
    }) {
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

    began: (id: number) => db.prepare("UPDATE messages SET state = 'sending' WHERE id = ?").run(id),

    finished(id: number, { ok, why }: { ok: boolean; why: string }) {
      db.prepare('UPDATE messages SET state = ?, why = ?, finished_at = ? WHERE id = ?').run(
        ok ? 'sent' : 'failed',
        why,
        now(),
        id
      );
    },

    waiting: (campaignId: number) =>
      db
        .prepare("SELECT * FROM messages WHERE campaign_id = ? AND state IN ('allowed', 'sending') ORDER BY id")
        .all(campaignId),

    forCampaign: (campaignId: number) =>
      db.prepare('SELECT * FROM messages WHERE campaign_id = ? ORDER BY id').all(campaignId),

    /** How a campaign went, in the words somebody would use about it. */
    howItWent(campaignId: number) {
      const rows = db
        .prepare('SELECT state, code, count(*) AS howMany FROM messages WHERE campaign_id = ? GROUP BY state, code')
        .all(campaignId);

      const counted: Record<string, number> = { allowed: 0, refused: 0, sending: 0, sent: 0, failed: 0 };
      const refusals: Record<string, number> = {};

      for (const row of rows) {
        const state = String(row.state);
        counted[state] = (counted[state] ?? 0) + Number(row.howMany);
        if (state === 'refused' && row.code) refusals[String(row.code)] = Number(row.howMany);
      }

      return { ...counted, refusals } as HowItWent;
    },

    counts: () => {
      // One helper rather than five identical casts: `get()` cannot know what a
      // SELECT returns, and saying so once is the whole of the concession.
      const howMany = (table: string): number =>
        Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);

      return {
        contacts: howMany('contacts'),
        bases: howMany('bases'),
        suppressed: howMany('suppressions'),
        campaigns: howMany('campaigns'),
        messages: howMany('messages'),
      };
    },
  };
}

/** A database row, in the shape `mayReceive` reads. */
function asContact(row: Record<string, unknown>): Contact {
  const text = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);

  return {
    address: text(row.address),
    name: text(row.name),
    fields: JSON.parse(String(row.fields ?? '{}')),
    basis: row.basis_kind
      ? {
          kind: String(row.basis_kind),
          recordedAt: text(row.basis_recorded_at),
          source: text(row.basis_source),
        }
      : null,
    suppressed: row.suppressed_why !== null && row.suppressed_why !== undefined,
    suppressedWhy: text(row.suppressed_why),
  };
}
