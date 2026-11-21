// How long a session's daemons follow it: its host, or without one, its activity.
import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { hostGone } from '../src/runtimes/base.ts';
import { findHostPid } from '../src/runtimes/process.ts';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROCESS_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtimes/process.ts');

const HOUR = 3600 * 1000;

describe('hostGone without a host pid', () => {
  it.effect('ends once the session has been quiet for 6 h, not before', () =>
    Effect.gen(function* () {
      let active = 0;
      const gone = yield* Effect.forkChild(hostGone(0, () => active));
      yield* TestClock.adjust(5 * HOUR);
      active = 5 * HOUR; // the session did something
      yield* TestClock.adjust(5 * HOUR);
      assert.isUndefined(gone.pollUnsafe(), 'still active 5 h ago');
      yield* TestClock.adjust(HOUR);
      yield* Fiber.join(gone);
    }),
  );

  it.effect('without anything known of the session, counts from its own start', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(7 * HOUR);
      const gone = yield* Effect.forkChild(hostGone(0, () => 0));
      yield* TestClock.adjust(5 * HOUR);
      assert.isUndefined(gone.pollUnsafe());
      yield* TestClock.adjust(HOUR);
      yield* Fiber.join(gone);
    }),
  );
});

describe('findHostPid', () => {
  it('names the first ancestor that is not a shell', () => {
    assert.strictEqual(findHostPid(process.pid), process.pid);
    // A hook run through shells: the host is this process, past both of them.
    const probe = `import(${JSON.stringify(PROCESS_TS)}).then((m) => console.log(m.findHostPid()))`;
    const inner = `${process.execPath} -e '${probe}'; true`;
    const out = spawnSync('/bin/sh', ['-c', `/bin/zsh -c "${inner.replace(/"/g, '\\"')}"; true`], { encoding: 'utf8' });
    assert.strictEqual(Number(out.stdout.trim()), process.pid, out.stderr);
  });

  it('is null for a pid that does not exist', () => {
    assert.isNull(findHostPid(999_999));
  });
});
