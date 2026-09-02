/**
 * Reading a spreadsheet somebody exported.
 *
 * Most of these are cases that came out of real exports rather than out of the
 * specification: a semicolon delimiter, a byte-order mark, a date written the
 * way most of the world writes it, and a header that says nothing at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { read, rows, whatTheColumnsAre, asDate } from '../src/import/csv.js';

describe('splitting the file up', () => {
  it('reads a plain comma-separated file', () => {
    assert.deepEqual(rows('a,b\n1,2\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('works out the delimiter from the header rather than assuming one', () => {
    // An export from a machine set to Italian uses semicolons. A parser that
    // assumes commas reads the whole file as one column with a very long name,
    // which looks like an empty import rather than like a delimiter problem.
    assert.deepEqual(rows('name;email\nAnna;anna@example.invalid\n'), [
      ['name', 'email'],
      ['Anna', 'anna@example.invalid'],
    ]);
  });

  it('keeps a comma that is inside quotes', () => {
    assert.deepEqual(rows('name,note\n"Vidal, Carla",fine\n')[1], ['Vidal, Carla', 'fine']);
  });

  it('reads two quotes inside a quoted field as one quote', () => {
    assert.deepEqual(rows('note\n"they said ""stop"""\n')[1], ['they said "stop"']);
  });

  it('keeps a newline that is inside quotes', () => {
    assert.deepEqual(rows('note\n"first\nsecond"\n')[1], ['first\nsecond']);
  });

  it('survives the byte-order mark Excel writes', () => {
    // Without this the first column is called "﻿Name" and nothing matches
    // it — an import that finds no address column in a file that plainly has
    // one, which is a confusing morning.
    assert.equal(rows('﻿Name,Email\nAnna,anna@example.invalid\n')[0][0], 'Name');
  });

  it('ignores blank lines', () => {
    assert.equal(rows('a,b\n\n1,2\n\n').length, 2);
  });

  it('has nothing to say about an empty file', () => {
    assert.deepEqual(rows(''), []);
    assert.deepEqual(rows('   \n'), []);
  });
});

describe('working out what the columns are', () => {
  it('goes by the header when the header says something', () => {
    const columns = whatTheColumnsAre(['Full name', 'E-mail', 'Consent given on', 'Where from']);

    assert.deepEqual(
      columns.map((one) => one.field),
      ['name', 'address', 'consentAt', 'consentSource']
    );
  });

  it('looks at the values when the header says nothing', () => {
    const columns = whatTheColumnsAre(
      ['Column 1', 'Column 2'],
      [
        ['anna@example.invalid', 'Harbour Clinic'],
        ['ben@example.invalid', 'Marsh Lane'],
        ['carla@example.invalid', 'Quay Road'],
      ]
    );

    assert.equal(columns[0].field, 'address');
    assert.match(columns[0].why, /nearly everything in it is an address/);
    assert.equal(columns[1].field, 'other');
  });

  it('says why it decided, for every column', () => {
    // A column this got wrong is a column somebody has to be able to argue
    // with. An importer that silently decides column 4 is the consent date is
    // an importer nobody can correct.
    for (const column of whatTheColumnsAre(['Name', 'Whatever'])) {
      assert.ok(column.why.length > 0, `${column.title} came back with no reason`);
    }
  });
});

describe('reading a whole file', () => {
  const file = [
    'Name;Email;Company;Consent given on;Where from;Unsubscribed',
    'Anna Rossi;ANNA.ROSSI@example.invalid;Harbour Clinic;01/03/2026;the sign-up form;',
    'Dan Petrov;dan@example.invalid;Northgate;;;',
    'Eve Lindqvist;eve@example.invalid;Harbour Clinic;09/05/2026;the sign-up form;yes',
    ';nobody@example.invalid;;;;',
    'No Address;;Marsh Lane;01/03/2026;the sign-up form;',
  ].join('\n');

  it('lowercases the address, because that is the key everything else uses', () => {
    // A suppression is keyed on the address. If one import stores
    // ANNA.ROSSI@... and the next stores anna.rossi@..., somebody who
    // unsubscribed is written to again by the same tool that recorded it.
    assert.equal(read(file).contacts[0].address, 'anna.rossi@example.invalid');
  });

  it('imports somebody with no consent, and gives them no basis', () => {
    // Deliberate: the contact exists so somebody can go and find out where
    // they came from, and until they do, the permission rules refuse them.
    // Dropping the row hides the work; importing them as sendable is the whole
    // failure this project is against.
    const dan = read(file).contacts.find((one) => one.address === 'dan@example.invalid');

    assert.equal(dan.basis, null);
  });

  it('believes a spreadsheet that says somebody unsubscribed', () => {
    const eve = read(file).contacts.find((one) => one.address === 'eve@example.invalid');

    assert.equal(eve.suppressed, true);
  });

  it('skips a row with no address, and says which one', () => {
    const said = read(file);

    assert.equal(said.contacts.some((one) => one.name === 'No Address'), false);
    assert.deepEqual(said.skipped, [{ line: 6, why: 'no address' }]);
  });

  it('keeps the columns it could not name, so a template can use them', () => {
    assert.equal(read(file).contacts[0].fields.company, 'Harbour Clinic');
  });

  it('says so when the file records nobody agreeing to anything', () => {
    const said = read('Name,Email\nAnna,anna@example.invalid\n');

    assert.match(said.trouble.join(' '), /no column says when anybody agreed/);
  });

  it('says so when there is no address column at all', () => {
    assert.match(read('Name,Town\nAnna,Genoa\n').trouble.join(' '), /looks like an address/);
  });
});

describe('a date somebody typed', () => {
  it('reads 01/03/2026 as the first of March', () => {
    // `Date.parse` reads it as the third of January, because it assumes the
    // one country that writes month first. Two months of drift is the
    // difference between a consent that is current and one that is stale.
    assert.equal(asDate('01/03/2026').slice(0, 10), '2026-03-01');
  });

  it('reads an ISO date as itself', () => {
    assert.equal(asDate('2026-03-01').slice(0, 10), '2026-03-01');
  });

  it('hands back anything it cannot read, rather than inventing a date', () => {
    // The permission rules refuse a basis whose date is not a date. Turning
    // "last spring" into today would turn an unusable record into a fresh
    // consent, which is the one direction this must never fail in.
    assert.equal(asDate('last spring'), 'last spring');
  });
});
