/**
 * The only thing in this project that sends anything.
 *
 * Time is injected into every one of these, so they say the same thing in two
 * years as they do today. A test that computes a date from the clock passes
 * for a while and then starts failing for a reason nobody connects to the test.
 */

import assert from 'node:assert/strict';
import type { Contact } from '../src/rules/permission.ts';
import type { CampaignRow } from '../src/store/db.ts';
import type { Mail } from '../src/send/transports.ts';
import { describe, it } from 'node:test';

import { store } from '../src/store/db.ts';
import { decide, run } from '../src/send/campaign.ts';

const NOW = Date.parse('2026-09-01T09:00:00.000Z');
const RECENT = '2026-03-01T00:00:00.000Z';
const ANCIENT = '2020-01-01T00:00:00.000Z';

function set(contacts: Contact[]) {
  const kept = store({ file: ':memory:' });

  for (const contact of contacts) {
    kept.remember(contact);
    if (contact.basis) kept.record({ address: contact.address!, ...contact.basis });
    if (contact.suppressed) kept.suppress(contact.address!, 'they asked to stop');
  }

  const campaign = kept.createCampaign({
    name: 'March offer',
    subject: 'Hello {{name}}',
    body: 'Your account at {{company}} is unchanged.',
    fromName: 'Harbour Supplies',
    fromAddress: 'hello@example.invalid',
  });

  return { kept, campaign: campaign as CampaignRow };
}

const consented = (address: string, extra: Partial<Contact> = {}): Contact => ({
  address,
  name: address.split('@')[0] ?? address,
  fields: { company: 'Harbour Clinic' },
  basis: { kind: 'consent', recordedAt: RECENT, source: 'the sign-up form' },
  suppressed: false,
  suppressedWhy: null,
  ...extra,
});

/** Counts every send, so a test can prove one did not happen. */
function counting() {
  const sent: Mail[] = [];

  return {
    sent,
    name: 'counting',
    async send(message: Mail) {
      sent.push(message);
      return { why: 'counted' };
    },
  };
}

