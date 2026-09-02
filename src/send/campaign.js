/**
 * The only thing in this project that sends anything.
 *
 * One function, and the permission check is inside it. That is deliberate and
 * it is the whole architecture: there is no `send()` that takes a list of
 * addresses, no "skip checks" option, and no second path for a hurry. If a
 * message leaves this program, `mayReceive` said yes about that address, and
 * the row saying so was written before it went.
 *
 * A tool where the check is a step somebody remembers to call is a tool where
 * somebody eventually does not.
 *
 * **Two phases, and the first one has no transport at all.** `decide` works out
 * who may be written to and writes down the answer for everybody — including
 * the refusals, with the reason. `run` then sends only what `decide` allowed.
 * They are separate so a campaign can be looked at before it goes: the most
 * useful thing this can tell somebody is "four hundred contacts, three hundred
 * and twelve of them sendable, and here is why the other eighty-eight are not".
 */

import { mayReceive } from '../rules/permission.js';
import { fill } from '../render/template.js';

/**
 * Works out who may be written to. Sends nothing.
 *
 * @returns {{ campaign: object, counted: object, refusals: object }}
 */
export function decide({ store, campaign, contacts, now = Date.now() }) {
  for (const contact of contacts) {
    const said = mayReceive(contact, { now });

    if (!said.ok) {
      store.decide({
        campaignId: campaign.id,
        address: contact.address,
        state: 'refused',
        why: said.why,
        code: said.code,
      });
      continue;
    }

    // Rendered now rather than at send time, so the thing that was approved is
    // the thing that goes. A template filled in at the last moment is a
    // template nobody reviewed.
    const subject = fill(campaign.subject, contact);
    const body = fill(campaign.body, contact);

    /**
     * A message with a hole in it does not go.
     *
     * This is the second refusal, and it is not about permission — it is about
     * "Hello {{name}}" and "Hello ," arriving at four hundred people. The
     * template module reports a missing field rather than blanking it, and
     * this is the place that has to act on the report; a rule that is only
     * ever reported is a rule the tool does not have.
     */
    const missing = [...new Set([...subject.missing, ...body.missing])];

    if (missing.length > 0) {
      store.decide({
        campaignId: campaign.id,
        address: contact.address,
        state: 'refused',
        why: `the message would have had a hole in it: nothing to put in ${missing.map((one) => `{{${one}}}`).join(', ')}`,
        code: 'a-field-is-missing',
      });
      continue;
    }

    store.decide({
      campaignId: campaign.id,
      address: contact.address,
      state: 'allowed',
      why: said.why,
      subject: subject.text,
      body: body.text,
    });
  }

  return { campaign, ...store.howItWent(campaign.id) };
}

/**
 * Sends what was allowed, at a rate somebody chose.
 *
 * The rate is not politeness. Anything that receives mail treats a burst from
 * one sender as what it looks like, and the punishment is the whole domain's
 * reputation rather than the one campaign's. So the gap is between the START of
 * one send and the start of the next, and it is honoured even when a send was
 * instant — measuring from the end lets a fast transport send as fast as it
 * likes, which is the case that gets a domain blocked.
 */
export async function run({
  store,
  campaign,
  transport,
  perMinute = 30,
  /**
   * The clock, and it is a function rather than a moment.
   *
   * `now = Date.now()` was a value: one reading, taken when the arguments were
   * evaluated, which is no use to a loop that runs for a quarter of an hour. So
   * the two places that actually decide something called `Date.now()` directly
   * instead, and the injected clock was honoured only where it decided nothing.
   * A test could set it and change no outcome, which is the same as not having
   * it at all.
   *
   * A function, asked each time round, is honoured **where it decides**: the
   * re-check before each send, and the gap between sends.
   */
  clock = () => Date.now(),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = () => {},
  stopIfSuppressedSince = true,
  /**
   * Whether to carry on, asked before every single send.
   *
   * A campaign of four hundred at thirty a minute takes a quarter of an hour,
   * and for that quarter of an hour somebody has to be able to change their
   * mind — because the subject line was wrong, because the wrong list was
   * picked, because somebody walked in. A run that cannot be stopped is a run
   * where the only way out is killing the process, which stops it in the middle
   * of a message rather than between two.
   *
   * Asked between sends, never during one: what has gone has gone, and what has
   * not is left `allowed`, still waiting, so the same campaign can be picked up
   * again later without writing to anybody twice.
   */
  keepGoing = () => true,
}) {
  const gap = perMinute > 0 ? Math.floor(60_000 / perMinute) : 0;
  const queue = store.waiting(campaign.id);

  let sent = 0;
  let failed = 0;
  let dropped = 0;
  let stopped = false;

  for (const [at, message] of queue.entries()) {
    // Between two messages, never inside one.
    if (!keepGoing()) {
      stopped = true;
      log('info', 'stopped on request', { campaign: campaign.name, sent, left: queue.length - at });
      break;
    }

    const started = clock();

    /**
     * Asked again, immediately before sending.
     *
     * A campaign of four hundred at thirty a minute takes a quarter of an hour,
     * and somebody who unsubscribes in minute two must not be written to in
     * minute nine. The decision made at the start of a run is a decision about
     * a world that has moved on.
     */
    if (stopIfSuppressedSince) {
      const contact = store.contact(message.address);
      const said = mayReceive(contact ?? { address: message.address }, { now: clock() });

      if (!said.ok) {
        store.decide({
          campaignId: campaign.id,
          address: message.address,
          state: 'refused',
          why: `${said.why} (it changed after this campaign was worked out)`,
          code: said.code,
        });
        dropped += 1;
        log('info', 'dropped before sending', { address: message.address, why: said.why });
        continue;
      }
    }

    store.began(message.id);

    try {
      const said = await transport.send({
        to: message.address,
        from: { name: campaign.from_name, address: campaign.from_address },
        subject: message.subject,
        body: message.body,
      });

      store.finished(message.id, { ok: true, why: said.why ?? 'sent' });
      sent += 1;
    } catch (error) {
      // A failure is written down and the run continues. One address that a
      // server will not take must not stop the other three hundred and eleven.
      store.finished(message.id, { ok: false, why: error.message });
      failed += 1;
      log('warn', 'would not send', { address: message.address, why: error.message });
    }

    // From the START of this one, not the end.
    if (gap > 0 && at < queue.length - 1) {
      const owed = gap - (clock() - started);
      if (owed > 0) await wait(owed);
    }
  }

  log('info', stopped ? 'campaign stopped' : 'campaign finished', { campaign: campaign.name, sent, failed, dropped });

  // `stopped` is not a failure, and it is not success either: it is the third
  // outcome, and a caller that only knows two of them will report one of the
  // wrong ones.
  return { sent, failed, dropped, stopped, ...store.howItWent(campaign.id) };
}
