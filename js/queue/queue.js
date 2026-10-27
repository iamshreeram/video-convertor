/**
 * Pure sequential job queue (DESIGN.md B3.3, incl. ONCE-ONLY SETTLEMENT CONTRACT).
 * One run in flight at a time. A cancelled run is abandoned immediately; if it
 * settles later, its result goes to onDiscard and never changes the job.
 * No DOM access; runs in browsers and under node:test.
 */

const TERMINAL = new Set(["done", "error", "cancelled"]);
/** Fields a runner may not overwrite via ctx.update. */
const RESERVED = new Set(["id", "file", "state", "error", "result"]);

/** @param {unknown} err @returns {string} message text for a rejection reason */
function errorMessage(err) {
  if (typeof err === "string" && err) return err;
  if (err && typeof err.message === "string" && err.message) return err.message;
  return "Unknown error";
}

/**
 * @param {{run: Function, onRemove?: Function, onDiscard?: Function}} options
 *   run(job, ctx) -> Promise; onRemove(job) once per removal; onDiscard(job, result)
 *   for results that arrive after cancellation.
 */
export function createQueue(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const run =
    typeof opts.run === "function"
      ? opts.run
      : () => Promise.reject(new Error("no runner configured"));
  const onRemove = typeof opts.onRemove === "function" ? opts.onRemove : null;
  const onDiscard = typeof opts.onDiscard === "function" ? opts.onDiscard : null;

  /** @type {Array<{job: object, settled: boolean, cancelled: boolean, cancelRan: boolean, cancelFns: Function[]}>} */
  let records = [];
  const subscribers = new Set();
  let nextId = 1;
  let current = null; // record of the run in flight
  let pumpScheduled = false;

  /** Calls fn, swallowing any error it throws. */
  function safeCall(fn, ...args) {
    try {
      fn(...args);
    } catch {
      // User callbacks must not break the queue.
    }
  }

  function notify() {
    for (const fn of [...subscribers]) {
      safeCall(fn, records.map((r) => ({ ...r.job })));
    }
  }

  const find = (id) => records.find((r) => r.job.id === id) || null;
  const drop = (rec) => {
    records = records.filter((r) => r !== rec);
  };

  function pump() {
    if (current) return;
    const next = records.find((r) => r.job.state === "queued");
    if (next) start(next);
  }

  /** Defers the next start to a microtask so add() never runs user code re-entrantly. */
  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    Promise.resolve().then(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function makeCtx(rec) {
    return {
      update(patch) {
        if (rec.settled || !patch || typeof patch !== "object") return;
        for (const key of Object.keys(patch)) {
          if (!RESERVED.has(key)) rec.job[key] = patch[key];
        }
        notify();
      },
      setState(state) {
        if (rec.settled || typeof state !== "string" || TERMINAL.has(state)) return;
        rec.job.state = state;
        notify();
      },
      onCancel(fn) {
        if (typeof fn !== "function") return;
        if (rec.cancelRan) safeCall(fn); // registered after cancellation: run now
        else rec.cancelFns.push(fn);
      },
    };
  }

  function start(rec) {
    current = rec;
    rec.job.state = "analyzing";
    notify();
    let pending;
    try {
      pending = Promise.resolve(run(rec.job, makeCtx(rec)));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (result) => settle(rec, true, result),
      (err) => settle(rec, false, err),
    );
  }

  /** Normal completion, or a late settlement of a cancelled run. */
  function settle(rec, ok, value) {
    if (rec.cancelled) {
      if (ok && onDiscard) safeCall(onDiscard, rec.job, value);
      return;
    }
    rec.settled = true;
    if (current === rec) current = null;
    if (ok) {
      rec.job.state = "done";
      rec.job.result = value;
    } else {
      rec.job.state = "error";
      rec.job.error = errorMessage(value);
    }
    notify();
    schedulePump();
  }

  /** Cancel steps (1)-(3) of the contract for a running job. */
  function cancelRunning(rec) {
    rec.cancelled = true;
    rec.settled = true;
    rec.cancelRan = true;
    const fns = rec.cancelFns;
    rec.cancelFns = [];
    for (const fn of fns) safeCall(fn);
    rec.job.state = "cancelled";
    if (current === rec) current = null;
    notify();
  }

  return {
    /**
     * Appends a job. Returns a shallow copy of the job as it was at add time.
     * @param {unknown} file
     */
    add(file) {
      const job = { id: nextId++, file, state: "queued", error: null, result: null };
      records.push({ job, settled: false, cancelled: false, cancelRan: false, cancelFns: [] });
      notify();
      schedulePump();
      return { ...job };
    },

    /** Fresh array of the live job objects, in queue order. */
    get jobs() {
      return records.map((r) => r.job);
    },

    /**
     * @param {Function} fn called synchronously with a snapshot after every change
     * @returns {() => void} unsubscribe
     */
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },

    /** Cancels a queued or running job; no-op for finished or unknown ids. */
    cancel(id) {
      const rec = find(id);
      if (!rec || rec.cancelled || TERMINAL.has(rec.job.state)) return;
      if (current === rec) {
        cancelRunning(rec);
        schedulePump();
      } else if (rec.job.state === "queued") {
        rec.cancelled = true;
        rec.settled = true;
        rec.job.state = "cancelled";
        notify();
      }
    },

    /** Removes a job: running jobs are cancelled first; queued jobs are dropped silently. */
    remove(id) {
      const rec = find(id);
      if (!rec) return;
      if (current === rec) {
        cancelRunning(rec);
        if (onRemove) safeCall(onRemove, rec.job);
        drop(rec);
        notify();
        schedulePump();
        return;
      }
      if (rec.job.state === "queued") {
        drop(rec);
        notify();
        return;
      }
      if (onRemove) safeCall(onRemove, rec.job);
      drop(rec);
      notify();
    },

    /** Removes every done, error and cancelled job (onRemove once each). */
    clearFinished() {
      const victims = records.filter((r) => r !== current && TERMINAL.has(r.job.state));
      if (victims.length === 0) return;
      for (const rec of victims) {
        if (onRemove) safeCall(onRemove, rec.job);
        drop(rec);
      }
      notify();
    },
  };
}
