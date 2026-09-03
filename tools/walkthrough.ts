#!/usr/bin/env node
/**
 * The whole story, through HTTP, against a service that is really running.
 *
 *     npm run walkthrough
 *
 * It starts the sink and the service itself, on their own ports and their own
 * throwaway database, tells the story once, and takes everything down again —
 * including on the way out of a failure. A check that leaves a process holding
 * a port is a check somebody has to clean up after.
 *
 * This is the layer the unit tests cannot reach. `mayReceive` being right is
 * one thing; a service that never calls it, calls it with a contact that has
 * lost its basis on the way through JSON, or has a route that goes around it,
 * is a different thing entirely, and only a real request finds that out.
 */

import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { matchesTheReadme } from './what-the-readme-claims.ts';

const PORT = 3618;
const SINK = 3619;
const SINK_WEB = 3620;

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-walkthrough-'));
const started: ChildProcess[] = [];

let checks = 0;
let bad = 0;

// ---------------------------------------------------------------- the story

try {
  await run();
} finally {
  // Waited for, not just asked. `kill()` returns immediately and the child
  // still has the database file open for a moment afterwards, so deleting the
  // folder on the next line fails with a permission error on Windows — which
  // reads like a bug in the check rather than what it is.
  await Promise.all(started.map((child) => (child.exitCode === null ? gone(child) : null)));
  fs.rmSync(folder, { recursive: true, force: true });
}

// The README's own claim about this command, checked by this command.
console.log('');
if (!matchesTheReadme('npm run walkthrough', checks)) bad += 1;

console.log(`\n${bad === 0 ? `All ${checks} checks passed.` : `${bad} of ${checks} checks failed.`}`);
process.exitCode = bad === 0 ? 0 : 1;

