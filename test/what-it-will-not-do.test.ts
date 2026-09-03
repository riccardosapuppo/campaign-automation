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

import { WHAT_THERE_IS } from '../src/send/transports.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js file under src/, read once. */
type SourceFile = { file: string; text: string };

function everythingUnderSrc(from: string = path.join(root, 'src')): SourceFile[] {
  return fs.readdirSync(from, { withFileTypes: true }).flatMap((one) => {
    const full = path.join(from, one.name);
    if (one.isDirectory()) return everythingUnderSrc(full);
    // `.ts` now, and `.js` still: the browser console under `public/` stays
    // JavaScript because it does not go through Node, and it is exactly as
    // much a place where a forbidden import could hide.
    return one.name.endsWith('.ts') || one.name.endsWith('.js')
      ? [{ file: path.relative(root, full), text: fs.readFileSync(full, 'utf8') }]
      : [];
  });
}

describe('the ways a message can leave', () => {
  it('are exactly three, and these three', () => {
    assert.deepEqual([...WHAT_THERE_IS].sort(), ['dry-run', 'file', 'smtp']);
  });

  it('and the default one sends nothing', async () => {
    // A default that sends is a default that goes out because somebody pressed
    // the obvious button on a screen they were reading rather than using.
    const { dryRun } = await import('../src/send/transports.ts');
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
  const importsA = (driver: any) =>
    sources.filter((one: any) => new RegExp(`(import|require)\\s*\\(?['"\`][^'"\`]*${driver}`, 'i').test(one.text)).map((one: any) => one.file);

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
    const guilty = sources.filter((one: any) => shapes.test(one.text));

    assert.deepEqual(guilty.map((one: any) => one.file), []);
  });
});

describe('the page fetches nothing from anywhere', () => {
  const web = ['index.html', 'console.css', 'console.js'].map((one) => ({
    file: one,
    text: fs.readFileSync(path.join(root, 'public', one), 'utf8'),
  }));

  it('no stylesheet, script or font comes from another origin', () => {
    // A tool whose claim is that nothing leaves this machine cannot open with a
    // request to a font host telling it that this console exists and that
    // somebody is looking at it.
    const outside = web.filter((one) => /(src|href)\s*=\s*["']https?:|url\(\s*["']?https?:/i.test(one.text));

    assert.deepEqual(outside.map((one) => one.file), []);
  });

  it('and the face it uses is in the repository, with its licence', () => {
    const css = web.find((one) => one.file === 'console.css')!.text;

    assert.match(css, /@font-face/, 'no face is declared at all, so the console falls back to whatever is installed');

    for (const face of [...css.matchAll(/url\('([^']+\.woff2)'\)/g)].map((one) => one[1])) {
      assert.ok(fs.existsSync(path.join(root, 'public', face)), `${face} is declared and not shipped`);
    }

    assert.ok(fs.existsSync(path.join(root, 'public', 'fonts', 'OFL.txt')), 'the font is shipped without its licence');
  });

  it('and the icons are drawn here rather than pulled from a set', () => {
    const html = web.find((one) => one.file === 'index.html')!.text;

    assert.ok((html.match(/class="glyph"/g) ?? []).length >= 3, 'the panels have lost their glyphs');
  });
});

describe('what the service will accept', () => {
  it('is only a transport the module lists', () => {
    // The route checks WHAT_THERE_IS before its own map, so a transport added
    // to the map without being added to the list is unreachable rather than
    // quietly available — the right way round for this particular promise.
    const api = fs.readFileSync(path.join(root, 'src', 'http', 'api.ts'), 'utf8');

    assert.match(api, /WHAT_THERE_IS\.includes\(which\)/);
  });
});
