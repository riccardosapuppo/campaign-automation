#!/usr/bin/env node
/**
 * One command: the sink, and the service that sends to it.
 *
 *     npm start
 *     npm start -- --sample
 *
 * A campaign tool with nowhere to send to is a campaign tool that cannot be
 * tried, and a README whose first instruction is "open a second terminal" is a
 * README that gets skimmed. Whoever is looking has a few minutes; a manoeuvre
 * does not get performed.
 *
 * Both halves stay, after this one, and the second is not only for debugging:
 *
 *     npm run sink        just the SMTP server that delivers nowhere
 *     npm run service     just the service, for pointing at a real SMTP host
 *
 * That second case is the actual use. Somebody with a real relay should not
 * have to start a fake one first.
 *
 * ── What starting two processes obliges you to do ────────────────────────────
 *
 *  1. **The sink first, and waited for.** The service does not need it to
 *     start — nothing is sent until somebody presses send — but a console that
 *     offers "send over SMTP" while the sink is still binding refuses the first
 *     attempt for a reason that has nothing to do with the code.
 *  2. **If one dies, the other stops.** A sink nobody sends to is a port held
 *     for nothing that the next start fights over.
 *  3. **Every line says which process said it.** Both write one JSON object per
 *     line, so the label goes on the line and not on the chunk — a chunk
 *     boundary lands wherever the pipe put it, routinely mid-object, and a
 *     label inside a record makes the whole log unparseable.
 */

import type { ChildProcess } from 'node:child_process';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const running: Array<{ name: string; child: ChildProcess }> = [];
let closing = false;

const sink = start('the sink', path.join(root, 'sink', 'smtp.js'), []);

// Wait for it to say so, rather than for a guessed number of milliseconds on a
// machine that may be slower than this one.
await untilItSays(sink, /"message":"listening"/, 15_000);

start('the service', path.join(root, 'src', 'index.js'), process.argv.slice(2));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => closeEverything(0));
}

// ---------------------------------------------------------------------------

function start(name: string, script: any, argv: string[]) {
  const child = spawn(process.execPath, [script, ...argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  label(child.stdout, name);
  label(child.stderr, name);

  child.on('error', (error) => {
    console.error(`[${name}] would not start: ${(error instanceof Error ? error.message : String(error))}`);
    closeEverything(1);
  });

  child.on('exit', (code) => {
    if (closing) return;
    console.error(`[${name}] stopped${code ? ` with code ${code}` : ''}, so this is stopping too.`);
    closeEverything(code ?? 0);
  });

  running.push({ name, child });
  return child;
}

function label(stream: any, name: string) {
  if (!stream) return;

  let rest = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk: any) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
  });

  stream.on('end', () => {
    if (rest) process.stdout.write(`[${name}] ${rest}\n`);
  });
}

function untilItSays(child: ChildProcess, pattern: RegExp, ms: number) {
  return new Promise<void>((done) => {
    let seen = '';

    const giveUp = setTimeout(() => {
      console.error(`[both] the sink did not say it was listening within ${ms / 1000}s; starting anyway`);
      finish();
    }, ms);

    const look = (chunk: any) => {
      seen += chunk;
      if (pattern.test(seen)) finish();
    };

    function finish() {
      clearTimeout(giveUp);
      child.stdout?.off('data', look);
      done();
    }

    child.stdout?.on('data', look);
  });
}

function closeEverything(code: number) {
  if (closing) return;
  closing = true;

  for (const one of running) {
    if (one.child.exitCode === null && one.child.signalCode === null) one.child.kill();
  }

  setTimeout(() => process.exit(code), 300);
}