async function run() {
  await start('sink', ['sink/smtp.js', String(SINK)], { SINK_WEB_PORT: String(SINK_WEB) }, SINK);
  await start('service', ['src/index.ts'], { PORT: String(PORT), DB: path.join(folder, 'walkthrough.db'), SMTP_PORT: String(SINK) }, PORT);

  // -------------------------------------------------------------- 1. empty
  say('it starts with nobody on the list');
  const health = await ask('GET', '/api/health');
  is('it answers', health.ok, true);
  is('and there is nobody on it', health.contacts, 0);

  // ------------------------------------------------------------- 2. import
  say('a spreadsheet is imported');
  const imported = await ask('POST', '/api/import', fs.readFileSync('samples/contacts.csv', 'utf8'), 'text/csv');

  is('ten people came in', imported.imported, 10);
  is('it found the address column', column(imported, 'address')?.title, 'Email');
  is('it found the consent column', column(imported, 'consentAt')?.title, 'Consent given on');
  is('it found where each consent came from', column(imported, 'consentSource')?.title, 'Where from');
  is('a column it cannot name is left alone', column(imported, 'other')?.title, 'Company');

  // -------------------------------------------------------- 3. the verdict
  say('and the list can say, for every one of them, whether they may be written to');
  const list = await ask('GET', '/api/contacts');

  /**
   * Before the counts: is the fixture still saying what it was written to say?
   *
   * The sample list has consents dated in 2026 and the rules treat one as stale
   * after 730 days, so on a morning in early 2028 those consents go stale on
   * their own and every count below moves by one. Nothing would be broken — the
   * program would be exactly right — but this file would start failing, and the
   * failure would point at the service instead of at the calendar.
   *
   * So it is said here, first, in words that tell whoever hits it what to do.
   */
  const freshest = Date.parse('2026-08-12T00:00:00.000Z'); // the newest consent in samples/contacts.csv
  const daysSince = Math.floor((Date.now() - freshest) / 86_400_000);

  is(
    `the sample list has not aged out (its newest consent is ${daysSince} days old, and 730 is the limit)`,
    daysSince < 730,
    true
  );

  if (daysSince >= 730) {
    console.log('        samples/contacts.csv needs newer dates: every consent in it has gone stale with age,');
    console.log('        so the counts below are about a fixture that has expired, not about a defect.');
  }

  is('six may be', list.allowed.length, 6);
  is('four may not', list.refused.length, 4);

  has('somebody with nothing recorded is refused', refusal(list, 'dan.petrov@example.invalid'), 'nothing was recorded');
  // Not the number of days: that is different every morning, and a check with
  // today's arithmetic written into it passes today and fails tomorrow for a
  // reason nobody will connect to this line.
  has(
    'a consent from 2020 is too old to rely on',
    refusal(list, 'carla.vidal@example.invalid'),
    'longer than this campaign treats as current'
  );
  has('somebody who unsubscribed stays refused', refusal(list, 'eve.lindqvist@example.invalid'), 'suppression list');

  // -------------------------------------------------------- 4. the replies
  say('somebody replies to say stop, and somebody else says something that only looks like it');

  const stop = await ask('POST', '/api/reply', { address: 'anna.rossi@example.invalid', text: 'STOP' });
  is('"STOP" is an unsubscribe', stop.suppressed, true);

  const notStop = await ask('POST', '/api/reply', {
    address: 'ben.okoro@example.invalid',
    text: 'We are non-stop until Friday, can you deliver then?',
  });
  is('"non-stop until Friday" is not', notStop.suppressed, false);

  const after = await ask('GET', '/api/contacts');
  is('so one fewer may be written to', after.allowed.length, 5);
  is('and ben is still one of them', after.allowed.some((one: any) => one.address.startsWith('ben.')), true);

  // ------------------------------------------------------- 5. the campaign
  say('a campaign is written');
  const made = await ask('POST', '/api/campaigns', {
    name: 'March offer',
    subject: '{{name | there}}, your March prices',
    body: 'Hello {{name | there}}, your account at {{company}} is unchanged.\n\nReply STOP and we will not write again.',
    fromName: 'Harbour Supplies',
    fromAddress: 'hello@example.invalid',
  });

  is('it was made', made.campaign.id > 0, true);
  is('it says which fields it needs', made.fields.includes('company'), true);
  is('and who has not got one', made.missing.find((one: any) => one.field === 'company')?.howMany, 2);

  const id = made.campaign.id;

  // --------------------------------------------------------- 6. work it out
  say('who may be written to is worked out, and nothing is sent');
  const decided = await ask('POST', '/api/campaigns/' + id + '/decide');

  is('four would go', decided.allowed, 4);
  is('six would not', decided.refused, 6);
  is('and nothing did', decided.sent, 0);
  is('one of them because the template had a hole in it', decided.refusals['a-field-is-missing'], 1);

  // ------------------------------------ 7. somebody changes their mind late
  say('somebody unsubscribes after that and before the sending');
  await ask('POST', '/api/reply', { address: 'ben.okoro@example.invalid', text: 'unsubscribe me please' });

  const sent = await ask('POST', '/api/campaigns/' + id + '/send', { transport: 'smtp', perMinute: 0 });

  is('one went', sent.sent, 1);
  is('one was dropped between working it out and sending', sent.dropped, 1);
  is('and two the server would not take, each for its own reason', sent.failed, 2);

  const failed = (await ask('GET', '/api/campaigns/' + id)).messages.find((one: any) => one.state === 'failed');
  has('in the server’s own words', failed?.why, '550');

  // -------------------------------------------------------- 8. it arrived
  say('and the message really did arrive at a server');
  const caught = await fetch(`http://127.0.0.1:${SINK_WEB}/messages`).then((r) => r.json());

  is('the sink has it', caught.received.length, 1);
  has('addressed to the right person', caught.received[0].to.join(','), 'ilse.vogt@example.invalid');
  has('with the fields filled in', caught.received[0].body, 'Northgate Supplies');

  // The one refused for a missing field is the reason this check exists: if it
  // had gone anyway, this is where "{{company}}" would be sitting in a message
  // that a person received.
  is('and no placeholder left in it', /\{\{/.test(caught.received[0].body), false);

  // ------------------------------------------------------ 9. no second run
  say('and it will not go twice');
  const again = await ask('POST', '/api/campaigns/' + id + '/send', { transport: 'smtp' });
  has('the second press is refused', again.error, 'nothing is waiting');

  // ------------------------------------------------------- 10. one person
  say('anybody can be asked about, one at a time');
  const anna = await ask('GET', '/api/contacts/anna.rossi%40example.invalid');

  is('her consent is still on record', anna.bases.length, 1);
  has('and so is the reply that stopped it', anna.suppression.why, 'STOP');
  is('and she is refused', anna.said.ok, false);
}

// ------------------------------------------------------------------- small

function column(imported: any, field: any) {
  return imported.columns.find((one: any) => one.field === field);
}

function refusal(list: any, address: string) {
  return list.refused.find((one: any) => one.address === address)?.said?.why ?? '(not refused at all)';
}

async function ask(
  method: string,
  url: string,
  body?: unknown,
  type = 'application/json'
): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': type },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

  return response.json();
}

function say(what: string) {
  console.log(`\n  ${what}`);
}

function is(what: string, got: unknown, wanted?: unknown): void {
  checks += 1;

  if (got === wanted) {
    console.log(`    ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`    NO    ${what}\n            wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

function has(what: string, got: unknown, wanted?: unknown): void {
  checks += 1;

  if (String(got ?? '').includes(String(wanted))) {
    console.log(`    ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`    NO    ${what}\n            wanted something containing ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

/** Starts one of ours and waits until its port is actually answering. */
async function start(name: string, argv: string[], env: NodeJS.ProcessEnv, port: number) {
  const child = spawn(process.execPath, argv, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  started.push(child);

  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await answering(port)) return child;
    await new Promise<void>((done) => setTimeout(done, 50));
  }

  throw new Error(`${name} never came up on ${port}`);
}

/** Kills one of ours and waits until the operating system agrees it is gone. */
/**
 * Kills one of ours and waits until the operating system agrees it is gone.
 *
 * The impatient timer is cleared when the child does exit. Left pending, it is
 * a handle still closing while the process is on its way out, which on Windows
 * is a libuv assertion rather than a tidy exit — and it prints after the last
 * line of output, so it reads like the check itself failed.
 */
function gone(child: ChildProcess) {
  if (child.exitCode !== null) return null;

  return new Promise<void>((done) => {
    const impatient = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 3000);

    child.once('exit', () => {
      clearTimeout(impatient);
      done();
    });

    child.kill();
  });
}

function answering(port: number) {
  return new Promise<boolean>((done) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}
