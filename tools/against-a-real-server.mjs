#!/usr/bin/env node
/**
 * The same messages, sent to an SMTP server nobody here wrote.
 *
 *     npm run check:smtp
 *
 * The sink under `sink/` and the client under `src/send/` were written by the
 * same person on the same afternoon, and that is the problem with checking one
 * against the other: **anything they both get wrong, they will agree about.**
 * If the client stuffed dots the wrong way and the sink unstuffed them the
 * same wrong way, every check in this repository would pass and every message
 * would arrive corrupted.
 *
 * So this sends to Mailpit — a mail catcher somebody else maintains, in a
 * container, speaking the same protocol — and reads the messages back out of
 * its own API rather than out of anything here. Four things are checked, and
 * all four are things that look fine until somebody else parses them:
 *
 *   - a line that is a single dot survives
 *   - a line beginning with dots survives with the same number of them
 *   - an accented subject arrives as the accented subject, not as mojibake
 *   - a body of several kilobytes arrives whole, across whatever chunk
 *     boundaries the network chose
 *
 * It needs Docker. If Docker is not there it says so and fails, rather than
 * printing "0 problems" — a check that passes by not running is worse than no
 * check, because it is a check somebody is counting on.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';

import { smtp } from '../src/send/transports.js';

const IMAGE = 'axllent/mailpit:v1.21';
const NAME = 'campaigns-check-smtp';
const SMTP_PORT = 3629;
const WEB_PORT = 3630;

let checks = 0;
let bad = 0;

// ------------------------------------------------------- is Docker even here

if (!works('docker', ['version'])) {
  console.error(
    [
      '',
      "  Docker non risponde, e questo controllo non puo essere eseguito senza.",
      '',
      '  Serve perche il punto e proprio non fidarsi del sink scritto qui dentro:',
      '  il client e il sink sono stati scritti insieme, quindi qualsiasi cosa',
      '  sbaglino allo stesso modo, la sbagliano di comune accordo. Questo',
      '  controllo li mette davanti a un server SMTP di qualcun altro.',
      '',
      `  Avvia Docker Desktop e riprova, oppure esegui:  docker run --rm ${IMAGE}`,
      '',
    ].join('\n')
  );
  process.exit(1);
}

// ------------------------------------------------------------------ the check

console.log(`  starting ${IMAGE}\n`);

execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });

try {
  execFileSync(
    'docker',
    ['run', '-d', '--rm', '--name', NAME, '-p', `127.0.0.1:${SMTP_PORT}:1025`, '-p', `127.0.0.1:${WEB_PORT}:8025`, IMAGE],
    { stdio: 'ignore' }
  );

  // The order matters: the container's own word first, a socket only after.
  await untilTheContainerSaysItIsListening('SMTP server', /\[smtpd\] starting on/);
  await untilTheContainerSaysItIsListening('web interface', /\[http\] starting on/);

  await untilItGreetsUs(SMTP_PORT);
  await untilItAnswersQuestions(WEB_PORT);

  await send();
  await readBack();
} catch (error) {
  // Said as a sentence. Without this the failure arrives as an unhandled
  // rejection with a stack trace from inside a socket handler, printed AFTER
  // the line saying the container was removed — so it reads as though the
  // cleanup broke rather than the check.
  bad += 1;
  checks += 1;
  console.log(`\n  NO    the check could not be carried out\n          ${error.message}`);
} finally {
  // Always, including on the way out of a failure. A check that leaves a
  // container running is a check that has to be cleaned up after.
  execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  console.log(`\n  ${NAME} removed`);
}

console.log(`\n${bad === 0 ? 'tutto a posto' : 'ci sono problemi'}: ${checks - bad}/${checks}`);
process.exitCode = bad === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

/** The four awkward messages, through our own client, over a real socket. */
async function send() {
  const transport = smtp({ host: '127.0.0.1', port: SMTP_PORT });

  const from = { name: 'Harbour Supplies', address: 'hello@example.invalid' };

  await transport.send({
    to: 'plain@example.invalid',
    from,
    subject: 'An ordinary one',
    body: 'Hello Anna,\n\nHere are your prices.\n\nReply STOP and we will not write again.',
  });

  await transport.send({
    to: 'dots@example.invalid',
    from,
    subject: 'Dots',
    body: 'before\n.\nbetween\n...and finally\nafter',
  });

  await transport.send({
    to: 'accents@example.invalid',
    from: { name: 'Marsh Lane Studio — Genova', address: 'hello@example.invalid' },
    subject: 'Perché i prezzi cambiano a marzo — è già ora',
    body: 'Buongiorno,\n\nè tutto confermato: perché no?\n\nSaluti — Marsh Lane',
  });

  await transport.send({
    to: 'long@example.invalid',
    from,
    subject: 'A long one',
    body: Array.from({ length: 400 }, (_, at) => `line ${at + 1}: ${'x'.repeat(40)}`).join('\n'),
  });

  console.log('  four messages sent over a real socket\n');
}

