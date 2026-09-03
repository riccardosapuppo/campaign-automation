/**
 * What is written down, and what cannot be unwritten.
 *
 * These are the tests that defend the two decisions in the schema: a basis is
 * a row rather than a column, and a suppression is keyed on the address rather
 * than on a contact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { store } from '../src/store/db.ts';
import { mayReceive } from '../src/rules/permission.ts';

const anna = { address: 'anna@example.invalid', name: 'Anna', fields: { company: 'Harbour Clinic' }, basis: null, suppressed: false, suppressedWhy: null };

function fresh() {
  return store({ file: ':memory:' });
}

describe('a contact', () => {
  it('comes back in the shape the permission rules read', () => {
    const kept = fresh();
    kept.remember(anna);
    kept.record({
      address: anna.address,
      kind: 'consent',
      recordedAt: '2026-03-01T00:00:00.000Z',
      source: 'the sign-up form',
    });

    const said = kept.contact(anna.address);

    assert.equal(said!.basis!.kind, 'consent');
    assert.equal(said!.suppressed, false);
    assert.equal(mayReceive(said!, { now: Date.parse('2026-09-01') }).ok, true);

    kept.close();
  });

  it('re-imported, keeps the basis it already had', () => {
    // Re-importing last month's spreadsheet is the commonest thing anybody
    // does with a tool like this, and it must not be a way to reset what
    // somebody agreed to. The name and the fields are overwritten; the reason
    // they may be contacted is not, because it is not in that table.
    const kept = fresh();
    kept.remember(anna);
    kept.record({ address: anna.address, kind: 'consent', recordedAt: '2026-03-01', source: 'the form' });

    kept.remember({ ...anna, name: 'Anna Rossi', fields: { company: 'Harbour Clinic Ltd' } });

    const said = kept.contact(anna.address);
    assert.equal(said!.name, 'Anna Rossi');
    assert.equal(said!.basis!.source, 'the form');

    kept.close();
  });

  it('does not turn one consent into four when the same file is imported again', () => {
    const kept = fresh();

    for (let time = 0; time < 4; time += 1) {
      kept.record({ address: anna.address, kind: 'consent', recordedAt: '2026-03-01', source: 'the form' });
    }

    assert.equal(kept!.counts().bases, 1);
    kept.close();
  });
});

describe('why somebody may be contacted', () => {
  it('is appended, so changing your mind twice leaves three rows', () => {
    // A boolean column cannot say when, where, or what somebody agreed to, and
    // it cannot say what it said before somebody changed it.
    const kept = fresh();
    kept.remember(anna);

    kept.record({ address: anna.address, kind: 'consent', recordedAt: '2024-01-01', source: 'the old form' });
    kept.record({ address: anna.address, kind: 'legitimate-interest', recordedAt: '2025-06-01', source: 'an order' });
    kept.record({ address: anna.address, kind: 'consent', recordedAt: '2026-03-01', source: 'the new form' });

    assert.equal(kept!.historyOf(anna.address).bases.length, 3);
    kept.close();
  });

  it('and the newest of them is the one that counts', () => {
    const kept = fresh();
    kept.remember(anna);

    kept.record({ address: anna.address, kind: 'consent', recordedAt: '2024-01-01', source: 'the old form' });
    kept.record({ address: anna.address, kind: 'consent', recordedAt: '2026-03-01', source: 'the new form' });

    assert.equal(kept.contact(anna.address)!.basis!.source, 'the new form');
    kept.close();
  });
});

describe('somebody who asked to stop', () => {
  it('stays stopped when the contact is deleted and imported again', () => {
    // Deleting a contact who unsubscribed feels tidy and is the bug: they are
    // re-imported next month from the same spreadsheet, arrive with no
    // history, and are written to again. So the suppression is keyed on the
    // address and outlives any contact row.
    const kept = fresh();
    kept.remember(anna);
    kept.suppress(anna.address, 'they replied STOP');

    kept.db.exec(`DELETE FROM contacts WHERE address = '${anna.address}'`);
    assert.equal(kept!.contact(anna.address), null);

    kept.remember(anna);
    kept.record({ address: anna.address, kind: 'consent', recordedAt: '2026-03-01', source: 'the form' });

    const said = kept.contact(anna.address);
    assert.equal(said!.suppressed, true);
    assert.equal(mayReceive(said!).ok, false);

    kept.close();
  });

  it('can be recorded for somebody who is not on the list at all', () => {
    // Which is the point of keying it on the address: a request to stop must
    // never fail because we have not heard of them yet.
    const kept = fresh();
    kept.suppress('stranger@example.invalid', 'they wrote in');

    kept.remember({ basis: null, suppressed: false, suppressedWhy: null, address: 'stranger@example.invalid', fields: {} });
    assert.equal(kept.contact('stranger@example.invalid')!.suppressed, true);

    kept.close();
  });
});

describe('a campaign', () => {
  it('writes the row before anything is sent, and can be counted afterwards', () => {
    const kept = fresh();
    const campaign = kept.createCampaign({
      name: 'March',
      subject: 'hello',
      body: 'hello',
      fromName: 'Us',
      fromAddress: 'us@example.invalid',
    });

    kept.decide({ campaignId: campaign!.id, address: 'a@example.invalid', state: 'allowed', why: 'consent' });
    kept.decide({
      campaignId: campaign!.id,
      address: 'b@example.invalid',
      state: 'refused',
      why: 'no basis',
      code: 'no-basis',
    });

    const said = kept.howItWent(campaign!.id);
    assert.equal(said!.allowed, 1);
    assert.equal(said!.refused, 1);
    assert.deepEqual(said!.refusals, { 'no-basis': 1 });

    kept.close();
  });

  it('cannot write two rows for the same person', () => {
    // Otherwise a campaign run twice writes to everybody twice, and the count
    // of who received it is wrong in the direction that matters.
    const kept = fresh();
    const campaign = kept.createCampaign({
      name: 'March',
      subject: 'hello',
      body: 'hello',
      fromName: 'Us',
      fromAddress: 'us@example.invalid',
    });

    kept.decide({ campaignId: campaign!.id, address: 'a@example.invalid', state: 'allowed', why: 'consent' });
    kept.decide({ campaignId: campaign!.id, address: 'a@example.invalid', state: 'allowed', why: 'consent' });

    assert.equal(kept!.forCampaign(campaign!.id).length, 1);
    kept.close();
  });
});
