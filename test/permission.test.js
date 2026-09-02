import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { looksLikeStop, mayReceive, sortOut } from '../src/rules/permission.js';

/**
 * The suite that matters. Everything else in this project is plumbing; this is
 * the part that decides whether a message reaches somebody who never asked for
 * it, and every case below is one a real campaign meets.
 */

const NOW = Date.parse('2026-09-01T12:00:00Z');

const who = (over = {}) => ({
  address: 'someone@example.invalid',
  basis: { kind: 'consent', recordedAt: '2026-03-01T09:00:00Z', source: 'the sign-up form' },
  suppressed: false,
  suppressedWhy: null,
  ...over,
});

describe('who may be written to', () => {
  it('lets through somebody who agreed, recently, and said where', () => {
    const said = mayReceive(who(), { now: NOW });

    assert.equal(said.ok, true);
    assert.match(said.why, /consent, recorded 184 days ago from the sign-up form/);
  });

  it('refuses somebody with nothing recorded about them', () => {
    // The pasted list of numbers. This is the case the whole file exists for.
    const said = mayReceive(who({ basis: null }), { now: NOW });

    assert.equal(said.ok, false);
    assert.equal(said.code, 'no-basis');
  });

  it('refuses somebody on the suppression list even though they once agreed', () => {
    const said = mayReceive(who({ suppressed: true, suppressedWhy: 'replied STOP' }), { now: NOW });

    assert.equal(said.ok, false);
    assert.equal(said.code, 'suppressed');
    assert.match(said.why, /replied STOP/);
  });

  it('checks suppression BEFORE it looks at consent', () => {
    // The order of two ifs is the whole difference between a tool that honours
    // an unsubscribe and one that reasons "but they did agree once".
    const both = mayReceive(who({ suppressed: true, basis: null }), { now: NOW });

    assert.equal(both.code, 'suppressed', 'a person who asked to stop is not "missing a basis"');
  });

  it('refuses a basis it does not recognise, and says what it knows', () => {
    const said = mayReceive(who({ basis: { kind: 'they are on our list', recordedAt: '2026-03-01', source: 'x' } }), {
      now: NOW,
    });

    assert.equal(said.code, 'unknown-basis');
    assert.match(said.why, /consent, legitimate-interest/);
  });

  it('refuses a basis with no date', () => {
    const said = mayReceive(who({ basis: { kind: 'consent', source: 'a form' } }), { now: NOW });

    assert.equal(said.code, 'basis-undated');
  });

  it('refuses a basis dated in the future rather than treating it as fresh', () => {
    // A wrong clock, or somebody typing a date. The naive "is it older than two
    // years" test passes it, because a date in the future is older than nothing.
    const said = mayReceive(
      who({ basis: { kind: 'consent', recordedAt: '2027-01-01T00:00:00Z', source: 'a form' } }),
      { now: NOW }
    );

    assert.equal(said.code, 'basis-in-the-future');
  });

  it('refuses one that has gone stale, and says how old it is', () => {
    const said = mayReceive(
      who({ basis: { kind: 'consent', recordedAt: '2020-01-01T00:00:00Z', source: 'a form' } }),
      { now: NOW }
    );

    assert.equal(said.code, 'basis-stale');
    assert.match(said.why, /2435 days ago/);
  });

  it('refuses one that does not say where it came from', () => {
    // "They consented" with no record of where is not a record of anything, and
    // it is the one that cannot be checked when somebody complains.
    const said = mayReceive(who({ basis: { kind: 'consent', recordedAt: '2026-03-01T09:00:00Z' } }), {
      now: NOW,
    });

    assert.equal(said.code, 'basis-unsourced');
  });

  it('accepts an existing relationship as its own basis', () => {
    const said = mayReceive(
      who({
        basis: {
          kind: 'legitimate-interest',
          recordedAt: '2026-06-01T00:00:00Z',
          source: 'order 4471',
        },
      }),
      { now: NOW }
    );

    assert.equal(said.ok, true);
  });

  it('refuses a contact with no address at all', () => {
    assert.equal(mayReceive(who({ address: '' }), { now: NOW }).code, 'no-address');
    assert.equal(mayReceive(null, { now: NOW }).code, 'no-address');
  });
});

describe('somebody asking to stop', () => {
  it('recognises a bare keyword, which is how the networks define it', () => {
    for (const said of ['STOP', 'stop', ' Stop ', 'Stop.', 'unsub', 'UNSUBSCRIBE', 'quit', 'no']) {
      assert.equal(looksLikeStop(said).yes, true, `"${said}" should have been read as a stop`);
    }
  });

  it('recognises the phrases people write instead', () => {
    for (const said of [
      'Please unsubscribe me',
      'opt out',
      'opt-out please',
      'remove me from this list',
      'Could you take me off, thanks',
      'no more emails please',
      'disiscrivimi',
      'cancellami da questa lista',
      'non inviarmi altro',
    ]) {
      assert.equal(looksLikeStop(said).yes, true, `"${said}" should have been read as a stop`);
    }
  });

  it('does not read an ordinary reply as one', () => {
    // "Non-stop until Friday" was read as a stop by the first version, which
    // matched `\bstop\b` anywhere — so a customer telling you about their week
    // was silently unsubscribed. Over-matching loses people quietly; that is
    // why the bare keywords only count when they are the whole message.
    for (const said of [
      'Thanks, that is useful',
      'Can you send the invoice?',
      'Non-stop until Friday',
      'We had to stop the line twice today',
      'Please do not cancel the order',
      'No, Tuesday is better',
    ]) {
      assert.equal(looksLikeStop(said).yes, false, `"${said}" should NOT have been read as a stop`);
    }
  });
});

describe('sorting a list', () => {
  it('gives back both halves, never just the sendable one', () => {
    // A tool that quietly drops the refusals leaves somebody wondering why 400
    // contacts became 312, and that question is the most interesting thing in
    // the run.
    const said = sortOut(
      [
        who(),
        who({ address: 'b@example.invalid', suppressed: true }),
        who({ address: 'c@example.invalid', basis: null }),
        who({ address: 'd@example.invalid' }),
      ],
      { now: NOW }
    );

    assert.equal(said.allowed.length, 2);
    assert.equal(said.refused.length, 2);
    assert.deepEqual(said.counted, { suppressed: 1, 'no-basis': 1 });
  });

  it('counts the refusals by reason, so a bad import is obvious', () => {
    const said = sortOut(
      Array.from({ length: 5 }, (_, at) => who({ address: `${at}@example.invalid`, basis: null })),
      { now: NOW }
    );

    assert.deepEqual(said.counted, { 'no-basis': 5 });
  });
});
