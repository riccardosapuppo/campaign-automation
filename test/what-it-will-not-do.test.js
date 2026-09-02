/**
 * The half that was deliberately left out, pinned so it cannot come back.
 *
 * The README devotes a section to explaining that the transport this project
 * was rebuilt from — driving somebody's web messaging client with a browser —
 * is not here, and why. That section is prose. Prose does not fail.
 *
 * On the day somebody adds a fourth transport, or imports a browser driver into
 * `src/` because it is already a devDependency and imports cleanly, nothing in
 * the repository would have objected. These tests object, and a step in
 * continuous integration greps for the same thing from the outside.
 *
 * This is the difference between a decision and an intention.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WHAT_THERE_IS } from '../src/send/transports.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js file under src/, read once. */
function everythingUnderSrc(from = path.join(root, 'src')) {
  return fs.readdirSync(from, { withFileTypes: true }).flatMap((one) => {
    const full = path.join(from, one.name);
    if (one.isDirectory()) return everythingUnderSrc(full);
    return one.name.endsWith('.js') ? [{ file: path.relative(root, full), text: fs.readFileSync(full, 'utf8') }] : [];
  });
}

describe('the ways a message can leave', () => {
  it('are exactly three, and these three', () => {
    assert.deepEqual([...WHAT_THERE_IS].sort(), ['dry-run', 'file', 'smtp']);
  });

  it('and the default one sends nothing', async () => {
    // A default that sends is a default that goes out because somebody pressed
    // the obvious button on a screen they were reading rather than using.
    const { dryRun } = await import('../src/send/transports.js');
    const said = await dryRun().send({ to: 'a@example.invalid', from: { address: 'b@example.invalid' }, subject: '', body: '' });

    assert.match(said.why, /nothing was sent/);
  });
});

describe('nothing in src/ drives a browser', () => {
  const sources = everythingUnderSrc();

  it('and there is something to look at, so this cannot pass by finding nothing', () => {
    assert.ok(sources.length >= 8, `only found ${sources.length} source files`);
  });

  // Written out one by one rather than generated in a loop. A loop would make
  // six tests out of one `it(`, and the README check counts `it(` — so the
  // number in the README would drift from the number that runs, which is the
  // exact rot both of these files exist to stop.
  const importsA = (driver) =>
    sources.filter((one) => new RegExp(`(import|require)\\s*\\(?['"\`][^'"\`]*${driver}`, 'i').test(one.text)).map((one) => one.file);

  it('does not reach for puppeteer', () => assert.deepEqual(importsA('puppeteer'), []));
  it('does not reach for playwright', () => assert.deepEqual(importsA('playwright'), []));
  it('does not reach for selenium', () => assert.deepEqual(importsA('selenium'), []));
  it('does not reach for webdriver', () => assert.deepEqual(importsA('webdriver'), []));
  it('does not reach for a raw devtools protocol', () => assert.deepEqual(importsA('chrome-remote-interface'), []));
  it('does not reach for electron', () => assert.deepEqual(importsA('electron'), []));

  it('and nothing there opens a page or types into one', () => {
    // The shapes a browser-driving transport takes even when the import is
    // hidden: launching a browser, waiting for a selector, clicking a thing.
    const shapes = /\b(chromium|firefox|webkit)\.launch\b|\bnewPage\s*\(|\bwaitForSelector\s*\(|\bpage\.(click|type|goto)\s*\(/;
    const guilty = sources.filter((one) => shapes.test(one.text));

    assert.deepEqual(guilty.map((one) => one.file), []);
  });
});

describe('what the service will accept', () => {
  it('is only a transport the module lists', () => {
    // The route checks WHAT_THERE_IS before its own map, so a transport added
    // to the map without being added to the list is unreachable rather than
    // quietly available — the right way round for this particular promise.
    const api = fs.readFileSync(path.join(root, 'src', 'http', 'api.js'), 'utf8');

    assert.match(api, /WHAT_THERE_IS\.includes\(which\)/);
  });
});
