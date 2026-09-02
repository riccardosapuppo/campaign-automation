/**
 * How a message is put together, and where it goes.
 *
 * The conversation with a server is checked against a real one in
 * `npm run walkthrough` and against somebody else's in `npm run check:smtp`.
 * What is left here is the part that has no socket in it and is still easy to
 * get silently wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { asHeader, asMail, toFolder, dryRun } from '../src/send/transports.js';

const message = {
  to: 'anna@example.invalid',
  from: { name: 'Harbour Supplies', address: 'hello@example.invalid' },
  subject: 'Your March prices',
  body: 'Hello Anna,\n\nHere they are.',
};

describe('the message as a mail', () => {
  it('has the headers a mail needs', () => {
    const mail = asMail(message);

    assert.match(mail, /^From: Harbour Supplies <hello@example\.invalid>\r\n/);
    assert.match(mail, /\r\nTo: anna@example\.invalid\r\n/);
    assert.match(mail, /\r\nSubject: Your March prices\r\n/);
    assert.match(mail, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
  });

  it('separates the headers from the body with a blank line', () => {
    // Without it the body is read as more headers and the message arrives
    // empty — which looks like a template problem for about an hour.
    assert.ok(asMail(message).includes('\r\n\r\nHello Anna,'));
  });

  it('leaves out the name when there is not one, and keeps the brackets', () => {
    const mail = asMail({ ...message, from: { name: '', address: 'hello@example.invalid' } });

    assert.match(mail, /^From: <hello@example\.invalid>\r\n/);
  });

  it('writes the date the caller gave it', () => {
    // Injected rather than read from the clock, so this file says the same
    // thing in two years as it does today.
    const mail = asMail({ ...message, at: new Date('2026-03-01T09:00:00Z') });

    assert.match(mail, /\r\nDate: Sun, 01 Mar 2026 09:00:00 GMT\r\n/);
  });

  it('ends every line with CRLF, including inside the body', () => {
    // A lone newline inside a message is not what the protocol says, and some
    // servers take it as the end of the headers wherever it appears.
    const mail = asMail(message);
    const lonely = mail.split('\r\n').join('').includes('\n');

    assert.equal(lonely, false, 'there is a newline in there that is not part of a CRLF');
  });

  describe('dot-stuffing', () => {
    it('sends a line that starts with a dot as two dots', () => {
      // A lone dot on its own line ends the message. Without this, a body
      // containing a line like "...and finally" truncates every message that
      // has one, and only those — so it is invisible until it is not.
      const mail = asMail({ ...message, body: 'first\n.\nlast' });

      assert.ok(mail.includes('\r\n..\r\n'), 'the lone dot was not stuffed');
    });

    it('stuffs a line that merely begins with a dot', () => {
      const mail = asMail({ ...message, body: '...and finally' });

      assert.ok(mail.includes('\r\n....and finally'), 'the leading dots were not stuffed');
    });

    it('leaves a dot in the middle of a line alone', () => {
      const mail = asMail({ ...message, body: 'see www.example.invalid for more' });

      assert.ok(mail.includes('see www.example.invalid for more'));
    });

    it('does not stuff the headers', () => {
      // Dot-stuffing belongs on the body, once, on the way out. Applied to the
      // whole conversation it would corrupt the commands as well.
      assert.match(asMail({ ...message, subject: '.important' }), /\r\nSubject: \.important\r\n/);
    });
  });
});

describe('a header with somebody’s name in it', () => {
  it('leaves plain ASCII exactly as it was', () => {
    // So the common case stays readable to anybody looking at the raw message.
    assert.equal(asHeader('Your March prices'), 'Your March prices');
  });

  it('encodes an accent, because a mail header has nowhere to say it is UTF-8', () => {
    // `Subject: Perché?` is not a subject with an accent in it — it is bytes
    // that every reader interprets for itself, which is why the same message
    // arrives as "PerchÃ©" in one client and "Perch?" in another.
    assert.equal(asHeader('Perché'), '=?UTF-8?B?UGVyY2jDqQ==?=');
  });

  it('keeps every encoded word inside the 75 characters the standard allows', () => {
    // A single long encoded word is not rejected, it is silently mangled.
    for (const word of asHeader('è'.repeat(200)).split('\r\n ')) {
      assert.ok(word.length <= 75, `an encoded word came out ${word.length} characters long`);
    }
  });

  it('never cuts a character in half', () => {
    // Splitting by bytes rather than by characters puts a replacement mark in
    // the middle of somebody's name.
    const said = 'àèìòù '.repeat(40).trim();
    const back = asHeader(said)
      .split('\r\n ')
      .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');

    assert.equal(back, said);
  });
});

describe('the transport that sends nothing', () => {
  it('is the default, and says what it did not do', async () => {
    const said = await dryRun().send(message);

    assert.match(said.why, /nothing was sent/);
  });

  it('still renders everything, so it is a real rehearsal', async () => {
    const seen = [];
    await dryRun({ onMessage: (one) => seen.push(one) }).send(message);

    assert.equal(seen[0].to, 'anna@example.invalid');
  });
});

describe('the transport that writes to a folder', () => {
  it('writes one readable file per message', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-outbox-'));

    try {
      const transport = toFolder({ folder });
      await transport.send(message);
      await transport.send({ ...message, to: 'ben@example.invalid' });

      const files = fs.readdirSync(folder).sort();

      assert.deepEqual(files, ['0001-anna@example.invalid.eml', '0002-ben@example.invalid.eml']);
      assert.match(fs.readFileSync(path.join(folder, files[0]), 'utf8'), /Subject: Your March prices/);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('will not let an address name a file anywhere else', async () => {
    // An address is not a path, and something that came out of a spreadsheet
    // is the last thing that should be choosing where a file lands.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-outbox-'));

    try {
      await toFolder({ folder }).send({ ...message, to: '../../escaped@example.invalid' });

      assert.deepEqual(fs.readdirSync(folder), ['0001-.._.._escaped@example.invalid.eml']);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
