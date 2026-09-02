/**
 * The service, and the console somebody actually uses.
 *
 * Every route here is a thin wrapper over something that was already decided
 * elsewhere: permission in `rules/permission.js`, sending in `send/campaign.js`,
 * storage in `store/db.js`. That is on purpose. An HTTP layer that makes
 * decisions is an HTTP layer with a second, undocumented copy of the rules in
 * it, and the copies drift.
 *
 * The one thing this layer owns is **what a person is allowed to ask for**.
 * There is no route that sends to an address, only one that sends a campaign
 * that was worked out and looked at; and there is no route at all that turns
 * the permission check off, because the argument of the whole project is that
 * such a route is the bug.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mayReceive, looksLikeStop, sortOut } from '../rules/permission.js';
import { read as readCsv } from '../import/csv.js';
import { fieldsIn, whoIsMissingSomething } from '../render/template.js';
import { decide, run } from '../send/campaign.js';
import { dryRun, toFolder, smtp, WHAT_THERE_IS } from '../send/transports.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} options
 * @param {ReturnType<import('../store/db.js').store>} options.store
 */
export function api({ store, outbox = 'data/outbox', smtpHost = '127.0.0.1', smtpPort = 3609, log = () => {} }) {
  const app = express();

  /**
   * Campaigns somebody has asked to stop, while they are still going.
   *
   * In memory on purpose: a request to stop is about the run happening right
   * now, in this process. If the process dies the run dies with it, and what
   * has not been sent is still sitting in the database marked as waiting —
   * which is the same state a stop leaves it in, and the same one it can be
   * picked up from.
   */
  const asked = new Set();

  app.use(express.json({ limit: '8mb' }));
  app.use(express.text({ type: 'text/csv', limit: '8mb' }));

  // The console. Static, tiny, and served from the same origin as the API so
  // there is no CORS to open — which is the point: nothing else should be
  // talking to this.
  const root = path.join(here, '..', '..');

  /**
   * How the console is served, which is not a detail.
   *
   * `express.static` with `etag: false` looks like it has turned off
   * revalidation and has not: `lastModified` is a separate option and defaults
   * to true, so every response still carried a `Last-Modified`, and every
   * reload was a conditional request that a browser is entitled to answer from
   * its own cache with a 304. That is the mechanism by which somebody presses
   * reload after a rebuild and is served the page from before it — and then
   * has to be told to press Ctrl+F5, which is not an answer.
   *
   * So: nothing here is stored at all, and there is nothing to revalidate
   * against. Not "the page is no-store and the rest is immutable", which is the
   * arrangement for a site whose assets carry a hash in their name — these do
   * not, so serving `console.js` as immutable would mean a change to it never
   * reaching anybody. Fingerprinting three files to save three requests on
   * localhost would be machinery for its own sake.
   *
   * `npm run check:serving` asserts all of this against the running service,
   * because a caching header is exactly the kind of thing that is right in the
   * source and wrong in the response.
   */
  const never = {
    etag: false,
    lastModified: false,
    setHeaders(response) {
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    },
  };

  app.use(express.static(path.join(root, 'public'), never));

  // The sample spreadsheet, so the button on the screen that says "use the
  // sample list" reads the same file a person would pick from the file dialog
  // — rather than a copy of it pasted into the page, which is how a sample
  // stops matching the file it is supposed to be.
  app.use('/samples', express.static(path.join(root, 'samples'), never));

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, ...store.counts() });
  });

  // --------------------------------------------------------------- contacts

  /**
   * Import.
   *
   * Answers with what it recognised and what it could not, and the caller sees
   * both before anything is written to. An importer that answers "412 rows
   * imported" has hidden the only interesting part.
   */
  app.post('/api/import', (request, response) => {
    const csv = typeof request.body === 'string' ? request.body : request.body?.csv;

    if (!csv || !String(csv).trim()) {
      return response.status(400).json({ error: 'send a CSV, either as text/csv or as { "csv": "..." }' });
    }

    const said = readCsv(csv);

    for (const contact of said.contacts) {
      store.remember(contact);

      if (contact.basis) {
        store.record({
          address: contact.address,
          kind: contact.basis.kind,
          recordedAt: contact.basis.recordedAt,
          source: contact.basis.source,
        });
      }

      // A spreadsheet that says somebody unsubscribed is a spreadsheet that has
      // to be believed, even though it is being imported as a source of
      // contacts. This is the one direction that is never overridden.
      if (contact.suppressed) store.suppress(contact.address, 'the imported file said they had unsubscribed');
    }

    log('info', 'imported', { contacts: said.contacts.length, skipped: said.skipped?.length ?? 0 });

    response.json({
      columns: said.columns,
      imported: said.contacts.length,
      skipped: said.skipped ?? [],
      trouble: said.trouble,
      ...store.counts(),
    });
  });

  /**
   * Everybody, each with the verdict and the reason for it.
   *
   * The two groups stay separate all the way to the screen rather than being
   * flattened into one list with a boolean on it. The refusals are what
   * somebody came to look at, and a shape that makes them easy to ignore is a
   * shape that gets ignored.
   */
  app.get('/api/contacts', (_request, response) => {
    const sorted = sortOut(store.everybody());

    response.json({
      allowed: sorted.allowed.map((one) => ({ ...one.contact, said: { ok: true, why: one.why } })),
      refused: sorted.refused.map((one) => ({ ...one.contact, said: { ok: false, why: one.why, code: one.code } })),
      counted: sorted.counted,
    });
  });

  /** One person: every basis ever recorded, the suppression, every message. */
  app.get('/api/contacts/:address', (request, response) => {
    const address = String(request.params.address).toLowerCase();
    const contact = store.contact(address);

    if (!contact) return response.status(404).json({ error: 'nobody here by that address' });

    response.json({ contact, said: mayReceive(contact), ...store.historyOf(address) });
  });

  /** Recording that somebody agreed, by hand rather than by import. */
  app.post('/api/contacts/:address/basis', (request, response) => {
    const address = String(request.params.address).toLowerCase();
    const { kind, recordedAt, source, text = null } = request.body ?? {};

    if (!kind || !recordedAt || !source) {
      return response
        .status(400)
        .json({ error: 'a basis needs a kind, a date, and a source: where it was recorded and can be checked' });
    }

    store.record({ address, kind, recordedAt, source, text });

    const contact = store.contact(address);
    response.json({ contact, said: mayReceive(contact ?? { address }) });
  });

  /**
   * Somebody asked to stop.
   *
   * The most important route in the service, so it is the simplest one, it
   * takes no options, and it cannot fail because a contact does not exist — a
   * suppression is keyed on the address precisely so it can be recorded for
   * somebody who is not in the list yet.
   */
  app.post('/api/suppress', (request, response) => {
    const address = String(request.body?.address ?? '').trim().toLowerCase();
    if (!address) return response.status(400).json({ error: 'which address?' });

    store.suppress(address, String(request.body?.why ?? 'they asked to stop'));
    log('info', 'suppressed', { address });

    response.json({ address, suppressed: true, said: mayReceive(store.contact(address) ?? { address }) });
  });

  /**
   * A reply came in.
   *
   * This is where an unsubscribe actually arrives in real life: not through a
   * form, but as somebody replying "stop" or "take me off this list" to the
   * message. Handling it automatically is the difference between honouring a
   * request in seconds and honouring it whenever somebody next reads an inbox.
   *
   * It answers with what it decided AND with the words it decided on, because
   * the failure here is silent in both directions: a reply wrongly read as a
   * stop quietly unsubscribes a customer who was answering a question.
   */
  app.post('/api/reply', (request, response) => {
    const address = String(request.body?.address ?? '').trim().toLowerCase();
    const text = String(request.body?.text ?? '');

    if (!address) return response.status(400).json({ error: 'which address?' });

    const stop = looksLikeStop(text);

    if (stop.yes) {
      store.suppress(address, `they replied: "${text.trim().slice(0, 120)}"`);
      log('info', 'stopped on a reply', { address, why: stop.why });
    }

    response.json({ address, text, suppressed: stop.yes, why: stop.why });
  });

  // -------------------------------------------------------------- campaigns

  app.get('/api/campaigns', (_request, response) => {
    response.json({ campaigns: store.campaigns().map((one) => ({ ...one, ...store.howItWent(one.id) })) });
  });

  app.post('/api/campaigns', (request, response) => {
    const { name, subject, body, fromName, fromAddress } = request.body ?? {};

    if (!name || !subject || !body || !fromAddress) {
      return response
        .status(400)
        .json({ error: 'a campaign needs a name, a subject, a body, and an address to come from' });
    }

    const campaign = store.createCampaign({ name, subject, body, fromName: fromName ?? '', fromAddress });

    // Said now, before anybody presses anything: which contacts this template
    // cannot be filled in for.
    const template = `${subject}\n${body}`;

    response.status(201).json({
      campaign,
      fields: fieldsIn(template),
      missing: whoIsMissingSomething(template, store.everybody()),
    });
  });

  /**
   * Stop the run that is going on right now.
   *
   * The original this was rebuilt from had a red button on its progress window,
   * and it was right to. Fifteen minutes is long enough to notice the wrong
   * subject line, or that the wrong list was picked, and a run whose only exit
   * is killing the process stops in the middle of a message rather than between
   * two.
   *
   * What has gone has gone. What has not is left waiting, so the same campaign
   * can be sent again later and nobody is written to twice.
   */
  app.post('/api/campaigns/:id/stop', (request, response) => {
    const campaign = store.campaign(Number(request.params.id));
    if (!campaign) return response.status(404).json({ error: 'no campaign with that number' });

    asked.add(campaign.id);
    log('info', 'asked to stop', { campaign: campaign.name });

    response.json({
      stopping: true,
      note: 'it will stop between two messages, never inside one; what has not gone is still waiting',
      ...store.howItWent(campaign.id),
    });
  });

  app.get('/api/campaigns/:id', (request, response) => {
    const campaign = store.campaign(Number(request.params.id));
    if (!campaign) return response.status(404).json({ error: 'no campaign with that number' });

    response.json({ campaign, messages: store.forCampaign(campaign.id), ...store.howItWent(campaign.id) });
  });

  /**
   * Work out who may be written to. Sends nothing, and says so.
   *
   * Separate from sending because this is the answer somebody reads: four
   * hundred contacts, three hundred and twelve sendable, and here is why the
   * rest are not.
   */
  app.post('/api/campaigns/:id/decide', (request, response) => {
    const campaign = store.campaign(Number(request.params.id));
    if (!campaign) return response.status(404).json({ error: 'no campaign with that number' });

    const said = decide({ store, campaign, contacts: store.everybody() });

    // `note`, not `sent`. Writing the sentence into the `sent` field would
    // overwrite a count with prose, and every caller that reads `sent` as a
    // number — including the screen — would quietly start reading a string.
    response.json({ ...said, note: 'nothing was sent: this only worked out who may be written to' });
  });

  /**
   * Send what was allowed.
   *
   * `transport` has to be named, and the default is the one that sends nothing.
   * A default that sends is a default that goes out because somebody pressed
   * the obvious button on a screen they were reading rather than using.
   */
  app.post('/api/campaigns/:id/send', async (request, response, next) => {
    const campaign = store.campaign(Number(request.params.id));
    if (!campaign) return response.status(404).json({ error: 'no campaign with that number' });

    const which = String(request.body?.transport ?? 'dry-run');
    const perMinute = Number(request.body?.perMinute ?? 600);

    const transports = {
      'dry-run': () => dryRun(),
      file: () => toFolder({ folder: outbox }),
      smtp: () => smtp({ host: smtpHost, port: smtpPort }),
    };

    // The service refuses a name the module does not list, and the module's
    // list is pinned by a test. Adding a transport here without adding it there
    // makes it unreachable rather than quietly available — which is the right
    // way round for the one thing this project promises it does not have.
    if (!WHAT_THERE_IS.includes(which) || !transports[which]) {
      return response
        .status(400)
        .json({ error: `there is no "${which}" transport`, there_is: WHAT_THERE_IS });
    }

    if (store.waiting(campaign.id).length === 0) {
      return response.status(409).json({
        error: 'nothing is waiting to go for this campaign — work out who may be written to first',
        ...store.howItWent(campaign.id),
      });
    }

    try {
      asked.delete(campaign.id);

      const said = await run({
        store,
        campaign,
        transport: transports[which](),
        perMinute,
        log,
        keepGoing: () => !asked.has(campaign.id),
      });

      response.json({ transport: which, ...said });
    } catch (error) {
      next(error);
    } finally {
      asked.delete(campaign.id);
    }
  });

  app.use((error, _request, response, _next) => {
    log('error', 'the request could not be handled', { why: error.message });
    response.status(500).json({ error: error.message });
  });

  return app;
}
