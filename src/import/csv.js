/**
 * Reading a list of people out of a spreadsheet somebody exported.
 *
 * Two jobs, and the second is the one that matters.
 *
 * **Parsing CSV** is a small amount of fiddly work that everybody underestimates
 * — quoted fields with commas in them, quotes inside quotes, newlines inside
 * quotes, a byte-order mark, semicolons because the export came from a machine
 * set to Italian. Written out rather than pulled in, because it is fifty lines
 * and the alternative is a dependency in a project that has one.
 *
 * **Working out which column is which** is the interesting half. The original
 * this comes from had a routine for spotting the column of phone numbers; the
 * same idea applies more usefully to consent. A spreadsheet that has a column
 * saying when somebody agreed and where is a spreadsheet that can be imported
 * safely; one that has only addresses is a list, and this says so rather than
 * importing four hundred people with nothing recorded about any of them.
 */

/**
 * Splits CSV into rows, honouring quotes.
 *
 * The delimiter is worked out from the header rather than assumed. An export
 * from a machine set to Italian uses semicolons, and a parser that assumes
 * commas reads the whole thing as one column with a very long name — which
 * looks like an empty import rather than like a delimiter problem.
 */
export function rows(text) {
  const clean = String(text ?? '').replace(/^﻿/, '');
  if (!clean.trim()) return [];

  const firstLine = clean.split(/\r?\n/)[0] ?? '';
  const delimiter = countOutsideQuotes(firstLine, ';') > countOutsideQuotes(firstLine, ',') ? ';' : ',';

  const out = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let at = 0; at < clean.length; at += 1) {
    const ch = clean[at];

    if (inQuotes) {
      if (ch === '"') {
        // Two quotes inside a quoted field are one quote. Anything else ends it.
        if (clean[at + 1] === '"') {
          field += '"';
          at += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      out.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    out.push(row);
  }

  return out.filter((one) => one.some((cell) => cell.trim() !== ''));
}

function countOutsideQuotes(line, ch) {
  let count = 0;
  let inQuotes = false;

  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ch && !inQuotes) count += 1;
  }

  return count;
}

/**
 * What each column probably is.
 *
 * By header first — that is what headers are for — and by looking at the values
 * only when the header says nothing useful. A column called "Column 3" full of
 * things with an @ in them is an address column whatever it is called.
 *
 * Everything it decides comes back with WHY, because an importer that silently
 * decides column 4 is the consent date is an importer nobody can correct.
 */
const BY_HEADER = [
  { field: 'address', words: /\b(e-?mail|mail|address|indirizzo|posta)\b/i },
  { field: 'name', words: /\b(name|nome|full ?name|contact|nominativo|referente)\b/i },
  { field: 'consentAt', words: /\b(consent|opt.?in|agreed|iscrizione|consenso|subscribed)\b.*\b(at|on|date|data)\b|\b(consent|opt.?in|consenso)\b/i },
  { field: 'consentSource', words: /\b(source|where|origin|provenienza|fonte|form)\b/i },
  { field: 'suppressed', words: /\b(unsubscrib\w*|opt.?out|suppress\w*|disiscritt\w*|bounced)\b/i },
];

export function whatTheColumnsAre(header, sample = []) {
  return header.map((title, at) => {
    const clean = String(title ?? '').trim();

    for (const guess of BY_HEADER) {
      if (guess.words.test(clean)) {
        return { at, title: clean, field: guess.field, why: `the header says "${clean}"` };
      }
    }

    // Nothing in the header. Look at what is actually in the column.
    const values = sample.map((row) => String(row[at] ?? '').trim()).filter(Boolean);

    if (values.length > 0) {
      const withAt = values.filter((one) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(one)).length;
      if (withAt / values.length > 0.8) {
        return { at, title: clean, field: 'address', why: 'nearly everything in it is an address' };
      }

      const dates = values.filter((one) => !Number.isNaN(Date.parse(one))).length;
      if (dates / values.length > 0.8 && values.every((one) => /\d{4}|\d{1,2}[/-]\d{1,2}/.test(one))) {
        return { at, title: clean, field: 'maybeDate', why: 'nearly everything in it is a date' };
      }
    }

    return { at, title: clean, field: 'other', why: 'nothing said what this is' };
  });
}

/**
 * Turns a spreadsheet into contacts, and says what it could not do.
 *
 * A row with no address is not imported. A row with an address and no consent
 * IS imported — as a contact with no basis, which the permission rules will
 * refuse. That is deliberate: the contact exists, somebody can go and find out
 * where they came from and record it, and until they do nothing can be sent.
 * Dropping the row would hide the work; importing it as sendable would be the
 * whole failure this project is against.
 */
export function read(text) {
  const all = rows(text);
  if (all.length === 0) return { contacts: [], columns: [], trouble: ['there is nothing in that file'] };

  const [header, ...body] = all;
  const columns = whatTheColumnsAre(header, body.slice(0, 25));

  const where = (field) => columns.find((one) => one.field === field)?.at ?? -1;

  const at = {
    address: where('address'),
    name: where('name'),
    consentAt: where('consentAt'),
    consentSource: where('consentSource'),
    suppressed: where('suppressed'),
  };

  const trouble = [];
  if (at.address === -1) trouble.push('no column in that file looks like an address');
  if (at.consentAt === -1) {
    trouble.push(
      'no column says when anybody agreed to be contacted, so nothing imported from this file can be sent to until somebody records it'
    );
  }

  const contacts = [];
  const skipped = [];

  for (const [line, row] of body.entries()) {
    const address = at.address === -1 ? '' : String(row[at.address] ?? '').trim().toLowerCase();

    if (!address) {
      skipped.push({ line: line + 2, why: 'no address' });
      continue;
    }

    const fields = {};
    for (const column of columns) {
      if (column.field !== 'other' && column.field !== 'maybeDate') continue;
      const key = keyFor(column.title, column.at);
      fields[key] = String(row[column.at] ?? '').trim();
    }

    const consentAt = at.consentAt === -1 ? null : String(row[at.consentAt] ?? '').trim();

    contacts.push({
      address,
      name: at.name === -1 ? null : String(row[at.name] ?? '').trim() || null,
      fields,
      basis: consentAt
        ? {
            kind: 'consent',
            recordedAt: asDate(consentAt),
            source:
              (at.consentSource === -1 ? '' : String(row[at.consentSource] ?? '').trim()) ||
              'the imported file',
          }
        : null,
      suppressed: at.suppressed === -1 ? false : yes(String(row[at.suppressed] ?? '')),
    });
  }

  return { contacts, columns, trouble, skipped };
}

/** A column heading, as something a template can name. */
function keyFor(title, at) {
  const clean = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  return clean || `column_${at + 1}`;
}

/**
 * A date somebody typed, as an ISO date.
 *
 * `01/03/2026` is the first of March everywhere except the United States, and
 * a spreadsheet exported in Europe is full of them. `Date.parse` reads it as
 * the third of January — which makes a two-year-old consent look fresh, or a
 * fresh one look stale. When the shape is ambiguous it is read day-first,
 * because that is where these files come from, and the README says so.
 */
export function asDate(text) {
  const said = String(text ?? '').trim();

  const dayFirst = said.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  }

  const parsed = Date.parse(said);
  return Number.isNaN(parsed) ? said : new Date(parsed).toISOString();
}

function yes(text) {
  return /^(y|yes|true|1|si|sì|x)$/i.test(String(text ?? '').trim());
}
