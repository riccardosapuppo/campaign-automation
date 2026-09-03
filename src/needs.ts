/**
 * What this needs to run at all, checked before anything imports it.
 *
 * The database is `node:sqlite`, which is part of Node rather than a
 * dependency — that is the point of it. But "part of Node" is only true from a
 * certain version onwards, and on an older one the failure is this:
 *
 *     Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *         at ModuleLoader.builtinStrategy (node:internal/modules/esm/...)
 *
 * — thrown by the module loader, several frames deep, before a single line of
 * this project has run. Nothing inside the program can catch it, because the
 * program has not started; and nothing in that message tells a reader that the
 * answer is "use a newer Node", which is the only thing they need to know.
 *
 * So the check happens here, in a file that imports nothing, and the entry
 * point loads everything else only after it has passed. An engine that
 * declines has to say what is missing.
 *
 * The version below is the one this is actually known to work on. Node 22.5
 * has `node:sqlite` behind `--experimental-sqlite`, which is not the same as
 * having it, and the README said 22.5 until continuous integration ran the
 * project on 22.5 and proved otherwise. It is checked from both sides now:
 * one job runs everything on a version that works, and another runs it on a
 * version that does not and asserts that the refusal below is what a person
 * sees.
 */

export const NEEDS_NODE = 24;

/**
 * @returns {{ ok: boolean, why: string }}
 *
 * `load` is injected for one reason: on a Node that has `node:sqlite` there is
 * no way to make the import fail, so without it the refusal below could never
 * be exercised by a test — only by continuous integration, on a machine nobody
 * is looking at, in the one job that is supposed to prove it. A guard whose
 * failing path cannot be run is a guard nobody can trust. Both ends check it
 * now: a test here for the words, and a CI job for the real thing.
 */
export async function runtimeIsUsable({
  version = process.versions.node,
  load = () => import('node:sqlite'),
}: { version?: string; load?: () => Promise<unknown> } = {}) {
  const major = Number(String(version).split('.')[0]);

  try {
    await load();
    return { ok: true, why: `Node ${version}, and node:sqlite is here` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;

    return {
      ok: false,
      why:
        `this needs Node ${NEEDS_NODE} or newer, and this is Node ${version}.\n\n` +
        '  The database is node:sqlite, which is part of Node itself rather than a\n' +
        '  dependency — so there is nothing to install, and nothing that can be\n' +
        '  installed to fix this. On Node 22 it exists only behind\n' +
        '  --experimental-sqlite, which is not the same as existing.\n\n' +
        `  Install Node ${NEEDS_NODE} or newer and run this again.` +
        (major >= NEEDS_NODE
          ? '\n\n  (That version looks new enough, which means something stranger is\n' +
            '  going on: node:sqlite is missing from a Node that should have it.)'
          : ''),
    };
  }
}

/** Says what is wrong and stops, or returns quietly. */
export async function orStop() {
  const said = await runtimeIsUsable();
  if (said.ok) return said;

  process.stderr.write(`\n  ${said.why}\n\n`);
  process.exit(1);
}
