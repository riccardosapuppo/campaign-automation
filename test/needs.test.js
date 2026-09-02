/**
 * What the program says on a Node that cannot run it.
 *
 * This is the only part of the project a person on the wrong runtime will ever
 * see, so it is worth more care than its size suggests. Before it existed, what
 * they saw was:
 *
 *     Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *         at ModuleLoader.builtinStrategy (node:internal/modules/esm/...)
 *
 * — which does not contain the word "version" anywhere.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NEEDS_NODE, runtimeIsUsable } from '../src/needs.js';

/** What Node's loader actually throws when a built-in is not there. */
function missing() {
  const error = new Error('No such built-in module: node:sqlite');
  error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
  throw error;
}

describe('what it needs to run', () => {
  it('is happy when node:sqlite is there', async () => {
    const said = await runtimeIsUsable({ version: '24.19.0', load: async () => ({}) });

    assert.equal(said.ok, true);
  });

  it('refuses when it is not', async () => {
    const said = await runtimeIsUsable({ version: '22.5.1', load: missing });

    assert.equal(said.ok, false);
  });

  it('says which version is needed, and which one this is', async () => {
    const { why } = await runtimeIsUsable({ version: '22.5.1', load: missing });

    assert.match(why, new RegExp(`needs Node ${NEEDS_NODE} or newer`));
    assert.match(why, /this is Node 22\.5\.1/);
  });

  it('says what is actually missing, and that installing will not help', async () => {
    // A person whose first instinct is `npm install` needs to be told, in the
    // same breath, that there is nothing to install.
    const { why } = await runtimeIsUsable({ version: '20.0.0', load: missing });

    assert.match(why, /node:sqlite/);
    assert.match(why, /part of Node itself rather than a\s+dependency/);
    assert.match(why, /nothing that can be\s+installed to fix this/);
  });

  it('does not tell somebody on a new enough Node to upgrade', async () => {
    // If node:sqlite is missing from a Node 24, "install Node 24" is useless
    // advice and sends them in a circle. Say that something stranger is wrong.
    const { why } = await runtimeIsUsable({ version: '24.0.0', load: missing });

    assert.match(why, /something stranger/);
  });

  it('does not swallow an error that is about something else', async () => {
    // A syntax error inside the database module would otherwise be reported as
    // "you need a newer Node", which sends somebody after the wrong problem
    // for an afternoon.
    await assert.rejects(
      runtimeIsUsable({
        load: () => {
          throw new TypeError('something else entirely');
        },
      }),
      /something else entirely/
    );
  });
});
