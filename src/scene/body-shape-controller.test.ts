import assert from "node:assert/strict";
import test from "node:test";
import { createBodyShapeController } from "./body-shape-controller";

function body(name: string) {
  return {
    name,
    disposed: 0,
    dispose() {
      this.disposed++;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("body comparisons replace the complete set together and dispose the previous geometry", async () => {
  const old = [body("old-a"), body("old-b")];
  const candidates = [body("new-a"), body("new-b")];
  const loads = candidates.map(() => deferred<ReturnType<typeof body>>());
  let visible = old;
  const controller = createBodyShapeController(
    old,
    (i) => loads[i].promise,
    (next) => {
      visible = next;
    },
  );
  const changing = controller.select("slim");
  loads[0].resolve(candidates[0]);
  await Promise.resolve();
  assert.equal(visible, old);
  loads[1].resolve(candidates[1]);
  assert.equal(await changing, true);
  assert.deepEqual(visible, candidates);
  assert.ok(old.every((value) => value.disposed === 1));
  controller.dispose();
  controller.dispose();
  assert.ok(candidates.every((value) => value.disposed === 1));
});

test("a failed shape leaves the current people visible and disposes partial downloads", async () => {
  const old = [body("old-a"), body("old-b")];
  const partial = body("partial");
  let installs = 0;
  const controller = createBodyShapeController(
    old,
    async (i) => {
      if (i) throw new Error("model unavailable");
      return partial;
    },
    () => {
      installs++;
    },
  );
  await assert.rejects(controller.select("broad"), /model unavailable/);
  assert.equal(installs, 0);
  assert.equal(partial.disposed, 1);
  assert.ok(old.every((value) => value.disposed === 0));
  controller.dispose();
});

test("a stale comparison or closed scene cannot install late bodies", async () => {
  const slow = deferred<ReturnType<typeof body>>();
  const latest = body("latest"),
    stale = body("stale"),
    old = body("old");
  let visible = old;
  const controller = createBodyShapeController(
    [old],
    (_, choice) => (choice === "slim" ? slow.promise : Promise.resolve(latest)),
    (next) => {
      visible = next[0];
    },
  );
  const early = controller.select("slim");
  await controller.select("broad");
  slow.resolve(stale);
  assert.equal(await early, false);
  assert.equal(visible, latest);
  assert.equal(stale.disposed, 1);
  const late = deferred<ReturnType<typeof body>>();
  const closing = createBodyShapeController(
    [body("closing")],
    () => late.promise,
    () => assert.fail("scene is closed"),
  );
  const pending = closing.select("average");
  closing.dispose();
  const abandoned = body("late");
  late.resolve(abandoned);
  assert.equal(await pending, false);
  assert.equal(abandoned.disposed, 1);
  controller.dispose();
});

test("a synchronous builder error still releases candidates that finish later", async () => {
  const old = [body("old-a"), body("old-b")];
  const pending = deferred<ReturnType<typeof body>>();
  const controller = createBodyShapeController(
    old,
    (i) => {
      if (i) throw new Error("synchronous build failure");
      return pending.promise;
    },
    () => assert.fail("failed choices cannot install"),
  );
  const selecting = controller.select("average");
  const candidate = body("late-candidate");
  pending.resolve(candidate);
  await assert.rejects(selecting, /synchronous build failure/);
  assert.equal(candidate.disposed, 1);
  assert.ok(old.every(value => value.disposed === 0));
  controller.dispose();
});

test("an installation error restores the previous set before releasing candidate meshes", async () => {
  const old = [body("old")];
  const candidate = body("new");
  let visible = old;
  const controller = createBodyShapeController(
    old,
    async () => candidate,
    next => {
      visible = next;
      if (next[0] === candidate) throw new Error("render update failed");
    },
  );
  await assert.rejects(controller.select("slim"), /render update failed/);
  assert.deepEqual(visible, old);
  assert.equal(candidate.disposed, 1);
  assert.equal(old[0].disposed, 0);
  controller.dispose();
  assert.equal(old[0].disposed, 1);
});
