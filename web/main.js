// MKV to MP4 converter: page controller (main thread).
// All asset URLs are relative, so the page works from any base path.
// Data-state values exposed for tests: init | ready | converting | done | error.

const WINDOW_NOTE_BYTES = 2 * 2 ** 30;
const CLEANUP_TIMEOUT_MS = 20000;
const IDLE_STATES = new Set(["ready", "error"]);

function byId(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`mkv2mp4: missing element #${id}`);
  }
  return node;
}

const el = {
  unsupported: byId("unsupported"),
  dropZone: byId("drop-zone"),
  fileInput: byId("file-input"),
  fileInfo: byId("file-info"),
  sizeNote: byId("size-note"),
  progressRow: byId("progress-row"),
  progress: byId("progress"),
  percent: byId("percent"),
  cancel: byId("cancel"),
  error: byId("error"),
  log: byId("log"),
  result: byId("result"),
  preview: byId("preview"),
  download: byId("download"),
  summary: byId("summary"),
  again: byId("again"),
};

const session = {
  id: "",
  sweep: false,
  runId: 0,
  worker: null,
  objectUrl: "",
  busy: false,
};

let usable = false;

function supportedBrowser() {
  return (
    typeof Worker === "function" &&
    typeof WebAssembly === "object" &&
    typeof File === "function" &&
    typeof Blob === "function" &&
    typeof URL === "function" &&
    typeof URL.createObjectURL === "function"
  );
}

function makeSessionId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Holds the session lock for the lifetime of the tab. Resolves true when the
// lock is held (orphan sweeping allowed), false when the Locks API is missing
// or the request fails (conversion still works, without sweeping).
async function acquireSession(id) {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== "function") {
    return false;
  }
  try {
    await new Promise((ready, fail) => {
      locks
        .request(`mkv2mp4:${id}`, () => {
          ready();
          return new Promise(() => {});
        })
        .catch(fail);
    });
    return true;
  } catch {
    return false;
  }
}

function isIdleState() {
  return IDLE_STATES.has(document.documentElement.dataset.state);
}

function canStart() {
  return usable && isIdleState() && !session.worker && !session.busy;
}

