// Module worker: probes and converts one MKV/WebM file with the Rust/WASM core.
// It posts {type:"ready"} first so the page can confirm the secure start-up
// (DESIGN.md B3.6) before any message is sent to it.
//
// In:  {type:"process", file, sessionId, sweep, runId, inMemory, memoryBudgetBytes}
//      {type:"cleanup", sessionId, runIds:[number]}
// Out: stage | analysis | progress | info | done | error | cleaned
import init, { convert_mkv_to_mp4, probe_mkv, version } from "../pkg/mkv2mp4.js";

postMessage({ type: "ready" });

const PROGRESS_INTERVAL_MS = 100;
const OUTPUT_NAME_PATTERN = /^out-(.+)-(\d+)\.mp4$/;
const CLEANUP_RETRY_MS = 150;
const CLEANUP_DEADLINE_MS = 15000;

let wasmReady = null;
let infoSent = false;

/** Initialises wasm once and reports its version once. */
function ensureWasm() {
  if (!wasmReady) {
    wasmReady = init().then(() => {
      if (!infoSent) {
        infoSent = true;
        postMessage({ type: "info", version: version() });
      }
    });
  }
  return wasmReady;
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") {
    return;
  }
  if (msg.type === "process") {
    void runProcess(msg);
  } else if (msg.type === "cleanup") {
    void runCleanup(msg);
  }
};

/** @param {unknown} err @returns {string} the raw message thrown by wasm or JS */
function errorText(err) {
  return String(err?.message ?? err);
}

async function runProcess(msg) {
  const state = { opfs: null };
  try {
    const file = msg.file;
    if (!(file instanceof Blob)) {
      throw new Error("No file was provided.");
    }
    await ensureWasm();

    postMessage({ type: "stage", stage: "analyzing" });
    const read = makeReader(file);
    const report = JSON.parse(probe_mkv(file.size, read));
    postMessage({ type: "analysis", report });

    const outputName = makeOutputName(file.name);
    const budget = normaliseBudget(msg.memoryBudgetBytes);

    // OPFS unless the page asked for memory or the file cannot be created.
    if (!msg.inMemory) {
      const root = await getOpfsRoot();
      if (root) {
        if (msg.sweep === true) {
          await sweepOrphans(root);
        }
        state.opfs = await createOpfsOutput(root, `out-${msg.sessionId}-${msg.runId}.mp4`);
      }
    }

    // Nothing has been written yet: refuse an oversized in-memory output now.
    if (!state.opfs && report.outputSize > budget) {
      throw new Error(
        `memory budget exceeded: output is ${report.outputSize} bytes, ${budget} bytes of memory budget remain`,
      );
    }

    postMessage({ type: "stage", stage: "converting" });
    const onProgress = makeProgressReporter();
    let result;
    let summaryText;
    if (state.opfs) {
      const opfs = state.opfs;
      let position = 0;
      const writeChunk = (chunk) => {
        const written = opfs.access.write(chunk, { at: position });
        if (written !== chunk.byteLength) {
          throw new Error("disk write failed (storage full?)");
        }
        position += written;
      };
      summaryText = convert_mkv_to_mp4(file.size, 0, read, writeChunk, onProgress);
      postMessage({ type: "progress", fraction: 1 });
      postMessage({ type: "stage", stage: "finalizing" });
      opfs.access.flush();
      opfs.access.close();
      opfs.access = null;
      result = await opfs.handle.getFile();
    } else {
      const chunks = [];
      summaryText = convert_mkv_to_mp4(
        file.size,
        budget,
        read,
        (chunk) => {
          chunks.push(chunk);
        },
        onProgress,
      );
      postMessage({ type: "progress", fraction: 1 });
      postMessage({ type: "stage", stage: "finalizing" });
      result = new Blob(chunks, { type: "video/mp4" });
    }

    const summary = JSON.parse(summaryText);
    postMessage({ type: "done", file: result, summary, outputName, inMemory: !state.opfs });
    self.close();
  } catch (err) {
    await discardOutput(state.opfs);
    const message = errorText(err);
    postMessage({ type: "error", message, details: message });
    self.close();
  }
}

