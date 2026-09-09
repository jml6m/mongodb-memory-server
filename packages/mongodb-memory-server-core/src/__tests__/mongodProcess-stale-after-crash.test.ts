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
 * The next ordinary `.stop()` call -- e.g. exactly what a normal afterEach/finally cleanup hook
 * would do, nothing special about it -- then trips the assertion in
 * `MongoMemoryServer.cleanup()` (MongoMemoryServer.ts:639-642), because it is checking a field a
 * *different* code path silently failed to clear. No racing or concurrent stop() calls needed.
 */
it('should be able to stop() cleanly after mongod is killed unexpectedly (simulated crash)', async () => {
  const server = await MongoMemoryServer.create();
  const instance = server.instanceInfo!.instance;
  const pid = instance.mongodProcess!.pid;

  // Register before killing so the event can't be missed. closeHandler (MongoInstance.ts)
  // emits "instanceError" synchronously -- which synchronously kicks off the internal auto
  // `stop()`, synchronously assigning `stopPromise` before that call's own first internal
  // await -- strictly before closeHandler goes on to emit "instanceClosed". So by the time
  // this resolves, `stopPromise` is guaranteed to already be set.
  const closedPromise = new Promise<void>((resolve) => {
    instance.once(MongoInstanceEvents.instanceClosed, () => resolve());
  });

  process.kill(pid!, 'SIGKILL'); // simulate a crash, bypassing this library's own stop()
  await closedPromise;

  // Asserted, not branched on: per the ordering above this is a real invariant of this
  // scenario, not something that might or might not be true (confirmed empirically too --
  // true on every run). Awaiting it directly (rather than a fixed sleep) waits for exactly as
  // long as the internal auto-stop actually takes, not a guessed duration.
  expect(instance.stopPromise).toBeDefined();
  await instance.stopPromise!;

  // An entirely ordinary cleanup call -- e.g. what any afterEach/finally hook would do, not a
  // special "second" attempt. This is the actual bug under test: it should be able to clean up
  // after an already-dead process the same as it does after a normal graceful stop.
  const result = await server.stop();
  expect(result).toBe(true);
});
