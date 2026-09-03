#!/usr/bin/env node
/**
 * The way in — and it is plain JavaScript on purpose.
 *
 * Everything under `src/` is TypeScript that Node runs directly, which works
 * from Node 24 and not before it. So on Node 22 the program cannot be *parsed*,
 * let alone run — and the careful refusal in `src/needs.ts`, which exists to say
 * "this needs Node 24, and here is why" instead of throwing a stack trace at
 * somebody, never gets the chance to speak.
 *
 * **A guard has to be readable by the runtime it guards against.** That is the
 * whole reason this file is not `.ts`: it is four lines of the oldest JavaScript
 * there is, so that every Node ever shipped can load it and be told what is
 * wrong. The moment it needs anything newer, it stops being a guard and becomes
 * another way to fail.
 *
 * It was a CI job that found this. The conversion to TypeScript went green
 * everywhere except the one job that runs the program on an old Node and reads
 * what it says — which is exactly the job that existed for this.
 */

const NEEDS = 24;
const major = Number(process.versions.node.split('.')[0]);

if (major < NEEDS) {
  console.error(`This needs Node ${NEEDS} or newer. This is Node ${process.versions.node}.`);
  console.error('');
  console.error('Two things in it arrived in 24:');
  console.error('  · node:sqlite, which is the database and is not a dependency');
  console.error('  · running TypeScript without a build step');
  console.error('');
  console.error('  nvm install 24   (or https://nodejs.org)');

  process.exit(1);
}

await import('./src/index.ts');
