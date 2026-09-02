#!/usr/bin/env node
/**
 * The pictures in the README, made rather than taken.
 *
 *     npm run screenshots
 *
 * Nothing here photographs the screen. It starts its own service on its own
 * ports with its own throwaway database, opens the console in a browser, and
 * captures **the page** — so whatever else happens to be on the machine at the
 * time cannot end up in a file that is about to be pushed to a repository.
 *
 * That is not a hypothetical. A screenshot of the screen is a screenshot of
 * everything that was on it.
 *
 * The pictures are generated, not kept by hand, so they cannot quietly stop
 * matching the thing they are pictures of: this is re-run whenever the console
 * changes, and the README shows what the console does today.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const docs = path.join(root, 'docs');

const PORT = 3648;
const SINK = 3649;
const SINK_WEB = 3650;

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.error('playwright-core non e installato qui:  npm install --save-dev playwright-core');
  process.exit(2);
}

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-shots-'));
const started = [];

fs.mkdirSync(docs, { recursive: true });

try {
  await start(['sink/smtp.js', String(SINK)], { SINK_WEB_PORT: String(SINK_WEB) }, SINK);
  await start(['src/index.js'], { PORT: String(PORT), DB: path.join(folder, 'shots.db'), SMTP_PORT: String(SINK) }, PORT);

  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1360, height: 1000 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

    // ------------------------------------------------- 1. the list and why
    await page.getByRole('button', { name: 'Use the sample list' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#contacts-body tr').length > 1);

    await shoot(page, 'the-list.png', '#panel-list');

    // ---------------------------------------------------- 2. a reply, read
    await page.getByRole('button', { name: '…non-stop until Friday…' }).click();
    await page.waitForFunction(() => document.getElementById('reply-said').textContent.trim().length > 0);

    await shoot(page, 'a-reply.png', '#panel-reply');

    // ------------------------------------------ 3. a campaign, worked out
    await page.getByRole('button', { name: 'Make the campaign' }).click();
    await page.waitForSelector('#steps:not([hidden])');

    await page.getByRole('button', { name: 'Work out who may be written to' }).click();
    await page.waitForFunction(() => !document.getElementById('do-send').disabled);

    await page.selectOption('#transport', 'smtp');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForFunction(() => /sent/.test(document.getElementById('send-said').textContent));

    await shoot(page, 'a-campaign.png', '#panel-campaign');

    // ------------------------------------------------------- 4. one person
    await page.locator('#contacts-body tr', { hasText: 'carla.vidal@example.invalid' }).getByText('history').click();
    await page.waitForSelector('#history[open]');

    await shoot(page, 'one-person.png', '#history');
    await page.locator('#history .close').click();

    // ----------------------------------------------- 5. the whole console
    await page.setViewportSize({ width: 1360, height: 1500 });
    await page.waitForTimeout(250);
    await shoot(page, 'the-console.png');

    // ------------------------------------------------- 6. what the sink got
    const sink = await browser.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2 });
    await sink.goto(`http://127.0.0.1:${SINK_WEB}/`, { waitUntil: 'networkidle' });
    await shoot(sink, 'the-sink.png');
    await sink.close();

    // -------------------------------------------------------- 7. the mark
    const mark = await browser.newPage({ viewport: { width: 320, height: 96 }, deviceScaleFactor: 4 });
    await mark.setContent(
      `<style>html,body{margin:0;background:#eef1f5;display:flex;gap:18px;align-items:center;
         justify-content:center;height:96px}
         img{display:block;border-radius:5px}</style>` +
        [16, 32, 64].map((size) => `<img src="${url()}" width="${size}" height="${size}">`).join('')
    );
    await mark.waitForFunction(() => [...document.images].every((one) => one.complete));
    await shoot(mark, 'the-mark.png');
    await mark.close();
  } finally {
    await browser.close();
  }
} finally {
  await Promise.all(started.map(gone));
  fs.rmSync(folder, { recursive: true, force: true });
}

console.log(`\n  in ${path.relative(process.cwd(), docs)}`);

// ---------------------------------------------------------------------------

function url() {
  const svg = fs.readFileSync(path.join(root, 'public', 'mark.svg'), 'utf8');
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

async function shoot(page, name, selector) {
  const to = path.join(docs, name);

  if (selector) await page.locator(selector).screenshot({ path: to });
  else await page.screenshot({ path: to, fullPage: true });

  console.log(`  ${name}`);
}

async function start(argv, env, port) {
  const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await answering(port)) return child;
    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error(`nothing came up on ${port}`);
}

function gone(child) {
  if (child.exitCode !== null) return null;

  return new Promise((done) => {
    child.once('exit', done);
    child.kill();
    setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 3000).unref();
  });
}

function answering(port) {
  return new Promise((done) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}
