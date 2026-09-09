import * as fs from 'fs';
import MongoMemoryServer from '../MongoMemoryServer';
import { MongoInstanceEvents } from '../util/MongoInstance';

jest.setTimeout(20000);

/**
 * Reproduces: after mongod dies unexpectedly (not via this library's own stop()), the internal
 * auto-recovery in MongoInstance's "instanceError" handler (registered in the constructor,
 * MongoInstance.ts) calls `stop()` on its own -- but `stop()`'s `else` branch (taken because the
 * process is already dead, so `isAlive()` correctly returns false) never resets
 * `this.mongodProcess` back to `undefined` (MongoInstance.ts, `stop()`). So the auto-recovery
 * does not fully recover: internal flags (isInstanceReady/isInstancePrimary) get reset
 * correctly, but `mongodProcess` is left stale. (Note: this library has no automatic mongod
 * *restart* on crash anywhere -- "auto-recovery" here means internal cleanup only.)
 *
 * This matters beyond an internal assertion being pedantic:
 *  - The very next ordinary `.stop()` call -- e.g. exactly what a normal afterEach/afterAll
 *    cleanup hook would do, nothing special about it -- trips the assertion in
 *    `MongoMemoryServer.cleanup()` (MongoMemoryServer.ts:639-642) *before* that function ever
 *    reaches its own `removeDir(tmpDir)` call. The temp dbPath is never cleaned up: a permanent
 *    disk leak on every crash.
 *  - The object can't be recovered by restarting it either -- the same stale `mongodProcess`
 *    reference trips a *different* assertion in `start()`. There is no way back from this state
 *    once it happens; the server object is simply unusable from then on.
 *
 * The scenario itself isn't exotic: a library whose entire purpose is running short-lived mongod
 * processes for tests will routinely see mongod OOM-killed or otherwise crash on
 * resource-constrained CI runners. No test code here does anything unusual -- only the
 * environment is hostile, which is the normal case this library is built for.
 */
it('leaves the server unrecoverable and leaks its dbPath after mongod is killed unexpectedly', async () => {
  const server = await MongoMemoryServer.create();
  const instance = server.instanceInfo!.instance;
  const pid = instance.mongodProcess!.pid;
  const dbPath = server.instanceInfo!.dbPath;

  // Register before killing so the event can't be missed. closeHandler (MongoInstance.ts)
  // emits "instanceError" synchronously -- which synchronously kicks off the internal auto
  // `stop()`, synchronously assigning `stopPromise` before that call's own first internal
  // await -- strictly before closeHandler goes on to emit "instanceClosed". So by the time
  // this resolves, `stopPromise` is guaranteed to already be set (assert this rather than
  // branch on it, since it's a proven invariant, not a possible race) -- but only *set*, not
  // *finished*. Awaiting `stopPromise` itself afterward is what waits for the internal
  // auto-stop to actually complete; without it we'd be racing our own stop() call below
  // against the still-running internal one instead of isolating this as the clean, purely
  // sequential bug it is.
  const closedPromise = new Promise<void>((resolve) => {
    instance.once(MongoInstanceEvents.instanceClosed, () => resolve());
  });

  process.kill(pid!, 'SIGKILL'); // simulate a crash, bypassing this library's own stop()
  await closedPromise;
  expect(instance.stopPromise).toBeDefined();
  await instance.stopPromise!;

  // An entirely ordinary cleanup call -- e.g. what any afterEach/afterAll hook would do, not a
  // special "second" attempt. This is the actual bug under test: it should succeed cleanly,
  // the same as it does after a normal graceful stop. Caught explicitly (rather than asserted
  // with .rejects, which would make this test pass on the current, buggy behavior) so
  // execution can continue far enough to also demonstrate the downstream consequences below in
  // the same run, and so the real assertion at the bottom is what fails this test/CI red.
  let stopError: Error | undefined;
  try {
    await server.stop();
  } catch (err) {
    stopError = err as Error;
  }

  console.log('stop() after the crash threw:', stopError?.message);

  // Consequence 1: cleanup() throws before it ever reaches its own removeDir(tmpDir) call, so
  // the temp directory is never cleaned up -- a permanent disk leak on every crash.
  const dbPathLeaked = fs.existsSync(dbPath);

  console.log('dbPath still on disk after the failed stop()?', dbPathLeaked);

  // Consequence 2: the same stale reference means the object can't even be recovered by
  // restarting it -- there is no way back from this state once it happens.
  let startError: Error | undefined;
  try {
    await server.start();
    await server.stop();
  } catch (err) {
    startError = err as Error;
  }

  console.log('restarting the same (unrecoverable) object also threw:', startError?.message);

  // manual cleanup, since the library itself has no way to recover from here
  fs.rmSync(dbPath, { recursive: true, force: true });

  expect({ stopError: stopError?.message, dbPathLeaked, startError: startError?.message }).toEqual({
    stopError: undefined,
    dbPathLeaked: false,
    startError: undefined,
  });
});