function setState(next) {
  document.documentElement.dataset.state = next;
  const enabled = usable && IDLE_STATES.has(next);
  const converting = next === "converting";

  el.fileInput.disabled = !enabled;
  el.dropZone.classList.toggle("disabled", !enabled);
  el.dropZone.setAttribute("aria-disabled", String(!enabled));

  el.progressRow.hidden = !converting;
  el.cancel.disabled = !converting || session.busy;
  el.result.hidden = next !== "done";
  el.again.disabled = next !== "done" || session.busy;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) {
    return "unknown size";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index === 0 ? `${value} B` : `${value.toFixed(1)} ${units[index]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const totalSeconds = ms / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  }
  return `${minutes}:${seconds}`;
}

function logLine(text) {
  const item = document.createElement("li");
  item.textContent = text;
  el.log.append(item);
}

function clearLog() {
  el.log.replaceChildren();
}

function clearError() {
  delete el.error.dataset.error;
  el.error.textContent = "";
}

function setError(message) {
  el.error.dataset.error = message;
  el.error.textContent = message;
  setState("error");
}

function setProgress(fraction) {
  const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  el.progress.value = value;
  el.percent.textContent = `${Math.round(value * 100)}%`;
}

function showFileInfo(file) {
  el.fileInfo.textContent = `${file.name || "file"} (${formatBytes(file.size)})`;
}

function revokeObjectUrl() {
  if (session.objectUrl) {
    URL.revokeObjectURL(session.objectUrl);
    session.objectUrl = "";
  }
}

function releaseResult() {
  el.preview.removeAttribute("src");
  el.preview.load();
  el.download.removeAttribute("href");
  el.summary.replaceChildren();
  revokeObjectUrl();
}

function renderSummary(summary) {
  const s = summary && typeof summary === "object" ? summary : {};
  const audio = Array.isArray(s.audioCodecs) && s.audioCodecs.length > 0 ? s.audioCodecs.join(", ") : "none";
  const rows = [
    ["Video codec", s.videoCodec || "none"],
    ["Audio codecs", audio],
    ["Duration", formatDuration(s.durationMs)],
    ["Output size", formatBytes(s.outputSize)],
  ];
  const items = rows.map(([label, value]) => {
    const item = document.createElement("li");
    item.textContent = `${label}: ${value}`;
    return item;
  });
  el.summary.replaceChildren(...items);
  if (Array.isArray(s.warnings)) {
    for (const warning of s.warnings) {
      logLine(String(warning));
    }
  }
}

function safeOutputName(name) {
  return typeof name === "string" && name.length > 0 ? name : "converted.mp4";
}

function retireWorker() {
  const worker = session.worker;
  session.worker = null;
  if (worker) {
    worker.terminate();
  }
}

function showResult(data) {
  const file = data.file;
  if (!(file instanceof Blob)) {
    setError("Conversion finished but produced no file.");
    return;
  }
  revokeObjectUrl();
  session.objectUrl = URL.createObjectURL(file);
  el.preview.src = session.objectUrl;
  el.download.href = session.objectUrl;
  el.download.download = safeOutputName(data.outputName);
  renderSummary(data.summary);
  setProgress(1);
  setState("done");
  el.result.focus();
  logLine("Conversion finished. Nothing was uploaded.");
}

function onWorkerMessage(worker, data) {
  if (worker !== session.worker || !data || typeof data !== "object") {
    return;
  }
  switch (data.type) {
    case "progress":
      setProgress(data.fraction);
      break;
    case "done":
      retireWorker();
      showResult(data);
      break;
    case "error":
      retireWorker();
      setError(typeof data.message === "string" && data.message ? data.message : "Conversion failed.");
      break;
    default:
      break;
  }
}

// Crash path: the worker could not report its own failure, so ask a fresh
// cleanup worker to remove this session's outputs in the background.
function failWorker(worker, message) {
  if (worker !== session.worker) {
    return;
  }
  retireWorker();
  void cleanupSession(session.runId);
  setError(message);
}

// Asks a cleanup worker to delete this session's outputs with runId <= maxRun.
// Runs in the background: resolves true when the worker reports "cleaned".
function cleanupSession(maxRun) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    } catch {
      resolve(false);
      return;
    }
    const finish = (ok) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), CLEANUP_TIMEOUT_MS);
    worker.onmessage = (event) => {
      if (event.data && event.data.type === "cleaned") {
        finish(true);
      }
    };
    worker.onerror = () => finish(false);
    worker.onmessageerror = () => finish(false);
    worker.postMessage({ type: "cleanup", sessionId: session.id, maxRun });
  });
}

async function startConversion(file) {
  if (!canStart()) {
    return;
  }
  session.runId += 1;
  clearError();
  clearLog();
  showFileInfo(file);
  el.sizeNote.hidden = !(file.size > WINDOW_NOTE_BYTES);
  setProgress(0);

  let worker;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch {
    setError("Could not start the converter in this browser.");
    return;
  }
  session.worker = worker;
  setState("converting");
  logLine("Converting locally. Nothing is uploaded.");

  worker.onmessage = (event) => onWorkerMessage(worker, event.data);
  worker.onerror = () => failWorker(worker, "The converter stopped unexpectedly.");
  worker.onmessageerror = () => failWorker(worker, "The converter sent an unreadable message.");
  worker.postMessage({
    type: "convert",
    file,
    sessionId: session.id,
    sweep: session.sweep,
    runId: session.runId,
    inMemory: new URLSearchParams(location.search).has("nofs"),
  });
}

async function cancelConversion() {
  if (!session.worker || session.busy) {
    return;
  }
  const cancelledRun = session.runId;
  el.cancel.disabled = true;
  retireWorker();
  logLine("Cancelling...");
  // Not awaited: the cancelled run's file may stay locked for a moment after
  // its worker is terminated, so cleanup retries in the background while the
  // UI is already back to idle. Only runs <= cancelledRun are targeted.
  void cleanupSession(cancelledRun);
  el.fileInfo.textContent = "";
  el.sizeNote.hidden = true;
  setProgress(0);
  setState("ready");
  clearLog();
  logLine("Conversion cancelled.");
}

async function convertAnother() {
  if (session.busy || session.worker) {
    return;
  }
  session.busy = true;
  el.again.disabled = true;
  await cleanupSession(session.runId);
  releaseResult();
  session.busy = false;
  el.fileInfo.textContent = "";
  el.sizeNote.hidden = true;
  clearError();
  clearLog();
  setProgress(0);
  setState("ready");
  el.fileInput.focus();
}

function firstFileFrom(dataTransfer) {
  if (!dataTransfer) {
    return null;
  }
  if (dataTransfer.items) {
    for (const item of dataTransfer.items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          return file;
        }
      }
    }
    return null;
  }
  return dataTransfer.files && dataTransfer.files.length > 0 ? dataTransfer.files[0] : null;
}

function wireDropZone() {
  const zone = el.dropZone;
  const highlight = (on) => zone.classList.toggle("dragover", on);

  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    if (canStart()) {
      highlight(true);
    }
  });
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = canStart() ? "copy" : "none";
    }
  });
  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) {
      highlight(false);
    }
  });
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    highlight(false);
    if (!canStart()) {
      return;
    }
    const file = firstFileFrom(event.dataTransfer);
    if (file) {
      void startConversion(file);
    }
  });

  // Stop the browser from opening a file dropped outside the zone.
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => event.preventDefault());
  }
}

function wireControls() {
  wireDropZone();

  el.fileInput.addEventListener("change", () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = "";
    if (file) {
      void startConversion(file);
    }
  });
  el.cancel.addEventListener("click", () => {
    void cancelConversion();
  });
  el.again.addEventListener("click", () => {
    void convertAnother();
  });
  window.addEventListener("pagehide", revokeObjectUrl);
}

async function init() {
  if (!supportedBrowser()) {
    el.unsupported.hidden = false;
    setState("error");
    return;
  }

  session.id = makeSessionId();
  session.sweep = await acquireSession(session.id);

  wireControls();
  usable = true;
  setState("ready");
}

init().catch(() => {
  el.unsupported.hidden = false;
  setState("error");
});