/** And read back out of Mailpit's own API, never out of anything here. */
async function readBack() {
  const list = await json(`/api/v1/messages?limit=50`);
  is('all four arrived', list.messages.length, 4);

  const one = async (to) => {
    const summary = list.messages.find((m) => m.To.some((who) => who.Address === to));
    if (!summary) return null;
    return json(`/api/v1/message/${summary.ID}`);
  };

  // ------------------------------------------------------------ the plain one
  const plain = await one('plain@example.invalid');
  is('the ordinary one has its subject', plain?.Subject, 'An ordinary one');
  is('and the name it was sent from', plain?.From?.Name, 'Harbour Supplies');
  has('and its text', plain?.Text, 'Reply STOP and we will not write again.');

  // -------------------------------------------------------------- the dots
  const dots = await one('dots@example.invalid');
  const lines = String(dots?.Text ?? '').split(/\r?\n/);

  // If dot-stuffing were wrong in the same way at both ends of our own code,
  // this is the check that would still catch it: Mailpit unstuffs by the
  // standard, not by whatever we happen to do.
  is('a line that is a single dot survives it', lines[1], '.');
  is('and so does one that begins with three', lines[3], '...and finally');
  is('and nothing was truncated at the dot', lines[4], 'after');

  // ----------------------------------------------------------- the accents
  const accents = await one('accents@example.invalid');

  // Raw UTF-8 in a header is not a subject with an accent in it — it is bytes
  // that every reader interprets for itself. This is why the header is encoded.
  is('an accented subject arrives as itself', accents?.Subject, 'Perché i prezzi cambiano a marzo — è già ora');
  is('and so does an accented sender name', accents?.From?.Name, 'Marsh Lane Studio — Genova');
  has('and the accented body', accents?.Text, 'è tutto confermato: perché no?');

  // -------------------------------------------------------------- the long
  const long = await one('long@example.invalid');

  // One trailing newline is dropped first. The CRLF before the terminating dot
  // belongs to the protocol rather than to the message, and a receiver is
  // entitled to keep it — so a check that counts it is a check that reports a
  // problem in the wrong place.
  const body = String(long?.Text ?? '').replace(/\r?\n$/, '').split(/\r?\n/);

  // Several kilobytes means the message crossed however many chunk boundaries
  // the operating system felt like. A reader that treats each chunk as a line
  // breaks on exactly the messages big enough to matter.
  is('a long message arrives whole', body.length, 400);
  is('with its first line', body[0], `line 1: ${'x'.repeat(40)}`);
  is('and its last', body[399], `line 400: ${'x'.repeat(40)}`);
}

// ------------------------------------------------------------------- small

function json(url) {
  return fetch(`http://127.0.0.1:${WEB_PORT}${url}`).then((r) => r.json());
}

function is(what, got, wanted) {
  checks += 1;

  if (got === wanted) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted ${JSON.stringify(wanted)}\n          got    ${JSON.stringify(got)}`);
}

function has(what, got, wanted) {
  checks += 1;

  if (String(got ?? '').includes(wanted)) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted something containing ${JSON.stringify(wanted)}\n          got    ${JSON.stringify(got)}`);
}

function works(command, argv) {
  const said = spawnSync(command, argv, { stdio: 'ignore' });
  return said.status === 0;
}

/**
 * Waits for the container to say, itself, that it is listening.
 *
 * **Without touching the network, and this is the whole point.** Three versions
 * of this function were wrong, each in a way that only showed up somewhere else:
 *
 * 1. *Wait for the port to accept a connection.* Docker publishes a port by
 *    binding it on the host the moment the container starts, so a TCP connect
 *    succeeds against Docker's forwarder while the server behind it does not
 *    exist yet. On this workstation the container was ready before the first
 *    message went out and nothing was noticed; on a CI runner it was not, and
 *    the check died with "the server hung up in the middle of the conversation"
 *    — a true sentence about the wrong thing.
 *
 * 2. *Wait for the SMTP `220` greeting.* Better, and still wrong: connecting
 *    through the forwarder BEFORE the server is up leaves it in a state it does
 *    not recover from. Measured here — twenty attempts over twenty-two seconds
 *    all timed out, while the container's own log showed it listening after
 *    four; a single connection made after waiting succeeded first time. The
 *    early knock is what breaks it, so a readiness check that knocks early
 *    cannot be the way.
 *
 * 3. So: read the container's log until the server says it is listening, and
 *    only then open the first socket. Nothing else can produce that line, and
 *    asking for it costs no connection.
 *
 * The log format belongs to Mailpit, which is why the image is pinned to an
 * exact version rather than a tag that moves. If the line ever changes, this
 * fails loudly with what it was waiting for and what it actually saw.
 */
async function untilTheContainerSaysItIsListening(what, saying) {
  let last = '';

  for (let attempt = 0; attempt < 300; attempt += 1) {
    last = String(execFileSync('docker', ['logs', NAME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

    if (saying.test(last)) return;
    await new Promise((done) => setTimeout(done, 100));
  }

  throw new Error(
    `${IMAGE} never said it had started its ${what}.\n` +
      `          waiting for: ${saying}\n` +
      `          the log said: ${last.trim().split('\n').slice(-3).join(' | ') || '(nothing)'}`
  );
}

/** And then one real connection, which by now is expected to work first time. */
async function untilItGreetsUs(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const greeted = await new Promise((done) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setEncoding('utf8');
      socket.setTimeout(2000);

      const finish = (said) => {
        socket.destroy();
        done(said);
      };

      socket.once('data', (chunk) => finish(/^220[ -]/.test(chunk)));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });

    if (greeted) return;
    await new Promise((done) => setTimeout(done, 200));
  }

  throw new Error(`${IMAGE} said it was listening on ${port}, and then did not greet us`);
}

/** The web side: an answer to a real question, not an open port. */
async function untilItAnswersQuestions(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/messages?limit=1`);
      if (response.ok) {
        await response.json();
        return;
      }
    } catch {
      /* not up yet */
    }

    await new Promise((done) => setTimeout(done, 200));
  }

  throw new Error(`${IMAGE} never answered its own API on ${port}`);
}