describe('working out who may be written to', () => {
  it('sends nothing at all', () => {
    // `decide` takes no transport. Not "takes one and does not use it" — there
    // is nothing it could send with, which is the only version of this that
    // stays true after somebody edits it.
    const { kept, campaign } = set([consented('a@example.invalid')]);

    const said = decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    assert.equal(said.allowed, 1);
    assert.equal(said.sent, 0);
    kept.close();
  });

  it('writes down every refusal with its reason', () => {
    const { kept, campaign } = set([
      consented('fine@example.invalid'),
      ({ address: 'nothing@example.invalid', name: 'Nothing', fields: { company: 'X' }, basis: null, suppressed: false, suppressedWhy: null }),
      consented('old@example.invalid', { basis: { kind: 'consent', recordedAt: ANCIENT, source: 'the old list' } }),
      consented('stopped@example.invalid', { suppressed: true }),
    ]);

    const said = decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    assert.equal(said.allowed, 1);
    assert.equal(said.refused, 3);
    assert.deepEqual(Object.keys(said.refusals).sort(), ['basis-stale', 'no-basis', 'suppressed']);

    // A refusal that is only a number in a summary cannot answer "why did this
    // person not get it", which is the question somebody always asks.
    const rows = kept.forCampaign(campaign!.id);
    for (const row of rows) {
      assert.ok(String(row.why ?? '').length > 0, `${row.address} was refused with no reason`);
    }

    kept.close();
  });

  it('refuses a message that would have a hole in it', () => {
    // Not a permission refusal — a "Hello {{company}}" refusal. The template
    // module reports a missing field rather than blanking it, and this is the
    // place that has to act on the report.
    const { kept, campaign } = set([consented('a@example.invalid', { fields: {} })]);

    const said = decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    assert.equal(said.allowed, 0);
    assert.equal(said.refusals['a-field-is-missing'], 1);
    kept.close();
  });

  it('renders now rather than at send time', () => {
    // A template filled in at the last moment is a template nobody reviewed:
    // what was approved and what goes out have to be the same text.
    const { kept, campaign } = set([consented('a@example.invalid')]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const [row] = kept.waiting(campaign!.id);
    assert.equal(row.subject, 'Hello a');
    assert.equal(row.body, 'Your account at Harbour Clinic is unchanged.');
    kept.close();
  });
});

describe('sending what was allowed', () => {
  it('sends to exactly the people who were allowed', async () => {
    const { kept, campaign } = set([
      consented('yes@example.invalid'),
      ({ address: 'no@example.invalid', name: 'No', fields: { company: 'X' }, basis: null, suppressed: false, suppressedWhy: null }),
    ]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const transport = counting();
    const said = await run({ store: kept, campaign, transport, perMinute: 0 });

    assert.equal(said.sent, 1);
    assert.deepEqual(
      transport.sent.map((one) => one.to),
      ['yes@example.invalid']
    );
    kept.close();
  });

  it('asks again immediately before each send', async () => {
    // A campaign of four hundred at thirty a minute takes a quarter of an
    // hour. Somebody who unsubscribes in minute two must not be written to in
    // minute nine — the decision made at the start is a decision about a world
    // that has moved on.
    const { kept, campaign } = set([consented('a@example.invalid'), consented('b@example.invalid')]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const transport = counting();
    const changesItsMind = {
      name: 'changes its mind',
      async send(message: Mail) {
        // The first send is what triggers the second person's unsubscribe, so
        // this is the race the check is about rather than a setup step.
        kept.suppress('b@example.invalid', 'they replied STOP while this was running');
        return transport.send(message);
      },
    };

    const said = await run({ store: kept, campaign, transport: changesItsMind, perMinute: 0 });

    assert.equal(said.sent, 1);
    assert.equal(said.dropped, 1);
    assert.equal(transport.sent.length, 1);

    const dropped = kept.forCampaign(campaign!.id).find((one) => one.address === 'b@example.invalid');
    assert.match(String(dropped?.why), /it changed after this campaign was worked out/);

    kept.close();
  });

  it('keeps going when one address fails, and writes down which', async () => {
    const { kept, campaign } = set([
      consented('a@example.invalid'),
      consented('b@example.invalid'),
      consented('c@example.invalid'),
    ]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const said = await run({
      store: kept,
      campaign,
      perMinute: 0,
      transport: {
        name: 'awkward',
        async send(message: Mail) {
          if (message.to === 'b@example.invalid') throw new Error('550 5.1.1 No such person here');
          return { why: 'sent' };
        },
      },
    });

    assert.equal(said.sent, 2);
    assert.equal(said.failed, 1);

    const failed = kept.forCampaign(campaign!.id).find((one) => one.state === 'failed');
    assert.match(String(failed?.why), /550/);
    kept.close();
  });

  it('measures the gap from the start of one send to the start of the next', async () => {
    // Not from the end. Measuring from the end lets a fast transport send as
    // fast as it likes, and a burst from one sender is what gets a whole
    // domain's reputation punished rather than one campaign's.
    const { kept, campaign } = set([consented('a@example.invalid'), consented('b@example.invalid')]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const waited: number[] = [];

    await run({
      store: kept,
      campaign,
      perMinute: 60, // one a second
      transport: {
        name: 'slow',
        async send() {
          await new Promise<void>((done) => setTimeout(done, 40));
          return { why: 'sent' };
        },
      },
      wait: async (ms) => waited.push(ms),
    });

    assert.equal(waited.length, 1);
    // A thousand-millisecond gap, less the time the send itself took.
    assert.ok(waited[0] <= 1000 - 30, `waited ${waited[0]} ms, which is not what the send cost`);
    kept.close();
  });

  it('honours the injected clock where it DECIDES, not only where it is read', async () => {
    // The trap this is written against: `now = Date.now()` as a default VALUE,
    // read once when the arguments were evaluated, while the two places that
    // decide anything called `Date.now()` themselves. A test could set the
    // clock and change no outcome — an injection that decides nothing is the
    // same as no injection at all.
    //
    // Here the consent is fresh when the campaign is worked out and years stale
    // by the time it would be sent. Only a clock consulted AT THE MOMENT OF
    // SENDING can tell the difference.
    const { kept, campaign } = set([consented('a@example.invalid')]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });
    assert.equal(kept.waiting(campaign!.id).length, 1, 'it should have been allowed at that point');

    const transport = counting();
    const said = await run({
      store: kept,
      campaign,
      transport,
      perMinute: 0,
      clock: () => NOW + 800 * 86_400_000, // the same run, more than two years later
    });

    assert.equal(said.sent, 0);
    assert.equal(said.dropped, 1);
    assert.equal(transport.sent.length, 0, 'a message went out under a clock that says the consent is stale');

    const dropped = kept.forCampaign(campaign!.id).find((one) => one.address === 'a@example.invalid');
    assert.match(String(dropped?.why), /longer than this campaign treats as current/);

    kept.close();
  });

  it('and measures the gap with that same clock', async () => {
    const { kept, campaign } = set([consented('a@example.invalid'), consented('b@example.invalid')]);
    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    // A clock that advances 100 ms per reading: the gap owed comes back reduced
    // by whatever the clock says the send cost, with no real time involved. How
    // many times it is read per message is an implementation detail, so the
    // assertion is that the gap was shortened and not by everything.
    let tick = NOW;
    const waited: number[] = [];

    await run({
      store: kept,
      campaign,
      transport: counting(),
      perMinute: 60,
      clock: () => {
        const said = tick;
        tick += 100;
        return said;
      },
      wait: async (ms) => waited.push(ms),
    });

    assert.equal(waited.length, 1, 'one gap, between the two sends');
    assert.ok(waited[0] > 0 && waited[0] < 1000, `waited ${waited[0]} ms: the injected clock was not used to work the gap out`);

    kept.close();
  });

  it('stops when it is asked to, between two messages', async () => {
    const { kept, campaign } = set([
      consented('a@example.invalid'),
      consented('b@example.invalid'),
      consented('c@example.invalid'),
    ]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const transport = counting();
    let asked = false;

    const said = await run({
      store: kept,
      campaign,
      transport,
      perMinute: 0,
      keepGoing: () => !asked,
    });

    // Nothing asked it to stop, so all three went.
    assert.equal(said.sent, 3);
    assert.equal(said.stopped, false);

    kept.close();

    // And now the same again, with somebody changing their mind after the first.
    const second = set([
      consented('a@example.invalid'),
      consented('b@example.invalid'),
      consented('c@example.invalid'),
    ]);

    decide({ store: second.kept, campaign: second.campaign, contacts: second.kept.everybody(), now: NOW });

    const watched = counting();
    asked = false;

    const stopped = await run({
      store: second.kept,
      campaign: second.campaign,
      perMinute: 0,
      keepGoing: () => !asked,
      transport: {
        name: 'somebody presses stop',
        async send(message: Mail) {
          asked = true; // pressed while the first one is going out
          return watched.send(message);
        },
      },
    });

    assert.equal(stopped.sent, 1, 'it carried on past the message it was asked to stop after');
    assert.equal(stopped.stopped, true);
    assert.equal(watched.sent.length, 1);

    // The two that did not go are still waiting, not refused and not failed —
    // so the same campaign can be sent later without writing to anybody twice.
    assert.equal(second.kept.waiting(second.campaign!.id).length, 2);

    second.kept.close();
  });

  it('and what it did not send can go later, once', async () => {
    const { kept, campaign } = set([consented('a@example.invalid'), consented('b@example.invalid')]);
    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const transport = counting();
    let asked = true; // stopped before it even starts

    await run({ store: kept, campaign, transport, perMinute: 0, keepGoing: () => !asked });
    assert.equal(transport.sent.length, 0);

    asked = false;
    const later = await run({ store: kept, campaign, transport, perMinute: 0, keepGoing: () => !asked });

    assert.equal(later.sent, 2);
    assert.deepEqual(transport.sent.map((one) => one.to), ['a@example.invalid', 'b@example.invalid']);
    kept.close();
  });

  it('does not wait after the last one', async () => {
    const { kept, campaign } = set([consented('a@example.invalid')]);
    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const waited: number[] = [];
    await run({ store: kept, campaign, transport: counting(), perMinute: 60, wait: async (ms) => waited.push(ms) });

    assert.deepEqual(waited, []);
    kept.close();
  });

  it('has nothing left to send the second time it is run', async () => {
    const { kept, campaign } = set([consented('a@example.invalid')]);
    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const transport = counting();
    await run({ store: kept, campaign, transport, perMinute: 0 });
    await run({ store: kept, campaign, transport, perMinute: 0 });

    assert.equal(transport.sent.length, 1);
    kept.close();
  });
});
