/**
 * Filling a template in.
 *
 * The tests that matter are the ones about a field that is not there, because
 * every wrong answer to that question is a message somebody receives.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fill, fieldsIn, whoIsMissingSomething } from '../src/render/template.js';

const anna = {
  address: 'anna@example.invalid',
  name: 'Anna',
  fields: { company: 'Harbour Clinic', order: 'A-4471' },
};

describe('filling one in', () => {
  it('puts the values in', () => {
    assert.equal(fill('Hello {{name}}, order {{order}}.', anna).text, 'Hello Anna, order A-4471.');
  });

  it('takes fields.x as well as a bare name', () => {
    assert.equal(fill('{{fields.company}} / {{company}}', anna).text, 'Harbour Clinic / Harbour Clinic');
  });

  it('ignores the spaces people leave in the braces', () => {
    assert.equal(fill('Hello {{  name  }}', anna).text, 'Hello Anna');
  });

  it('says which field is missing, and leaves the placeholder where it is', () => {
    // Three answers, and two are common and wrong: leave the placeholder and
    // send "Hello {{name}}" to four hundred people, or blank it and send
    // "Hello ,". This does neither — it reports, and the campaign refuses.
    const said = fill('Hello {{name}}, about {{invoice}}', anna);

    assert.deepEqual(said.missing, ['invoice']);
    assert.match(said.text, /\{\{invoice\}\}/);
  });

  it('treats a field that is there but empty as missing', () => {
    // An exported spreadsheet is full of empty cells, and an empty cell is not
    // a value. "Your account at  is unchanged" is the message this prevents.
    const said = fill('at {{company}}', { ...anna, fields: { company: '   ' } });

    assert.deepEqual(said.missing, ['company']);
  });

  it('uses a fallback the template asked for', () => {
    // `{{name | there}}` is the author saying out loud what should happen,
    // which is different from the tool deciding on their behalf. There is no
    // default default.
    const said = fill('Hello {{name | there}}', { address: 'x@example.invalid', fields: {} });

    assert.equal(said.text, 'Hello there');
    assert.deepEqual(said.missing, []);
  });

  it('records that it fell back, so it is visible', () => {
    const said = fill('Hello {{name | there}}', { address: 'x@example.invalid', fields: {} });

    assert.deepEqual(said.used, ['name (fell back)']);
  });

  it('reports a missing field once however many times it appears', () => {
    assert.deepEqual(fill('{{x}} {{x}} {{x}}', anna).missing, ['x']);
  });
});

describe('what a template is allowed to reach', () => {
  it('will not read the consent trail into a message', () => {
    // A template is written by whoever runs the campaign and read by a program
    // that also holds the consent records. `{{basis.source}}` in a subject
    // line would put somebody's consent trail in an email.
    const contact = { ...anna, basis: { kind: 'consent', source: 'the sign-up form' } };

    assert.deepEqual(fill('{{basis.source}}', contact).missing, ['basis.source']);
  });

  it('will not walk up the prototype', () => {
    assert.deepEqual(fill('{{constructor}} {{fields.toString}}', anna).missing, [
      'constructor',
      'fields.toString',
    ]);
  });
});

describe('before anybody presses anything', () => {
  it('lists every field a template asks for', () => {
    assert.deepEqual(fieldsIn('Hi {{name}}, {{company}} — {{name}}'), ['name', 'company']);
  });

  it('says who cannot be written to with this template, and roughly how many', () => {
    // Run over the whole list while somebody is deciding, so "sixteen of these
    // have no company name" is read then rather than discovered afterwards.
    const contacts = [
      anna,
      { address: 'b@example.invalid', name: 'Ben', fields: {} },
      { address: 'c@example.invalid', name: 'Cara', fields: {} },
      { address: 'd@example.invalid', name: 'Dan', fields: {} },
      { address: 'e@example.invalid', name: 'Eve', fields: {} },
    ];

    const [trouble] = whoIsMissingSomething('at {{company}}', contacts);

    assert.equal(trouble.field, 'company');
    assert.equal(trouble.howMany, 4);
    // A few, not four hundred: a list nobody reads is a list nobody reads.
    assert.equal(trouble.forExample.length, 3);
  });

  it('has nothing to say when the template fits everybody', () => {
    assert.deepEqual(whoIsMissingSomething('Hello {{name}}', [anna]), []);
  });
});
