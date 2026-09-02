/**
 * What the README says about the checks, read back out of the README.
 *
 * The README has a table like this:
 *
 *     npm test              #  92  the rules, the importer, the template…
 *     npm run walkthrough   #  35  the whole story through HTTP…
 *
 * and every one of those numbers is a claim about a program that is sitting
 * right there and could be asked. Until this file existed, none of them was:
 * the README said 86 while `npm test` ran 92, and had done for a while, because
 * nothing on either side ever looked at the other.
 *
 * So each harness ends by comparing its own total against the line about
 * itself. The number is not maintained — it is **checked by the thing it is a
 * number about**, which is the only arrangement where it cannot quietly stop
 * being true.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const README = path.join(here, '..', 'README.md');

/**
 * Every `npm …  # <number>` line in the README, as { command: number }.
 */
export function claims({ file = README } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const found = {};

  for (const line of text.split(/\r?\n/)) {
    const said = line.match(/^\s*(npm (?:test|start|run [a-z:-]+))\s+#\s+(\d+)\b/);
    if (said) found[said[1]] = Number(said[2]);
  }

  return found;
}

/**
 * Compares one harness's real total against what the README says about it.
 *
 * Called at the end of a run, when `total` is a fact rather than an intention.
 * Returns whether it matched so the caller can fail; it does not exit, because
 * a harness that has just reported thirty-five results should report this one
 * too rather than vanishing.
 */
export function matchesTheReadme(command, total, { file = README, say = console.log } = {}) {
  const claimed = claims({ file })[command];

  if (claimed === undefined) {
    say(`  NO    the README does not say how many checks \`${command}\` runs`);
    say(`          it ran ${total}. Add it to the table, or this number is nobody's.`);
    return false;
  }

  if (claimed !== total) {
    say(`  NO    the README says \`${command}\` runs ${claimed} checks; it ran ${total}`);
    say('          the README is a claim about a program that is right here — fix whichever is wrong');
    return false;
  }

  say(`  ok    and the README says ${claimed}, which is what ran`);
  return true;
}