/** @param {unknown} value @returns {number} a non-negative byte budget (0 when unusable) */
function normaliseBudget(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// Deletes exactly this session's outputs whose run id is listed. A file may
// still be locked by a worker that was just terminated (its handle is released
// asynchronously), so busy removals are retried until the deadline.
async function runCleanup(msg) {
  const removed = [];
  const failed = [];
  try {
    const root = await getOpfsRoot();
    if (root && typeof msg.sessionId === "string") {
      const wanted = new Set((Array.isArray(msg.runIds) ? msg.runIds : []).map(Number));
      const targets = [];
      for (const name of await listOutputNames(root)) {
        const parsed = parseOutputName(name);
        if (parsed && parsed.sessionId === msg.sessionId && wanted.has(Number(parsed.runId))) {
          targets.push(name);
        }
      }
      await removeWithRetry(root, targets, removed, failed);
    }
  } catch {
    // Cleanup is best effort and must never fail a conversion.
  }
  postMessage({ type: "cleaned", removed, failed });
  self.close();
}

async function removeWithRetry(root, names, removed, failed) {
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  let pending = names;
  while (pending.length > 0) {
    const stillPending = [];
    for (const name of pending) {
      const outcome = await tryRemove(root, name);
      if (outcome === "removed") {
        removed.push(name);
      } else if (outcome === "busy") {
        stillPending.push(name);
      }
    }
    pending = stillPending;
    if (pending.length === 0 || Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_MS));
  }
  failed.push(...pending);
}

// Returns "removed", "missing" (already gone) or "busy" (retry later).
async function tryRemove(root, name) {
  try {
    await root.removeEntry(name);
    return "removed";
  } catch (err) {
    return err && err.name === "NotFoundError" ? "missing" : "busy";
  }
}

function makeOutputName(name) {
  const raw = typeof name === "string" ? name : "";
  const base = raw.replace(/[\\/]/g, "_").replace(/\.[^.]*$/, "");
  return `${base || "output"}.mp4`;
}

function makeReader(file) {
  const fileReader = new FileReaderSync();
  return (offset, length) => {
    const buffer = fileReader.readAsArrayBuffer(file.slice(offset, offset + length));
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== length) {
      throw new Error("short read");
    }
    return bytes;
  };
}

function makeProgressReporter() {
  let last = 0;
  return (fraction) => {
    if (!Number.isFinite(fraction)) {
      return;
    }
    const now = Date.now();
    if (fraction >= 1 || now - last >= PROGRESS_INTERVAL_MS) {
      last = now;
      postMessage({ type: "progress", fraction });
    }
  };
}

async function getOpfsRoot() {
  try {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== "function") {
      return null;
    }
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

// Returns {root, name, handle, access} or null (caller falls back to memory).
async function createOpfsOutput(root, name) {
  let handle = null;
  try {
    handle = await root.getFileHandle(name, { create: true });
    const access = await handle.createSyncAccessHandle();
    access.truncate(0);
    return { root, name, handle, access };
  } catch {
    if (handle) {
      await removeQuietly(root, name);
    }
    return null;
  }
}

async function discardOutput(opfs) {
  if (!opfs) {
    return;
  }
  try {
    if (opfs.access) {
      opfs.access.close();
    }
  } catch {
    // Handle may already be closed.
  }
  opfs.access = null;
  await removeQuietly(opfs.root, opfs.name);
}

async function listOutputNames(root) {
  const names = [];
  for await (const [name] of root.entries()) {
    if (OUTPUT_NAME_PATTERN.test(name)) {
      names.push(name);
    }
  }
  return names;
}

function parseOutputName(name) {
  const match = OUTPUT_NAME_PATTERN.exec(name);
  return match ? { sessionId: match[1], runId: match[2] } : null;
}

// Deletes only outputs whose session lock is not currently held (orphans).
async function sweepOrphans(root) {
  try {
    if (!navigator.locks || typeof navigator.locks.query !== "function") {
      return;
    }
    const snapshot = await navigator.locks.query();
    const held = new Set((snapshot.held || []).map((lock) => lock.name));
    for (const name of await listOutputNames(root)) {
      const sessionId = parseOutputName(name)?.sessionId;
      if (sessionId && !held.has(`mkv2mp4:${sessionId}`)) {
        await removeQuietly(root, name);
      }
    }
  } catch {
    // Sweeping is best effort.
  }
}

async function removeQuietly(root, name) {
  try {
    await root.removeEntry(name);
  } catch {
    // Missing or still-open files are ignored.
  }
}
