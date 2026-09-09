import MongoMemoryServer from '../MongoMemoryServer';
import { MongoInstanceEvents } from '../util/MongoInstance';

jest.setTimeout(20000);

/**
 * Reproduces: after mongod dies unexpectedly (not via this library's own stop()), the internal
 * auto-recovery in MongoInstance's "instanceError" handler (registered in the constructor,
 * MongoInstance.ts) calls `stop()` on its own -- but `stop()`'s `else` branch (taken because the
 * process is already dead, so `isAlive()` correctly returns false) never resets
 * `this.mongodProcess` back to `undefined` (MongoInstance.ts, `stop()`). The next ordinary
 * `.stop()` call then trips the assertion in `MongoMemoryServer.cleanup()`
 * (MongoMemoryServer.ts:639-642), because it is checking a field that a *different* code path
 * silently failed to clear -- no racing or concurrent stop() calls are needed to hit this.
 */
it('should be able to stop() cleanly after mongod is killed unexpectedly (simulated crash)', async () => {
  const server = await MongoMemoryServer.create();
  const instance = server.instanceInfo!.instance;
  const pid = instance.mongodProcess!.pid;

  // Register before killing so the event can't be missed. closeHandler (MongoInstance.ts)
  // emits "instanceError" -- which synchronously kicks off the internal auto `stop()`,
  // synchronously assigning `stopPromise` before that call's own first internal await --
  // strictly before it emits "instanceClosed". So once this resolves, `instance.stopPromise`
  // is guaranteed to already be set (if it is going to be at all); awaiting it directly waits
  // for exactly as long as the internal auto-stop actually takes, not a guessed duration.
  const closedPromise = new Promise<void>((resolve) => {
    instance.once(MongoInstanceEvents.instanceClosed, () => resolve());
  });

  process.kill(pid!, 'SIGKILL'); // simulate a crash, bypassing this library's own stop()
  await closedPromise;

  if (instance.stopPromise) {
    await instance.stopPromise;
  }

  // this is the actual bug under test: stop() should be able to clean up after an
  // already-dead process, the same as it does after a normal graceful stop
  const result = await server.stop();
  expect(result).toBe(true);
});
