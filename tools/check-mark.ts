#!/usr/bin/env node
/**
 * The mark, checked at the size it is actually seen.
 *
 *     npm run check:mark
 *
 * There is one drawing — `public/mark.svg` — and both the browser tab and the
 * header point at that one file, so there is no second copy to drift. What can
 * still go wrong is subtler and is the thing that actually goes wrong: a mark
 * that looks considered at 200 pixels and is a grey smudge at 16, which is the
 * only size anybody sees it at.
 *
 * So this renders it at tab size and asks whether the idea survived. The mark
 * is a list of two lines with the second one struck out, and the strike is
 * the whole idea; if the strike is not there at 16 pixels, the mark says
 * nothing and needs redrawing rather than defending.
 *
 * It also refuses a mark that is a picture. Text in an icon is illegible at
 * this size, and an embedded image is a screenshot wearing an icon's clothes.
 */

import fs from 'node:fs';
import path from 'node:path';

import { matchesTheReadme } from './what-the-readme-claims.ts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'public');

const svg = fs.readFileSync(path.join(web, 'mark.svg'), 'utf8');
const page = fs.readFileSync(path.join(web, 'index.html'), 'utf8');

let checks = 0;
let bad = 0;

// ------------------------------------------------------- what it is made of

is('the tab icon is mark.svg', /<link[^>]+rel="icon"[^>]+href="mark\.svg"/.test(page), true);
is('and so is the one in the header', /<img[^>]+src="mark\.svg"/.test(page), true);

is('it has a viewBox, so it scales instead of cropping', /viewBox="[\d\s.-]+"/.test(svg), true);
is('there is no text in it — nothing is legible at 16 pixels', /<text\b/.test(svg), false);
is('and no embedded picture', /<image\b/.test(svg), false);
is('and nothing it has to fetch', /href="https?:/.test(svg), false);
is('it says what it is, for anybody who cannot see it', /aria-label="[^"]+"/.test(svg), true);

// ------------------------------------------------------------ at 16 pixels

let chromium: typeof import('playwright-core').chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright-core'));
} catch {
  console.error('\nplaywright-core is not installed here, so the check at 16 pixels cannot run.');
  console.error('That is the half that matters:  npm install --save-dev playwright-core');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

try {
  const at16 = await inkAt(16);
  const at64 = await inkAt(64);

  // The dark rounded square should cover most of the tile at both sizes. A
  // mark that has become mostly background at 16 has lost its shape.
  is('it still fills its tile at 16 pixels', at16.covered > 0.7, true);

  // The light bars are the list. If they have merged into the ground there is
  // no list left to strike through.
  is('the lines are still visible at 16 pixels', at16.light > 0.04, true);

  // The strike is the idea. This is the assertion the whole file exists for.
  is('and the strike through the second one survives', at16.amber > 0.015, true);

  // And it is the same drawing large — not a different mark that happens to
  // pass the small check.
  is('the same parts are there at 64', at64.light > 0.04 && at64.amber > 0.015, true);

  console.log(
    `\n  ink at 16px: ${(at16.covered * 100).toFixed(0)}% tile, ` +
      `${(at16.light * 100).toFixed(1)}% lines, ${(at16.amber * 100).toFixed(1)}% strike`
  );
} finally {
  await browser.close();
}

// The README's own claim about this command, checked by this command.
console.log('');
if (!matchesTheReadme('npm run check:mark', checks)) bad += 1;

console.log(`\n${bad === 0 ? `All ${checks} checks passed.` : `${bad} of ${checks} checks failed.`}`);
process.exitCode = bad === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

/**
 * Draws the mark at one size and counts what is actually there.
 *
 * Drawn by the browser from the SVG, on a white ground, and read back pixel by
 * pixel — so this measures the mark as a person sees it rather than measuring
 * the numbers in the file, which is the mistake that lets a mark pass while
 * being invisible.
 */
async function inkAt(size: any) {
  const sheet = await browser.newPage({ viewport: { width: size, height: size } });

  try {
    await sheet.setContent(
      `<style>html,body{margin:0;background:#fff}img{display:block;width:${size}px;height:${size}px}</style>` +
        `<img src="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}">`
    );

    await sheet.waitForFunction(() => document.querySelector('img')?.complete === true);

    // Awaited, not just returned. `return promise` inside a try/finally runs
    // the finally at once, so the page is closed while the work is still
    // happening on it — and the error blames the browser rather than this line.
    return await sheet.evaluate((wide) => {
      const canvas = document.createElement('canvas');
      canvas.width = wide;
      canvas.height = wide;

      const brush = canvas.getContext('2d')!;
      brush.fillStyle = '#fff';
      brush.fillRect(0, 0, wide, wide);
      brush.drawImage(document.querySelector('img')!, 0, 0, wide, wide);

      const pixels = brush.getImageData(0, 0, wide, wide).data;
      let covered = 0;
      let light = 0;
      let amber = 0;

      for (let at = 0; at < pixels.length; at += 4) {
        const [red, green, blue] = [pixels[at], pixels[at + 1], pixels[at + 2]];

        // Anything that is not the white ground is part of the mark.
        if (red < 240 || green < 240 || blue < 240) covered += 1;

        // The bars: light, and not much colour in them.
        if (red > 180 && green > 190 && blue > 200) light += 1;

        // The strike: warm, and clearly warmer than it is blue.
        if (red > 170 && green > 110 && green < 210 && blue < 130) amber += 1;
      }

      const all = wide * wide;
      return { covered: covered / all, light: light / all, amber: amber / all };
    }, size);
  } finally {
    await sheet.close();
  }
}

function is(what: string, got: unknown, wanted?: unknown): void {
  checks += 1;

  if (got === wanted) {
    console.log(`  ok    ${what}`);
    return;
  }

  bad += 1;
  console.log(`  NO    ${what}\n          wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
}
