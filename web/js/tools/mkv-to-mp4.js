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
import { buildDiagnostics, logDiagnostics } from "../core/diagnostics.js";
import { describeError } from "../core/errors.js";
import { classifyFolderFailure, createOutputFile, mp4Name } from "../core/destination.js";
import { createMeter, formatBytes } from "../core/format.js";
import { createMemoryBudget } from "../core/memory-budget.js";
import { createConvertWorker } from "../core/worker-factory.js";
import { createQueue } from "../queue/queue.js";
import { createDestinationBar } from "../ui/destination-bar.js";
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
 * Removes a file the save dialog created if nothing was written to it (a failed or cancelled
 * save). A file that already had content is never touched. Best effort; never throws.
 * @param {any} handle FileSystemFileHandle
 */
async function removeIfEmpty(handle) {
  if (!handle || typeof handle.remove !== "function") return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if ((await handle.getFile()).size !== 0) return;
      await handle.remove();
      return;
    } catch {
      await delay(1500);
    }
  }
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
  // Chrome and Edge on desktop can let the user pick the file the result is written to.
  const canPickFile = typeof window.showSaveFilePicker === "function";

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
    const folderMode = destinationBar.state().mode === "folder";
    ctx.setStorageInfo({
      storage: folderMode
        ? "Written straight to the folder you chose"
        : storageOnDisk
          ? "On-disk (browser private storage)"
          : "In memory",
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
    if (job.runId !== undefined && !(job.result && (job.result.inMemory || job.result.saved))) {
      scheduleCleanup(job.runId);
    }
  }

  /** A late result of a cancelled run: drop it and its files (C4). */
  function discardResult(job, result) {
    revokeResult(result);
    budget.release(job.id);
    publishStorage();
    if (result && !result.inMemory && !result.saved) scheduleCleanup(job.runId);
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
      // The file this job writes to: one picked with "Save to a file", or one created in the
      // chosen folder when the job starts. Null means browser storage and a download.
      let outputHandle = job.outputHandle ?? null;
      let folderName = "";

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

      /**
       * @param {string} message @param {string} [details]
       * @param {object} [diagnostics] record from the worker; built here when the worker died
       */
      const fail = (message, details, diagnostics) => {
        if (finished) return;
        finished = true;
        stop();
        const diag =
          diagnostics && typeof diagnostics === "object"
            ? diagnostics
            : buildDiagnostics({
                env: { userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency ?? null },
                file,
                error: { name: "Error", message },
              });
        // The stable code comes from the same mapper the card uses, so both always agree.
        if (diag.error) diag.error.code = describeError(message).code;
        logDiagnostics("error", diag);
        void removeIfEmpty(outputHandle);
        jobCtx.update({ errorDetails: details ?? message, diagnostics: diag });
        reject(new Error(message));
      };

      /** @param {{file: Blob, outputName: string, inMemory: boolean}} msg */
      const succeed = (msg) => {
        if (finished) return;
        if (msg.saved === true) {
          // Written straight to the file the user chose: no blob, no memory, no private storage.
          finished = true;
          stop();
          logDiagnostics("info", msg.diagnostics);
          publishStorage();
          resolve({
            saved: true,
            savedName: typeof msg.savedName === "string" ? msg.savedName : msg.outputName,
            savedFolder: folderName,
            name: msg.outputName,
            size: Number.isFinite(msg.size) ? msg.size : 0,
            inMemory: false,
            runId,
          });
          return;
        }
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
        logDiagnostics("info", msg.diagnostics);
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
          case "scan-progress":
            if (typeof msg.fraction === "number") jobCtx.update({ scanProgress: msg.fraction });
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
            fail(String(msg.message || "Conversion failed."), msg.details, msg.diagnostics);
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
        if (!wasFinished) void removeIfEmpty(outputHandle);
        if (!wasFinished) reject(new Error("Cancelled"));
      });

      /** Creates this job's file in the chosen folder, unless a file was picked for it. */
      const prepareOutput = async () => {
        const folder = destinationBar.state();
        if (outputHandle || folder.mode !== "folder") return;
        const created = await createOutputFile(folder.dir, mp4Name(file.name));
        outputHandle = created.handle;
        folderName = folder.folderName;
      };

      prepareOutput()
        .then(
          () => createConvertWorker(hooks ?? {}),
          (err) => {
            const failure = classifyFolderFailure(err);
            fail(failure.message);
            return null;
          },
        )
        .then(
        (started) => {
          if (started === null) return;
          if (finished) {
            // Cancelled while the worker was still starting.
            started.terminate();
            void removeIfEmpty(outputHandle);
            return;
          }
          worker = started;
          if (!workerStarted) {
            workerStarted = true;
            publishStorage();
          }
          worker.onmessage = (event) => onMessage(event.data);
          worker.onerror = (event) => {
            const detail = event && event.message ? ` (${event.message})` : "";
            const diag = buildDiagnostics({
              env: { userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency ?? null },
              file,
              error: { name: "WorkerError", message: `${WORKER_STOPPED}${detail}` },
              extra: {
                workerEvent: event
                  ? { message: event.message ?? null, line: event.lineno ?? null, column: event.colno ?? null }
                  : null,
              },
            });
            fail(WORKER_STOPPED, `${WORKER_STOPPED}${detail}`, diag);
          };
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
            outputHandle,
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

  /**
   * Opens the browser's save dialog and, once a file is chosen, runs the failed job again with
   * its output written straight to that file. The dialog needs the click that called this, so it
   * is the first thing done here.
   * @param {string} id
   */
  function handleSaveToFile(id) {
    const job = queue.jobs.find((j) => j.id === Number(id));
    if (!job || job.state !== "error" || typeof window.showSaveFilePicker !== "function") return;
    window
      .showSaveFilePicker({
        suggestedName: mp4Name(job.file && job.file.name),
        types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
      })
      .then(
        (handle) => {
          if (!mounted) return;
          if (!queue.retry(job.id, { outputHandle: handle })) void removeIfEmpty(handle);
        },
        (err) => {
          // Closing the dialog is not an error.
          if (err && err.name === "AbortError") return;
          if (typeof ctx.showToast === "function") {
            ctx.showToast("Couldn\u2019t open the save dialog. Try again.", { kind: "error" });
          }
        },
      );
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
        const card = createJobCard(job, {
          onCancel: handleCancel,
          onRemove: handleRemove,
          onSaveToFile: canPickFile ? handleSaveToFile : undefined,
        });
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
  const destinationBar = createDestinationBar({
    storage: window.localStorage,
    onChange: (state) => {
      applyDestination(state);
      publishStorage();
      announce(
        state.mode === "folder"
          ? `Saving to the folder ${state.folderName}`
          : "Converted files will be offered as downloads",
      );
    },
    notify: (message) => {
      if (typeof ctx.showToast === "function") ctx.showToast(message, { kind: "error" });
    },
  });

  /** Files can only be added once the user has said where they go. @param {{mode: string}} state */
  function applyDestination(state) {
    dropzone.setDisabled(state.mode === "unset", "Choose where to save the converted files above first");
  }

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

  const root = h(
    "div",
    { class: "tool", dataset: { testid: "tool-mkv-to-mp4" } },
    head,
    callout,
    destinationBar.el,
    dropzone.el,
    list.el,
  );
  applyDestination(destinationBar.state());
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
