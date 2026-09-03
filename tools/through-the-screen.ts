#!/usr/bin/env node
/**
 * The console, driven with a browser.
 *
 *     npm run check:screen
 *     npm run check:screen -- --show      (watch it happen)
 *
 * The third layer, and it exists because the other two cannot see the screen.
 * The unit tests prove `mayReceive` is right. The walkthrough proves the
 * service calls it. Neither of them can tell you that the reason a person was
 * held back is **on the page**, which is the entire claim this project makes:
 * not that it refuses, but that anybody can see why.
 *
 * So the assertions here are about what is drawn, counted rather than sampled,
 * and one of them is about the order of the rows — because a refusal that is
 * four hundred rows down the page is a refusal nobody reads.
 *
 * It uses the browser already on this machine (`channel: 'msedge'`), so
 * nothing is downloaded and nothing leaves it. It starts the service and the
 * sink itself, on their own ports and their own throwaway database, and takes
 * them down again.
 */

import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { matchesTheReadme } from './what-the-readme-claims.ts';

const PORT = 3638;
const SINK = 3639;
const SINK_WEB = 3640;
const show = process.argv.includes('--show');

let chromium: typeof import('playwright-core').chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.error('playwright-core is not installed here, so this check cannot run.');
  console.error('It is a check, not a dependency of the program:  npm install --save-dev playwright-core');
  process.exit(2);
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-screen-'));
const started: ChildProcess[] = [];

let checks = 0;
let bad = 0;

try {
  await run();
} finally {
  await Promise.all(started.map(gone));
  fs.rmSync(folder, { recursive: true, force: true });
}

// The README's own claim about this command, checked by this command.
console.log('');
if (!matchesTheReadme('npm run check:screen', checks)) bad += 1;

console.log(`\n${bad === 0 ? `All ${checks} checks passed.` : `${bad} of ${checks} checks failed.`}`);
process.exitCode = bad === 0 ? 0 : 1;

