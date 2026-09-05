/**
 * What the README says this costs, measured on the machine that is reading it.
 *
 * The README has a paragraph headed **Measured, not estimated**, and the name
 * was the whole of the problem: the figures were measured once, into prose, and
 * prose is not measured again. By the time anybody looked, three of them had
 * come apart — `npm install` fetched 81 packages against a promised 68, wrote
 * 42.2 MB into `node_modules` against a promised 17, and the repository was
 * 2.6 MB against 2.3. The 81 was not even hidden: the CI file says "added 81
 * packages" in a comment, a few hundred lines under the sentence saying 68.
 *
 * A figure copied into a paragraph is a measurement with the instrument thrown
 * away. So the instrument stays here. The figures are read back out of the
 * sentence and taken again — the packages from the file npm fetches them by,
 * the two sizes from the disk — and test/readme.test.ts fails the build when
 * the paragraph and the repository stop agreeing. As with the check counts next
 * door, the number is not maintained: it is checked against the thing it is a
 * number about, which is the only arrangement in which it cannot quietly rot.
 *
 * The one figure in that paragraph this does not take is the size of the
 * Mailpit image, and that is deliberate rather than forgotten. It is a number
 * about something that is not on this machine until `npm run check:smtp` pulls
 * it, and the sentence it sits in is the sentence promising that nothing else
 * here touches the network. Measuring it would mean going and getting it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const README = path.join(root, 'README.md');

/**
 * MB is 10^6 bytes: what npm, the disk and every download dialogue mean by it.
 *
 * Worth stating, because the same directory is 40.2 in MiB. A check that
 * measured the other unit would pass on a README that is out by 5% and would
 * be arguing about units rather than about the truth of the sentence.
 */
const MB = 1_000_000;

/**
 * How far a stated size may be from the real one, in MB.
 *
 * A tenth, which is the precision the README states these to — plus room for
 * the few kilobytes npm keeps for itself under `node_modules/.bin` and
 * `.package-lock.json`, which are shims on Windows and symlinks on the Linux
 * the CI runs on. Wide enough not to flap between the two, far too narrow to
 * let a dependency arrive unnoticed.
 */
export const AGREES_WITHIN = 0.1;

/**
 * The figures out of the "Measured, not estimated" paragraph.
 *
 * `undefined` for anything it no longer states in a form this can read, which
 * the caller has to treat as a failure rather than as a pass: a regex that has
 * stopped matching looks from here exactly like a claim nobody is making.
 */
export function claimedCosts({ file = README } = {}) {
  // Flattened first. The sentence wraps, and every one of these figures sits
  // on the other side of a line break from the words that name it.
  const said = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');

  return {
    packages: figure(said.match(/fetches \*{0,2}(\d+)\*{0,2} packages/)),
    nodeModules: figure(said.match(/\*\*([\d.]+) MB\*\* into `node_modules`/)),
    repository: figure(said.match(/repository itself is \*\*([\d.]+) MB\*\*/)),
  };
}

/**
 * How many packages `npm install` fetches, from the file it fetches them by.
 *
 * The lock file's own count — the number npm reads out at the end, "added 81
 * packages" — and not a count of directories under `node_modules`, which drops
 * when somebody has installed without the dev dependencies and would then make
 * the README right about a smaller install than the one it is describing.
 */
export function packagesInTheLock({ file = path.join(root, 'package-lock.json') } = {}) {
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));

  return Object.keys(lock.packages).filter((one) => one.startsWith('node_modules/')).length;
}

/** What `npm install` has actually left on the disk, in MB. */
export function megabytesInNodeModules({ dir = path.join(root, 'node_modules') } = {}) {
  return bytesUnder(dir) / MB;
}

/**
 * What the repository itself weighs, in MB: the files git is tracking, at the
 * size they are now rather than the size they were when somebody wrote 2.3.
 *
 * Asked of git instead of counted by walking the tree, because a walk would
 * have to re-implement .gitignore and would still count whatever the person
 * running it has left lying about — a stray recording, a database, a zip. If
 * git is not answering it says so and fails, rather than falling back on a
 * guess about which files belong: the paragraph this checks is called
 * "Measured, not estimated", and a guess is the thing it says it is not.
 */
export function megabytesInTheRepository() {
  let tracked: string;

  try {
    tracked = String(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 24 }));
  } catch (cause) {
    throw new Error('git is what knows the size of this repository, and it is not answering here', { cause });
  }

  const files = tracked.split('\0').filter(Boolean);

  // An empty list would add up to nothing and agree with nothing, but a README
  // claiming 0.0 MB is not the failure worth guarding against — one that has
  // silently started measuring an empty list is.
  if (files.length === 0) throw new Error('git is tracking no files here, so there is nothing to measure');

  return files.reduce((all, one) => all + fs.statSync(path.join(root, one)).size, 0) / MB;
}

/**
 * Every file under a directory, added up.
 *
 * Directories are recursed into, files are counted, and nothing else is:
 * `node_modules/.bin` is symlinks on Linux, and a link is not a copy of the
 * thing it points at — counting it would add megabytes that were never fetched.
 */
function bytesUnder(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((all, one) => {
    const at = path.join(dir, one.name);

    if (one.isDirectory()) return all + bytesUnder(at);
    return one.isFile() ? all + fs.statSync(at).size : all;
  }, 0);
}

function figure(found: RegExpMatchArray | null) {
  return found ? Number(found[1]) : undefined;
}
