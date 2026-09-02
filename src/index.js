#!/usr/bin/env node
/**
 * Starts the service and the console.
 *
 *     npm start
 *
 * Nothing here needs an account, a key, or a provider. On a first run it makes
 * a database under `data/`, and with `--sample` it fills it from the
 * spreadsheet in `samples/` so there is something to look at within seconds of
 * cloning.
 *
 * Everything binds to 127.0.0.1. A campaign tool that answers on every
 * interface is a campaign tool somebody else can run.
 */

import fs from 'node:fs';

import { store } from './store/db.js';
import { api } from './http/api.js';
import { read } from './import/csv.js';

const PORT = Number(process.env.PORT ?? 3608);
const HOST = process.env.HOST ?? '127.0.0.1';
const FILE = process.env.DB ?? 'data/campaigns.db';
const SMTP_HOST = process.env.SMTP_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3609);

/** One line of JSON per event, which is what anything reading logs wants. */
function log(level, message, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...detail })}\n`);
}

const kept = store({ file: FILE });

if (process.argv.includes('--sample')) fillFromSample();

const app = api({ store: kept, smtpHost: SMTP_HOST, smtpPort: SMTP_PORT, log });

const server = app.listen(PORT, HOST, () => {
  log('info', 'listening', {
    console: `http://${HOST}:${PORT}`,
    database: FILE,
    smtp: `${SMTP_HOST}:${SMTP_PORT}, used only if a campaign is sent over SMTP`,
    ...kept.counts(),
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'stopping');
    server.close(() => {
      kept.close();
      process.exit(0);
    });
  });
}

/**
 * The sample list, read through exactly the same path as any other file.
 *
 * Not a separate seeding routine with its own idea of what a contact is —
 * which is how sample data ends up being the only data that works.
 */
function fillFromSample() {
  const said = read(fs.readFileSync('samples/contacts.csv', 'utf8'));

  for (const contact of said.contacts) {
    kept.remember(contact);

    if (contact.basis) {
      kept.record({
        address: contact.address,
        kind: contact.basis.kind,
        recordedAt: contact.basis.recordedAt,
        source: contact.basis.source,
      });
    }

    if (contact.suppressed) kept.suppress(contact.address, 'the sample file said they had unsubscribed');
  }

  log('info', 'sample list imported', { contacts: said.contacts.length, ...kept.counts() });
}
