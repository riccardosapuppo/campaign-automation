/**
 * Open the page when the service starts.
 *
 * A URL printed in a terminal is a URL somebody has to notice, select and
 * paste. That is a small tax and it is charged at exactly the wrong moment —
 * the first ten seconds, when whoever is looking has not yet decided whether
 * this is worth their time.
 *
 * ── The four times it must NOT do this ───────────────────────────────────────
 *
 * A program that opens a browser when nobody is watching is worse than one that
 * never does. Each of these has a way of being wrong that is hard to diagnose:
 *
 *  1. `--no-open`, because somebody said so;
 *  2. `NO_OPEN=1`, the same thing for a script that cannot pass arguments;
 *  3. `CI` is set — a runner has no browser, and on some of them the launcher
 *     blocks instead of failing, which turns a green job into one that hangs
 *     for six hours and is quietly cancelled;
 *  4. there is no terminal attached. A service started by a supervisor, a
 *     scheduled task or another program has no person in front of it, and
 *     opening a window on the machine's console is at best a surprise.
 *
 * It also never fails the start. A browser that will not open is a nuisance;
 * a service that will not start because a browser would not open is a fault.
 */

import { spawn } from 'node:child_process';

/**
 * @returns {{opened: boolean, why: string}} what happened, so the caller can
 *   log it. Silence about not opening is how "it did not open" becomes a bug
 *   report about the service being broken.
 */
export function openInABrowser(url, { argv = process.argv, env = process.env, isTTY = process.stdout.isTTY } = {}) {
  if (argv.includes('--no-open')) return { opened: false, why: '--no-open was given' };
  if (env.NO_OPEN && env.NO_OPEN !== '0') return { opened: false, why: 'NO_OPEN is set' };
  if (env.CI && env.CI !== 'false') return { opened: false, why: 'this is CI' };
  if (!isTTY) return { opened: false, why: 'nothing is attached to this terminal' };

  try {
    const [command, args] = launcher(url);

    // Detached and unreferenced: the browser must not keep this process alive,
    // and this process must not take the browser down when it stops.
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      /* a machine with no browser is not a failure of this service */
    });
    child.unref();

    return { opened: true, why: 'opened in the default browser' };
  } catch (error) {
    return { opened: false, why: `could not open a browser: ${error.message}` };
  }
}

function launcher(url) {
  if (process.platform === 'win32') {
    // The empty string is the window TITLE, not a mistake. Without it `start`
    // treats a quoted URL as the title and opens nothing at all — silently,
    // which is the worst of both.
    return ['cmd.exe', ['/d', '/c', 'start', '""', url.replace(/&/g, '^&')]];
  }

  if (process.platform === 'darwin') return ['open', [url]];

  return ['xdg-open', [url]];
}
