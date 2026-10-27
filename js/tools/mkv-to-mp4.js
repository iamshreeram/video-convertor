/**
 * MKV -> MP4 tool (DESIGN.md B3, B3.2-B3.6, B5). Owns the view, the dropzone,
 * the job queue and the worker runs. The page never parses or writes media
 * itself: each job runs in a confined worker started by worker-factory.js.
 *
 * ctx (from main.js): {session, caps, announce, showToast, setVersion,
 *   setStorageInfo, privacy}
 */

import { h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { createMeter, formatBytes } from "../core/format.js";
import { createMemoryBudget } from "../core/memory-budget.js";
import { createConvertWorker } from "../core/worker-factory.js";
import { createQueue } from "../queue/queue.js";
import { createDropzone } from "../ui/dropzone.js";
import { createJobList } from "../ui/job-list.js";
import { createJobCard } from "../ui/job-card.js";

const DEFAULT_BUDGET_BYTES = 1.5 * 2 ** 30;
const ACCEPT = ".mkv,.webm,video/x-matroska,video/webm";
const CLEANUP_TIMEOUT_MS = 20000;
const CLEANUP_RETRY_DELAY_MS = 2000;
const WORKER_STOPPED = "The conversion worker stopped unexpectedly.";
const FINISHED = new Set(["done", "error", "cancelled"]);
const BUSY = new Set(["analyzing", "converting"]);

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test hooks from the URL (used by the browser smoke tests only).
 * @param {URLSearchParams} params
 * @returns {{bootstrapSource?: string, readyTimeoutMs?: number}|null}
 */
function workerHooks(params) {
  const mode = params.get("testfail");
  if (mode === "bootstrap") {
    return { bootstrapSource: "throw new Error('test bootstrap failure');" };
  }
  if (mode === "timeout") {
    const ms = Number(params.get("readyms"));
    return { bootstrapSource: "/* never signals ready */", readyTimeoutMs: ms > 0 ? ms : 500 };
  }
  return null;
}

/**
 * @param {unknown} result
 * @returns {void}
 */
function revokeResult(result) {
  if (result && typeof result.url === "string" && result.url) {
    URL.revokeObjectURL(result.url);
  }
}

/**
 * @param {HTMLElement} container
 * @param {object} ctx
 * @returns {Promise<{unmount: () => void}>}
 */
export async function mount(container, ctx) {
  const { session, caps, announce } = ctx;
  const params = new URLSearchParams(window.location.search);
  const noFs = params.has("nofs");
  const hooks = workerHooks(params);
  const parsedBudget = Number(params.get("membudget"));
  const budgetTotal = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : DEFAULT_BUDGET_BYTES;
  const storageOnDisk = Boolean(caps.opfs) && !noFs;

  const budget = createMemoryBudget(budgetTotal);
  let workerStarted = false;
  let mounted = true;
  let runSeq = 0;
  let sweepPending = session.sweep === true;
  let lastRemovedFocus = null;
  /** @type {Set<number>} run ids whose exact-run cleanup has been scheduled */
  const scheduled = new Set();
  /** @type {Map<string, {el: HTMLElement, update: Function, destroy: Function}>} */
  const cards = new Map();
  /** @type {Map<string, string>} */
  const lastStates = new Map();

  /** Pushes storage, worker and memory facts to the About dialog. */
  function publishStorage() {
    if (typeof ctx.setStorageInfo !== "function") return;
    ctx.setStorageInfo({
      storage: storageOnDisk ? "On-disk (browser private storage)" : "In memory",
      workerConfinement: workerStarted ? "active" : "not started yet",
      memoryBudget: `${formatBytes(budget.remaining())} free of ${formatBytes(budgetTotal)}`,
    });
  }

  // ---- cleanup of exact runs (B3.3 PB-C4) --------------------------------
  /** @returns {Promise<Worker|null>} one retry after 2 s when the factory rejects */
  async function openCleanupWorker() {
    try {
      return await createConvertWorker();
    } catch {
      await delay(CLEANUP_RETRY_DELAY_MS);
    }
    try {
      return await createConvertWorker();
    } catch {
      return null;
    }
  }

  /** @param {number} runId */
  async function cleanupRun(runId) {
    const worker = await openCleanupWorker();
    if (!worker) return;
    await new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        worker.terminate();
        resolve();
      };
      timer = setTimeout(finish, CLEANUP_TIMEOUT_MS);
      worker.onmessage = (event) => {
        if (event.data && event.data.type === "cleaned") finish();
      };
      worker.onerror = finish;
      worker.onmessageerror = finish;
      worker.postMessage({ type: "cleanup", sessionId: session.sessionId, runIds: [runId] });
    });
  }

  /**
   * Idempotent per run id; never surfaces failures.
   * @param {number|undefined|null} runId
   */
  function scheduleCleanup(runId) {
    if (runId === undefined || runId === null || scheduled.has(runId)) return;
    scheduled.add(runId);
    cleanupRun(runId).catch(() => {});
  }

  // ---- queue hooks --------------------------------------------------------
  /** @param {object} job the job as it was when it was removed */
  function releaseJob(job) {
    revokeResult(job.result);
    budget.release(job.id);
    publishStorage();
    if (job.runId !== undefined && !(job.result && job.result.inMemory)) {
      scheduleCleanup(job.runId);
    }
  }

  /** A late result of a cancelled run: drop it and its files (C4). */
  function discardResult(job, result) {
    revokeResult(result);
    budget.release(job.id);
    publishStorage();
    if (result && !result.inMemory) scheduleCleanup(job.runId);
  }

  /**
   * Runs one file in a confined worker. Settles once; a cancelled run never
   * settles through the queue (the queue ignores it).
   * @param {object} job
   * @param {{update: Function, setState: Function, onCancel: Function}} jobCtx
   * @returns {Promise<object>}
   */
  function runJob(job, jobCtx) {
    const runId = ++runSeq;
    jobCtx.update({ runId });
    const startedAt = Date.now();
    const file = job.file;

    return new Promise((resolve, reject) => {
      let worker = null;
      let finished = false;
      let meter = null;

      /** Detaches handlers and terminates the worker, if any. */
      const stop = () => {
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
          worker = null;
        }
      };

      /** @param {string} message @param {string} [details] */
      const fail = (message, details) => {
        if (finished) return;
        finished = true;
        stop();
        jobCtx.update({ errorDetails: details ?? message });
        reject(new Error(message));
      };

      /** @param {{file: Blob, outputName: string, inMemory: boolean}} msg */
      const succeed = (msg) => {
        if (finished) return;
        const out = msg.file;
        if (!(out instanceof Blob)) {
          fail("The converter returned no file.");
          return;
        }
        const inMemory = msg.inMemory === true;
        if (inMemory && !budget.reserve(job.id, out.size)) {
          fail(
            `memory budget exceeded: output is ${out.size} bytes, ${budget.remaining()} bytes of memory budget remain`,
          );
          return;
        }
        finished = true;
        stop();
        publishStorage();
        resolve({
          url: URL.createObjectURL(out),
          name: msg.outputName,
          size: out.size,
          inMemory,
          runId,
        });
      };

      /** @param {object} msg */
      const onMessage = (msg) => {
        if (finished || !msg || typeof msg !== "object") return;
        switch (msg.type) {
          case "info":
            if (typeof ctx.setVersion === "function") ctx.setVersion(msg.version);
            break;
          case "stage":
            jobCtx.update({ stage: msg.stage });
            if (msg.stage === "converting" || msg.stage === "finalizing") jobCtx.setState("converting");
            break;
          case "analysis":
            jobCtx.update({ analysis: msg.report });
            break;
          case "progress": {
            if (!meter) meter = createMeter(file.size);
            const sample = meter.sample(msg.fraction, performance.now());
            jobCtx.update({
              progress: msg.fraction,
              speed: sample.bytesPerSec,
              eta: sample.etaSeconds,
              elapsedMs: Date.now() - startedAt,
            });
            break;
          }
          case "done":
            succeed(msg);
            break;
          case "error":
            fail(String(msg.message || "Conversion failed."), msg.details);
            break;
          default:
            break;
        }
      };

      jobCtx.onCancel(() => {
        const wasFinished = finished;
        finished = true;
        stop();
        scheduleCleanup(runId);
        if (!wasFinished) reject(new Error("Cancelled"));
      });

      createConvertWorker(hooks ?? {}).then(
        (started) => {
          if (finished) {
            // Cancelled while the worker was still starting.
            started.terminate();
            return;
          }
          worker = started;
          if (!workerStarted) {
            workerStarted = true;
            publishStorage();
          }
          worker.onmessage = (event) => onMessage(event.data);
          worker.onerror = () => fail(WORKER_STOPPED);
          worker.onmessageerror = () => fail(WORKER_STOPPED);
          const sweep = sweepPending;
          sweepPending = false;
          worker.postMessage({
            type: "process",
            file,
            sessionId: session.sessionId,
            sweep,
            runId,
            inMemory: noFs || !caps.opfs,
            memoryBudgetBytes: budget.remaining(),
          });
        },
        (err) => fail(err?.message || "Could not start the conversion worker."),
      );
    });
  }

  const queue = createQueue({ run: runJob, onRemove: releaseJob, onDiscard: discardResult });

  // ---- UI handlers --------------------------------------------------------
  /** @param {string} id */
  function handleCancel(id) {
    queue.cancel(Number(id));
  }

  /** Removes a card and moves focus to the next card, else to the dropzone. @param {string} id */
  function handleRemove(id) {
    lastRemovedFocus = null;
    queue.remove(Number(id));
    const target = lastRemovedFocus;
    lastRemovedFocus = null;
    if (target && target.isConnected) {
      target.focus();
    } else {
      dropzone.focus();
    }
  }

  /** @param {object} job */
  function announceChange(job) {
    const id = String(job.id);
    const previous = lastStates.get(id);
    lastStates.set(id, job.state);
    if (previous === undefined || previous === job.state) return;
    const name = job.file && job.file.name ? job.file.name : "file";
    if (job.state === "done") announce(`Converted ${name}`);
    else if (job.state === "error") announce(`Conversion of ${name} failed`);
    else if (job.state === "cancelled") announce(`Cancelled ${name}`);
  }

  /** Diffs the queue snapshot against the cards on screen. @param {object[]} snapshot */
  function render(snapshot) {
    if (!mounted) return;
    const seen = new Set();
    for (const job of snapshot) {
      const id = String(job.id);
      seen.add(id);
      if (cards.has(id)) {
        cards.get(id).update(job);
      } else {
        const card = createJobCard(job, { onCancel: handleCancel, onRemove: handleRemove });
        cards.set(id, card);
        list.addCard(card.el, id);
      }
      announceChange(job);
    }
    for (const id of Array.from(cards.keys())) {
      if (seen.has(id)) continue;
      const removal = list.removeCard(id);
      lastRemovedFocus = removal.nextFocusEl;
      cards.get(id).destroy();
      cards.delete(id);
      lastStates.delete(id);
    }
    list.setHasFinished(snapshot.some((job) => FINISHED.has(job.state)));
  }

  // ---- view -----------------------------------------------------------------
  const dropzone = createDropzone({
    accept: ACCEPT,
    multiple: true,
    onFiles: (files) => {
      for (const file of files) queue.add(file);
      announce(`Added ${files.length} file${files.length === 1 ? "" : "s"}`);
    },
  });

  const list = createJobList({
    onClearFinished: () => {
      queue.clearFinished();
      const active = document.activeElement;
      if (!active || active === document.body) dropzone.focus();
    },
  });

  const privacyButton = h(
    "button",
    {
      class: "btn btn--ghost btn--sm",
      dataset: { testid: "privacy-how" },
      attrs: { type: "button", "aria-haspopup": "dialog" },
      on: {
        click: () => {
          if (ctx.privacy && typeof ctx.privacy.open === "function") ctx.privacy.open(privacyButton);
        },
      },
    },
    "How it works",
  );

  const callout = h(
    "section",
    { class: "callout", dataset: { testid: "privacy-callout" }, attrs: { "aria-label": "Privacy" } },
    icon("shield", { size: 18 }),
    h("p", { class: "callout__text" }, "Processed locally. Your files never leave this device."),
    privacyButton,
  );

  const head = h(
    "header",
    { class: "page-head" },
    h("h1", { class: "page-title" }, "MKV to MP4"),
    h(
      "p",
      { class: "page-desc" },
      "Remux MKV and WebM files into MP4 without re-encoding. Fast, lossless, and entirely on your device.",
    ),
  );

  const root = h("div", { class: "tool", dataset: { testid: "tool-mkv-to-mp4" } }, head, callout, dropzone.el, list.el);
  container.replaceChildren(root);

  const unsubscribe = queue.subscribe(render);

  const onBeforeUnload = (event) => {
    if (!queue.jobs.some((job) => BUSY.has(job.state))) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  publishStorage();

  return {
    unmount() {
      if (!mounted) return;
      mounted = false;
      window.removeEventListener("beforeunload", onBeforeUnload);
      unsubscribe();
      // Cancels running jobs (their workers are terminated and cleanup is
      // scheduled), then releases every result URL and budget hold.
      for (const job of queue.jobs) queue.remove(job.id);
      for (const card of cards.values()) card.destroy();
      cards.clear();
      root.remove();
    },
  };
}
