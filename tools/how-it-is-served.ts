#!/usr/bin/env node
/**
 * How the console is served, checked against the running service.
 *
 *     npm run check:serving
 *
 * This exists because a caching header is the kind of thing that is right in
 * the source and wrong in the response. `express.static(dir, { etag: false })`
 * reads as "no revalidation" and is not: `lastModified` is a separate option
 * that defaults to true, so every file still went out with a `Last-Modified`,
 * every reload was a conditional request, and a browser is entitled to answer
 * one from its own cache with a 304 — which is how somebody presses reload
 * after a rebuild and gets the page from before it.
 *
 * The advice that follows is always "press Ctrl+F5", and it sends people
 * looking at the server while the page is being served by their own browser and
 * sometimes by a service worker nobody remembers installing.
 *
 * So this asserts, against a service that is really running:
 *
 *   - the page is `no-store`, with no `ETag` and no `Last-Modified`
 *   - so is everything it loads, because nothing here is fingerprinted and
 *     immutable without a fingerprint means a change that never arrives
 *   - a request that NAMES A FILE and has not got one is a 404, never the
 *     application dressed as a file
 *   - the page unregisters any service worker left on this origin
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesTheReadme } from './what-the-readme-claims.ts';

const PORT = 3668;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-serving-'));

let child = null;
let checks = 0;
let bad = 0;

try {
  child = await start();

  console.log(`  asking http://127.0.0.1:${PORT} how it serves things\n`);

  // -------------------------------------------------------------- the page
  const page = await fetch(`http://127.0.0.1:${PORT}/`);

  is('the page comes back', page.status, 200);
  has('and it is the console', await page.clone().text(), '<title>Campaigns');
  has('it is never stored', page.headers.get('cache-control') ?? '', 'no-store');
  is('it has no ETag to revalidate against', page.headers.get('etag'), null);
  is('and no Last-Modified either', page.headers.get('last-modified'), null);

  // ------------------------------------------------------- what it loads
  for (const file of ['/console.js', '/console.css', '/mark.svg']) {
    const asset = await fetch(`http://127.0.0.1:${PORT}${file}`);

    is(`${file} comes back`, asset.status, 200);
    has(`${file} is never stored either`, asset.headers.get('cache-control') ?? '', 'no-store');
    is(`${file} has no Last-Modified`, asset.headers.get('last-modified'), null);
  }

  // ------------------------------------------------- a file that is not there
  //
  // The failure this guards against is a single-page fallback: a request for
  // `/ngsw.json` answered with 200 and a page of HTML, which a service worker
  // then treats as its manifest. It is how a screen goes on being served after
  // the thing that served it has gone.
  for (const missing of ['/ngsw.json', '/console.old.js', '/samples/nothing.csv']) {
    const said = await fetch(`http://127.0.0.1:${PORT}${missing}`);
    const body = await said.text();

    is(`${missing} is a 404`, said.status, 404);
    is(`and ${missing} is not the application in disguise`, /<title>Campaigns/.test(body), false);
  }

  // ------------------------------------------------------ the page's own job
  const console_js = await (await fetch(`http://127.0.0.1:${PORT}/console.js`)).text();

  has('the page unregisters service workers left on this origin', console_js, 'getRegistrations()');
  has('and clears their caches', console_js, 'caches.delete');
} finally {
  if (child) await gone(child);
  fs.rmSync(folder, { recursive: true, force: true });
}

console.log('');
if (!matchesTheReadme('npm run check:serving', checks)) bad += 1;

console.log(`\n${bad === 0 ? `All ${checks} checks passed.` : `${bad} of ${checks} checks failed.`}`);
process.exitCode = bad === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

function is(what: string, got: unknown, wanted?: unknown): void {
  checks += 1;

  if (got === wanted) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

function has(what: string, got: unknown, wanted?: unknown): void {
  checks += 1;

  if (String(got ?? '').includes(String(wanted))) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted something containing ${JSON.stringify(wanted)}`);
}

async function start() {
  const one = spawn(process.execPath, ['src/index.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DB: path.join(folder, 'serving.db') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  one.stderr.on('data', (chunk) => process.stderr.write(chunk));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const up = await new Promise<boolean>((done) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });

    if (up) return one;
    await new Promise<void>((done) => setTimeout(done, 50));
  }

  throw new Error(`the service never came up on ${PORT}`);
}

function gone(one: any) {
  if (one.exitCode !== null) return null;

  return new Promise<void>((done) => {
    const impatient = setTimeout(() => {
      one.kill('SIGKILL');
      done();
    }, 3000);

    one.once('exit', () => {
      clearTimeout(impatient);
      done();
    });

    one.kill();
  });
}