async function run() {
  await start(['sink/smtp.js', String(SINK)], { SINK_WEB_PORT: String(SINK_WEB) }, SINK);
  await start(['src/index.ts'], { PORT: String(PORT), DB: path.join(folder, 'screen.db'), SMTP_PORT: String(SINK) }, PORT);

  const browser = await chromium.launch({ channel: 'msedge', headless: !show });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, reducedMotion: 'reduce' });

  // Anything the page throws is a failure of this check, even if every
  // assertion below still passes — a screen that works while quietly throwing
  // is a screen that stops working on the next browser.
  const thrown: string[] = [];
  page.on('pageerror', (error: Error) => thrown.push(`threw: ${(error instanceof Error ? error.message : String(error))}`));
  page.on('console', (message: { type(): string; text(): string }) => {
    if (message.type() === 'error') thrown.push(message.text());
  });

  try {
    console.log(`  driving http://127.0.0.1:${PORT} through the screen\n`);

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

    // ------------------------------------------------------------ 1. empty
    say('before anything is imported');
    is('it says there is nobody', await page.locator('#contacts-body .empty').isVisible(), true);

    // ----------------------------------------------------------- 2. import
    say('the sample list is imported from the screen');
    await page.getByRole('button', { name: 'Use the sample list' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#contacts-body tr').length > 1);

    const api = await (await fetch(`http://127.0.0.1:${PORT}/api/contacts`)).json();
    const onScreen = await page.locator('#contacts-body tr').count();

    // Counted, not sampled. A page that draws the first three rows and stops
    // looks exactly like a page that works.
    is('every contact the service knows about is on the screen', onScreen, api.allowed.length + api.refused.length);
    is('and the tally agrees with the service', await text(page, '#tally-allowed'), String(api.allowed.length));
    is('including the held-back count', await text(page, '#tally-refused'), String(api.refused.length));

    // ------------------------------------------------------ 3. the reasons
    say('and every one of them says why');
    const reasons = await page.locator('#contacts-body td.because').allTextContents();

    is('no row is left without a reason', reasons.filter((one) => one.trim() === '').length, 0);

    const first = await page.locator('#contacts-body tr').first();
    is('the held back come first, where they are read', await first.locator('.answer.no').count(), 1);

    has('and the reason is the one the service gave', reasons.join(' | '), 'suppression list');

    // Which columns it recognised, said on the page rather than only in a log.
    has('it shows what it made of the columns', await text(page, '#columns-list'), 'the header says "Consent given on"');

    // ------------------------------------------------------- 4. the replies
    say('a reply that only looks like a stop');
    const before = await text(page, '#tally-allowed');

    await page.getByRole('button', { name: '…non-stop until Friday…' }).click();
    await page.waitForFunction(() => (document.getElementById('reply-said') as HTMLElement & Record<string, any>).textContent.trim().length > 0);

    has('the screen says it is not an unsubscribe', await text(page, '#reply-said'), 'Not an unsubscribe');
    is('and nobody was removed', await text(page, '#tally-allowed'), before);

    say('and a reply that is one');
    await page.getByRole('button', { name: 'take me off this list' }).click();
    await page.waitForFunction((was) => (document.getElementById('tally-allowed') as HTMLElement & Record<string, any>).textContent !== was, before);

    has('the screen says it is an unsubscribe', await text(page, '#reply-said'), 'Read as an unsubscribe');
    is('and one fewer may be written to', Number(await text(page, '#tally-allowed')), Number(before) - 1);

    // ------------------------------------------------------ 5. the campaign
    say('step one says who it would go to, without a box to paste addresses into');

    const may = (await (await fetch(`http://127.0.0.1:${PORT}/api/contacts`)).json()).allowed.length;

    is('the count on the screen is the list, not a second copy of it', Number(await text(page, '#who-many')), may);
    is('and there is nowhere to type an address into a campaign', await page.locator('#step-who textarea, #step-who input').count(), 0);

    say('a campaign is written on the screen');
    await page.getByRole('button', { name: 'Make the campaign' }).click();
    await page.waitForSelector('#steps:not([hidden])');

    is('the send button cannot be pressed yet', await page.locator('#do-send').isDisabled(), true);
    has('and it says who the template does not fit', await text(page, '#held-back-list'), '{{company}}');

    say('working out who may be written to sends nothing');
    await page.getByRole('button', { name: 'Work out who may be written to' }).click();
    await page.waitForFunction(() => !(document.getElementById('do-send') as HTMLElement & Record<string, any>).disabled);

    has('the screen says how many would go', await text(page, '#decide-said'), 'may be written to');
    has('and that nothing did', await text(page, '#decide-said'), 'nothing was sent');

    const drawn = await page.locator('#messages-body tr').count();
    const said = await (await fetch(`http://127.0.0.1:${PORT}/api/campaigns/1`)).json();
    is('every decision is drawn, refusals included', drawn, said.messages.length);

    // ------------------------------------------- 6. it can be stopped halfway
    //
    // The power this project claims most loudly after the permission check: a
    // campaign runs for a quarter of an hour and somebody has to be able to
    // change their mind. A stop that only exists in the API is a stop nobody
    // can reach, so it is pressed here, on the screen, mid-run.
    say('and while it goes out it can be stopped, from the screen');

    await page.selectOption('#transport', 'dry-run');
    await page.selectOption('#rate', '30'); // one every two seconds, so there is a middle to stop in
    await page.getByRole('button', { name: 'Send' }).click();

    await page.waitForSelector('#sending[open]');
    is('a progress window comes up', await page.locator('#sending').isVisible(), true);

    // Wait until at least one has actually gone, so this stops something that
    // is running rather than something that has not begun.
    await page.waitForFunction(() => Number((document.getElementById('sent-so-far') as HTMLElement & Record<string, any>).textContent) >= 1);

    const wanted = Number(await text(page, '#to-send'));
    is('and it says how many are going', wanted > 1, true);

    await page.getByRole('button', { name: 'Stop sending' }).click();
    await page.waitForFunction(() => !(document.getElementById('sending') as HTMLElement & Record<string, any>).open, null, { timeout: 20_000 });

    has('the screen says it was stopped', await text(page, '#send-said'), 'stopped on request');

    const afterStop = await (await fetch(`http://127.0.0.1:${PORT}/api/campaigns/1`)).json();
    const went = afterStop.messages.filter((one: any) => one.state === 'sent').length;

    is('fewer went than were queued', went < wanted, true);
    is('and the rest are still waiting, not lost', afterStop.messages.some((one: any) => one.state === 'allowed'), true);

    // ---------------------------------------------------------- 7. sending
    say('and then the rest is sent, over SMTP, to a server that is really listening');
    await page.selectOption('#transport', 'smtp');
    await page.selectOption('#rate', '600');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForFunction(() => /sent/.test((document.getElementById('send-said') as HTMLElement & Record<string, any>).textContent), null, { timeout: 20_000 });

    has('the screen says what happened', await text(page, '#send-said'), 'sent');

    const caught = await (await fetch(`http://127.0.0.1:${SINK_WEB}/messages`)).json();
    is('and a message really did arrive', caught.received.length > 0, true);
    is('with nothing left unfilled in it', /\{\{/.test(caught.received.map((one: any) => one.body).join('')), false);

    // ------------------------------------------------------ 7. one person
    say('anybody on the list can be opened up');
    await page.locator('#contacts-body tr', { hasText: 'anna.rossi@example.invalid' }).getByText('history').click();
    await page.waitForSelector('#history[open]');

    has('their consent is shown', await text(page, '#history-body'), 'the sign-up form on the site');
    is('and it is a dialog somebody can close', await page.locator('#history .close').isVisible(), true);

    // ------------------------------------------------------- 8. the screen
    say('and the page itself');
    is('nothing was thrown while all that happened', thrown.join(' | '), '');

    // A tool console that cannot be used on a laptop screen is a tool console
    // somebody uses in a spreadsheet instead.
    await page.setViewportSize({ width: 760, height: 1000 });
    await page.waitForTimeout(200);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    is('it does not scroll sideways at 760 wide', overflow <= 0, true);
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------- small

/**
 * Declared with `function`, not `const`.
 *
 * `run()` is called at the top of the file and everything below it is a
 * helper; a `const` arrow down here is not hoisted, so the first call reaches
 * it before it exists and the whole check dies on line one of the assertions.
 */
function text(page: any, selector: any) {
  return page.locator(selector).innerText();
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

async function start(argv: string[], env: NodeJS.ProcessEnv, port: number) {
  const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await answering(port)) return child;
    await new Promise<void>((done) => setTimeout(done, 50));
  }

  throw new Error(`nothing came up on ${port}`);
}

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
