#!/usr/bin/env node
/**
 * There is nothing to compile, so "build" starts it.
 *
 *     npm run build
 *
 * A `build` script that prints "nothing to build" is a script that has never
 * told anybody anything. The useful question at this point in a project is not
 * whether the source compiles — it is JavaScript, it always does — but whether
 * the thing a reader is about to type actually comes up.
 *
 * So this runs the two commands the README opens with, in the order the README
 * gives them, against a throwaway database, and asks each one for a sign of
 * life over its own port. Then it stops them and deletes the database.
 *
 * It has caught, in this project, exactly the sort of thing it is for: a
 * `require()` left in a module that is loaded as ESM, which nothing else
 * touched until somebody chose the folder transport.
 */

import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PORT = 3658;
const SINK = 3659;
const SINK_WEB = 3660;

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'campaigns-build-'));
const started: ChildProcess[] = [];

let bad = 0;

try {
  await start('npm run sink', ['sink/smtp.js', String(SINK)], { SINK_WEB_PORT: String(SINK_WEB) }, SINK);
  await start('npm start', ['src/index.ts'], { PORT: String(PORT), DB: path.join(folder, 'build.db'), SMTP_PORT: String(SINK) }, PORT);

  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());
  is('the service answers about itself', health.ok, true);

  const page = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  is('the console is served', /<title>Campaigns/.test(page), true);
  is('and so is the script it needs', (await fetch(`http://127.0.0.1:${PORT}/console.js`)).status, 200);
  is('and the mark', (await fetch(`http://127.0.0.1:${PORT}/mark.svg`)).status, 200);

  // The button on the screen that says "use the sample list" reads this over
  // HTTP. If it is not served, the button silently does nothing.
  is('and the sample list the console offers', (await fetch(`http://127.0.0.1:${PORT}/samples/contacts.csv`)).status, 200);

  const caught = await fetch(`http://127.0.0.1:${SINK_WEB}/messages`).then((r) => r.json());
  is('the sink answers too', Array.isArray(caught.received), true);
} finally {
  await Promise.all(started.map(gone));
  fs.rmSync(folder, { recursive: true, force: true });
}

console.log(bad === 0 ? '\nAll of it starts.\n' : '\nSomething does not start.\n');
process.exitCode = bad === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

function is(what: string, got: unknown, wanted?: unknown): void {
  if (got === wanted) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}

async function start(what: string, argv: string[], env: NodeJS.ProcessEnv, port: number) {
  const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);

  // Kept, not printed: a process that fails to start says why, and that is the
  // only thing worth showing out of all its output.
  const complaints: string[] = [];
  child.stderr.on('data', (chunk) => complaints.push(String(chunk)));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await answering(port)) {
      console.log(`  ok    \`${what}\` comes up on ${port}`);
      return child;
    }
    if (child.exitCode !== null) break;
    await new Promise<void>((done) => setTimeout(done, 50));
  }

  bad += 1;
  console.log(`  NO    \`${what}\` never came up on ${port}`);
  if (complaints.length > 0) console.log(complaints.join('').replace(/^/gm, '          '));

  throw new Error(`${what} did not start`);
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
