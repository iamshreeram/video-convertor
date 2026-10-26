import test from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../../web/js/queue/queue.js";
import { createMemoryBudget } from "../../web/js/core/memory-budget.js";

const file = (name) => ({ name, size: 10 });
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

test("jobs run sequentially in FIFO order and finish as done with their result", async () => {
  const order = [];
  let running = 0;
  let maxRunning = 0;
  const gates = {};
  const q = createQueue({
    run: async (job, ctx) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start:${job.file.name}`);
      ctx.setState("converting");
      gates[job.file.name] = deferred();
      const r = await gates[job.file.name].promise;
      order.push(`end:${job.file.name}`);
      running--;
      return r;
    },
  });
  const a = q.add(file("a")), b = q.add(file("b")), c = q.add(file("c"));
  assert.equal(a.state === "queued" || a.state === "analyzing", true);
  await tick();
  assert.deepEqual(order, ["start:a"]);
  assert.equal(q.jobs.find((j) => j.id === a.id).state, "converting");
  assert.equal(q.jobs.find((j) => j.id === b.id).state, "queued");
  gates.a.resolve({ url: "A" });
  await tick();
  assert.deepEqual(order, ["start:a", "end:a", "start:b"]);
  gates.b.resolve({ url: "B" });
  await tick();
  gates.c.resolve({ url: "C" });
  await tick();
  assert.equal(maxRunning, 1);
  assert.deepEqual(q.jobs.map((j) => [j.file.name, j.state, j.result?.url]), [["a", "done", "A"], ["b", "done", "B"], ["c", "done", "C"]]);
});

test("a started job is 'analyzing' until the runner says otherwise; ctx.update merges fields; subscribers see snapshots", async () => {
  const seen = [];
  const g = deferred();
  const q = createQueue({
    run: async (job, ctx) => {
      ctx.update({ progress: 0.5, speed: 10 });
      await g.promise;
      return "ok";
    },
  });
  q.subscribe((jobs) => seen.push(jobs.map((j) => `${j.state}:${j.progress ?? "-"}`).join(",")));
  q.add(file("a"));
  await tick();
  assert.ok(seen.some((s) => s === "analyzing:0.5"), JSON.stringify(seen));
  g.resolve();
  await tick();
  assert.equal(seen.at(-1), "done:0.5");
  const snap = q.jobs;
  snap.length = 0; // mutating a snapshot must not affect the queue
  assert.equal(q.jobs.length, 1);
});

test("a failing job becomes 'error' with its message and the queue continues", async () => {
  const q = createQueue({
    run: async (job) => {
      if (job.file.name === "bad") throw new Error("boom");
      return "fine";
    },
  });
  q.add(file("bad"));
  q.add(file("good"));
  await tick();
  await tick();
  assert.deepEqual(q.jobs.map((j) => [j.state, j.error ?? null]), [["error", "boom"], ["done", null]]);
});

test("cancel(queued) never runs the job", async () => {
  const started = [];
  const g = deferred();
  const q = createQueue({
    run: async (job) => {
      started.push(job.file.name);
      await g.promise;
    },
  });
  q.add(file("a"));
  const b = q.add(file("b"));
  q.add(file("c"));
  await tick();
  q.cancel(b.id);
  assert.equal(q.jobs.find((j) => j.id === b.id).state, "cancelled");
  g.resolve();
  await tick();
  await tick();
  assert.deepEqual(started, ["a", "c"]);
});

test("cancel(running): onCancel runs once, job is cancelled at once, queue advances WITHOUT the old run ever settling, late updates are ignored, late result goes to onDiscard once", async () => {
  const discards = [];
  const cancelCalls = [];
  const never = deferred();
  let oldCtx;
  const started = [];
  const q = createQueue({
    run: async (job, ctx) => {
      started.push(job.file.name);
      if (job.file.name === "a") {
        oldCtx = ctx;
        ctx.onCancel(() => cancelCalls.push("a"));
        ctx.setState("converting");
        return never.promise; // a terminated worker never settles
      }
      return `result-${job.file.name}`;
    },
    onDiscard: (job, result) => discards.push([job.file.name, result]),
  });
  const a = q.add(file("a"));
  q.add(file("b"));
  await tick();
  q.cancel(a.id);
  q.cancel(a.id); // idempotent
  assert.deepEqual(cancelCalls, ["a"]);
  assert.equal(q.jobs[0].state, "cancelled");
  await tick();
  await tick();
  assert.deepEqual(started, ["a", "b"], "next job started although the first run never settled");
  assert.equal(q.jobs[1].state, "done");
  oldCtx.update({ progress: 0.9 });
  oldCtx.setState("done");
  assert.equal(q.jobs[0].state, "cancelled");
  assert.equal(q.jobs[0].progress, undefined);
  never.resolve({ url: "late" });
  await tick();
  assert.deepEqual(discards, [["a", { url: "late" }]]);
  assert.equal(q.jobs[0].state, "cancelled");
});

test("late rejection after cancel is swallowed", async () => {
  const d = deferred();
  const q = createQueue({ run: (job, ctx) => d.promise });
  const a = q.add(file("a"));
  await tick();
  q.cancel(a.id);
  d.reject(new Error("late failure"));
  await tick();
  assert.equal(q.jobs[0].state, "cancelled");
  assert.equal(q.jobs[0].error ?? null, null);
});

test("remove(): done job -> onRemove once; running job -> cancel then onRemove once, never resurrected; queued job -> just dropped", async () => {
  const removed = [];
  const discarded = [];
  const cancels = [];
  const d = deferred();
  const q = createQueue({
    run: async (job, ctx) => {
      if (job.file.name === "slow") {
        ctx.onCancel(() => cancels.push("slow"));
        return d.promise;
      }
      return "x";
    },
    onRemove: (job) => removed.push(job.file.name),
    onDiscard: (job) => discarded.push(job.file.name),
  });
  const done = q.add(file("quick"));
  const slow = q.add(file("slow"));
  const queued = q.add(file("later"));
  await tick();
  await tick();
  q.remove(done.id);
  assert.deepEqual(removed, ["quick"]);
  q.remove(slow.id);
  assert.deepEqual(cancels, ["slow"]);
  assert.deepEqual(removed, ["quick", "slow"]);
  q.remove(slow.id); // already gone: no second onRemove
  assert.deepEqual(removed, ["quick", "slow"]);
  d.resolve("late");
  await tick();
  assert.deepEqual(discarded, ["slow"]);
  assert.ok(!q.jobs.some((j) => j.file.name === "slow"), "removed job must not reappear");
  await tick();
  // 'later' started after the running job was removed
  assert.equal(q.jobs.find((j) => j.id === queued.id).state, "done");
  const q2 = createQueue({ run: () => new Promise(() => {}), onRemove: (j) => removed.push("q2:" + j.file.name) });
  q2.add(file("blocker"));
  const waiting = q2.add(file("waiting"));
  await tick();
  q2.remove(waiting.id);
  assert.ok(!removed.includes("q2:waiting"));
  assert.equal(q2.jobs.length, 1);
});

test("clearFinished removes done/error/cancelled jobs (onRemove each once) and keeps active ones", async () => {
  const removed = [];
  const g = deferred();
  const q = createQueue({
    run: async (job) => {
      if (job.file.name === "bad") throw new Error("x");
      if (job.file.name === "active") return g.promise;
      return "ok";
    },
    onRemove: (j) => removed.push(j.file.name),
  });
  q.add(file("ok1"));
  q.add(file("bad"));
  const c = q.add(file("c"));
  q.add(file("active"));
  q.add(file("waiting"));
  q.cancel(c.id);
  await tick();
  await tick();
  await tick();
  q.clearFinished();
  assert.deepEqual(removed.sort(), ["bad", "c", "ok1"]);
  assert.deepEqual(q.jobs.map((j) => j.file.name), ["active", "waiting"]);
});

test("memory budget: reserve/release/can-fit, never negative, idempotent release", () => {
  const b = createMemoryBudget(1000);
  assert.equal(b.remaining(), 1000);
  assert.equal(b.canFit(1000), true);
  assert.equal(b.canFit(1001), false);
  assert.equal(b.reserve("a", 600), true);
  assert.equal(b.remaining(), 400);
  assert.equal(b.reserve("b", 500), false);
  assert.equal(b.remaining(), 400, "failed reserve changes nothing");
  assert.equal(b.reserve("b", 400), true);
  assert.equal(b.remaining(), 0);
  assert.equal(b.reserve("a", 1), false, "key already reserved");
  b.release("a");
  b.release("a");
  assert.equal(b.remaining(), 600);
  b.release("unknown");
  assert.equal(b.remaining(), 600);
  assert.equal(b.used(), 400);
  assert.equal(b.reserve("c", -5), false);
  assert.equal(b.reserve("d", NaN), false);
  b.release("b");
  assert.equal(b.remaining(), 1000);
  assert.equal(createMemoryBudget(0).canFit(1), false);
  assert.equal(createMemoryBudget(0).canFit(0), true);
});
