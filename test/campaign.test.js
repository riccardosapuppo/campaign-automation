/**
 * The only thing in this project that sends anything.
 *
 * Time is injected into every one of these, so they say the same thing in two
 * years as they do today. A test that computes a date from the clock passes
 * for a while and then starts failing for a reason nobody connects to the test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { store } from '../src/store/db.js';
import { decide, run } from '../src/send/campaign.js';

const NOW = Date.parse('2026-09-01T09:00:00.000Z');
const RECENT = '2026-03-01T00:00:00.000Z';
const ANCIENT = '2020-01-01T00:00:00.000Z';

function set(contacts) {
  const kept = store({ file: ':memory:' });

  for (const contact of contacts) {
    kept.remember(contact);
    if (contact.basis) kept.record({ address: contact.address, ...contact.basis });
    if (contact.suppressed) kept.suppress(contact.address, 'they asked to stop');
  }

  const campaign = kept.createCampaign({
    name: 'March offer',
    subject: 'Hello {{name}}',
    body: 'Your account at {{company}} is unchanged.',
    fromName: 'Harbour Supplies',
    fromAddress: 'hello@example.invalid',
  });

  return { kept, campaign };
}

const consented = (address, extra = {}) => ({
  address,
  name: address.split('@')[0],
  fields: { company: 'Harbour Clinic' },
  basis: { kind: 'consent', recordedAt: RECENT, source: 'the sign-up form' },
  ...extra,
});

/** Counts every send, so a test can prove one did not happen. */
function counting() {
  const sent = [];

  return {
    sent,
    name: 'counting',
    async send(message) {
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
      { address: 'nothing@example.invalid', name: 'Nothing', fields: { company: 'X' } },
      consented('old@example.invalid', { basis: { kind: 'consent', recordedAt: ANCIENT, source: 'the old list' } }),
      consented('stopped@example.invalid', { suppressed: true }),
    ]);

    const said = decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    assert.equal(said.allowed, 1);
    assert.equal(said.refused, 3);
    assert.deepEqual(Object.keys(said.refusals).sort(), ['basis-stale', 'no-basis', 'suppressed']);

    // A refusal that is only a number in a summary cannot answer "why did this
    // person not get it", which is the question somebody always asks.
    const rows = kept.forCampaign(campaign.id);
    for (const row of rows) assert.ok(row.why?.length > 0, `${row.address} was refused with no reason`);

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

    const [row] = kept.waiting(campaign.id);
    assert.equal(row.subject, 'Hello a');
    assert.equal(row.body, 'Your account at Harbour Clinic is unchanged.');
    kept.close();
  });
});

describe('sending what was allowed', () => {
  it('sends to exactly the people who were allowed', async () => {
    const { kept, campaign } = set([
      consented('yes@example.invalid'),
      { address: 'no@example.invalid', name: 'No', fields: { company: 'X' } },
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
      async send(message) {
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

    const dropped = kept.forCampaign(campaign.id).find((one) => one.address === 'b@example.invalid');
    assert.match(dropped.why, /it changed after this campaign was worked out/);

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
        async send(message) {
          if (message.to === 'b@example.invalid') throw new Error('550 5.1.1 No such person here');
          return { why: 'sent' };
        },
      },
    });

    assert.equal(said.sent, 2);
    assert.equal(said.failed, 1);

    const failed = kept.forCampaign(campaign.id).find((one) => one.state === 'failed');
    assert.match(failed.why, /550/);
    kept.close();
  });

  it('measures the gap from the start of one send to the start of the next', async () => {
    // Not from the end. Measuring from the end lets a fast transport send as
    // fast as it likes, and a burst from one sender is what gets a whole
    // domain's reputation punished rather than one campaign's.
    const { kept, campaign } = set([consented('a@example.invalid'), consented('b@example.invalid')]);

    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const waited = [];

    await run({
      store: kept,
      campaign,
      perMinute: 60, // one a second
      transport: {
        name: 'slow',
        async send() {
          await new Promise((done) => setTimeout(done, 40));
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

  it('does not wait after the last one', async () => {
    const { kept, campaign } = set([consented('a@example.invalid')]);
    decide({ store: kept, campaign, contacts: kept.everybody(), now: NOW });

    const waited = [];
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
