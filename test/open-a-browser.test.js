/**
 * When the page is opened, and — mostly — when it is not.
 *
 * Every one of these refusals is a way of being wrong that is hard to
 * diagnose from the symptom. A launcher that blocks on a runner turns a green
 * job into one that hangs for six hours; a window opening on a server's console
 * because a supervisor started the service is a surprise nobody can trace back
 * to a line of code.
 *
 * Nothing here spawns anything: the decision is the part worth testing, and the
 * spawn is one line beneath it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openInABrowser } from '../src/open-a-browser.js';

const url = 'http://127.0.0.1:3608/';

describe('opening the page when the service starts', () => {
  it('does not, when told not to on the command line', () => {
    const said = openInABrowser(url, { argv: ['node', 'index.js', '--no-open'], env: {}, isTTY: true });
    assert.equal(said.opened, false);
    assert.match(said.why, /--no-open/);
  });

  it('does not, when told not to in the environment', () => {
    const said = openInABrowser(url, { argv: [], env: { NO_OPEN: '1' }, isTTY: true });
    assert.equal(said.opened, false);
    assert.match(said.why, /NO_OPEN/);
  });

  it('and NO_OPEN=0 means what it says, rather than being any value at all', () => {
    // A guard that treats "0" as "yes" is the reason people write NO_OPEN=0 and
    // then file a bug about the flag not working.
    const said = openInABrowser(url, { argv: [], env: { NO_OPEN: '0', CI: 'true' }, isTTY: true });
    assert.match(said.why, /CI/, 'NO_OPEN=0 should have been ignored, leaving CI to refuse');
  });

  it('does not, in CI, where there is no browser and the launcher may block', () => {
    const said = openInABrowser(url, { argv: [], env: { CI: 'true' }, isTTY: true });
    assert.equal(said.opened, false);
    assert.match(said.why, /CI/);
  });

  it('does not, when nothing is attached to the terminal', () => {
    const said = openInABrowser(url, { argv: [], env: {}, isTTY: false });
    assert.equal(said.opened, false);
    assert.match(said.why, /terminal/);
  });

  it('always says why it did not, because silence reads as breakage', () => {
    for (const [argv, env, isTTY] of [
      [['--no-open'], {}, true],
      [[], { NO_OPEN: '1' }, true],
      [[], { CI: '1' }, true],
      [[], {}, false],
    ]) {
      const said = openInABrowser(url, { argv, env, isTTY });
      assert.ok(said.why && said.why.length > 4, 'a refusal with no reason in it');
    }
  });
});
