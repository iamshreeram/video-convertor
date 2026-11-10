// Module worker: probes and converts one MKV/WebM file with the Rust/WASM core.
// It posts {type:"ready"} first so the page can confirm the secure start-up
// (DESIGN.md B3.6) before any message is sent to it.
//
// In:  {type:"process", file, sessionId, sweep, runId, inMemory, memoryBudgetBytes, outputHandle?}
//      `outputHandle` is a FileSystemFileHandle the user picked: the MP4 is then written straight
//      to that file (no browser-private storage, no memory) and `done` carries `saved: true`.
//      {type:"cleanup", sessionId, runIds:[number]}
// Out: stage | analysis | scan-progress | progress | info | done | error | cleaned
//      `done` and `error` carry `diagnostics` (timings, I/O, storage; never the file name).
import init, { Scan, version } from "../pkg/mkv2mp4.js";
import {
  MAX_BUFFER_BYTES,
  buildReplacement,
  canReencodeVorbis,
  transcodeVorbis,
} from "../js/core/audio-transcode.js";
import {
  Recorder,
  assessStorage,
  buildDiagnostics,
  classifySaveFailure,
  classifyWriteFailure,
  storageFullMessage,
} from "../js/core/diagnostics.js";

postMessage({ type: "ready" });

const PROGRESS_INTERVAL_MS = 100;
const OUTPUT_NAME_PATTERN = /^out-(.+)-(\d+)\.mp4$/;
const CLEANUP_RETRY_MS = 150;
const CLEANUP_DEADLINE_MS = 15000;

// When the browser's storage is too small but the result is at most this big, keep it in memory.
const MEMORY_FALLBACK_MAX_BYTES = 512 * 1024 * 1024;

let wasmReady = null;
let infoSent = false;
let wasmVersion = null;

/** Initialises wasm once and reports its version once. */
function ensureWasm() {
  if (!wasmReady) {
    wasmReady = init().then(() => {
      if (!infoSent) {
        infoSent = true;
        wasmVersion = version();
        postMessage({ type: "info", version: wasmVersion });
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
  const state = {
    opfs: null,
    writable: null,
    report: null,
    storage: null,
    failure: null,
    readFailure: null,
  };
  const rec = new Recorder();
  const file = msg.file;
  try {
    if (!(file instanceof Blob)) {
      throw new Error("No file was provided.");
    }
    rec.begin("wasm-init");
    await ensureWasm();

    // One scan of the whole file serves the analysis, the audio export and the conversion.
    rec.begin("scan");
    postMessage({ type: "stage", stage: "analyzing" });
    const read = makeReader(file, rec, state);
    const scan = new Scan(file.size, read, makeScanReporter());
    let report = JSON.parse(scan.probe(read, null));
    state.report = report;
    postMessage({ type: "analysis", report });

    // MP4 cannot hold Vorbis: decode it and re-encode to AAC/Opus with WebCodecs when possible.
    let replacement = null;
    let audioNote = null;
    const reencodable = Array.isArray(report.reencodable) ? report.reencodable : [];
    if (reencodable.length > 0) {
      rec.begin("reencode-audio");
      const outcome = await reencodeAudio(scan, read, reencodable[0]);
      audioNote = outcome.note;
      if (outcome.replacement) {
        replacement = outcome.replacement;
        report = outcome.report;
        state.report = report;
      }
      report.warnings = [...(report.warnings ?? []), audioNote];
      postMessage({ type: "analysis", report });
    }

    rec.begin("prepare-output");
    const outputName = makeOutputName(file.name);

    // The user chose a file: write straight to it and stop here.
    if (msg.outputHandle !== undefined && msg.outputHandle !== null) {
      await saveToChosenFile({ msg, scan, read, replacement, report, rec, state, file, outputName, audioNote });
      return;
    }

    const budget = normaliseBudget(msg.memoryBudgetBytes);
    state.storage = { mode: "memory", needed: report.outputSize };

    // OPFS unless the page asked for memory, the file cannot be created or it would not fit.
    if (!msg.inMemory) {
      const root = await getOpfsRoot();
      if (root) {
        if (msg.sweep === true) {
          await sweepOrphans(root);
        }
        const assessed = assessStorage(await readStorageEstimate(), report.outputSize);
        state.storage = { ...assessed, mode: "opfs" };
        if (assessed.enough) {
          state.opfs = await createOpfsOutput(root, `out-${msg.sessionId}-${msg.runId}.mp4`);
          if (!state.opfs) {
            state.storage.mode = "memory (output file could not be created)";
          }
        } else if (report.outputSize <= Math.min(budget, MEMORY_FALLBACK_MAX_BYTES)) {
          state.storage.mode = "memory (browser storage too small)";
        } else {
          // Fail now rather than after minutes of copying.
          throw new Error(storageFullMessage(assessed));
        }
      }
    }

    // Nothing has been written yet: refuse an oversized in-memory output now.
    if (!state.opfs && report.outputSize > budget) {
      throw new Error(
        `memory budget exceeded: output is ${report.outputSize} bytes, ${budget} bytes of memory budget remain`,
      );
    }

    rec.begin("convert");
    postMessage({ type: "stage", stage: "converting" });
    const onProgress = makeProgressReporter();
    let result;
    let summaryText;
    if (state.opfs) {
      const opfs = state.opfs;
      const total = report.outputSize;
      let position = 0;
      const writeChunk = (chunk) => {
        const started = performance.now();
        let written = -1;
        let thrown = null;
        try {
          written = opfs.access.write(chunk, { at: position });
        } catch (e) {
          thrown = e;
        }
        rec.write(chunk.byteLength, performance.now() - started);
        if (thrown || written !== chunk.byteLength) {
          const failure = classifyWriteFailure({
            name: thrown?.name,
            message: thrown?.message,
            written: thrown ? undefined : written,
            expected: chunk.byteLength,
            position,
            total,
          });
          state.failure = {
            ...failure,
            position,
            total,
            chunkBytes: chunk.byteLength,
            written: thrown ? null : written,
            errorName: thrown?.name ?? null,
          };
          throw new Error(failure.message);
        }
        position += written;
      };
      summaryText = scan.convert(0, read, writeChunk, onProgress, replacement);
      postMessage({ type: "progress", fraction: 1 });
      rec.begin("finalize");
      postMessage({ type: "stage", stage: "finalizing" });
      opfs.access.flush();
      opfs.access.close();
      opfs.access = null;
      result = await opfs.handle.getFile();
    } else {
      const chunks = [];
      summaryText = scan.convert(
        budget,
        read,
        (chunk) => {
          const started = performance.now();
          chunks.push(chunk);
          rec.write(chunk.byteLength, performance.now() - started);
        },
        onProgress,
        replacement,
      );
      postMessage({ type: "progress", fraction: 1 });
      rec.begin("finalize");
      postMessage({ type: "stage", stage: "finalizing" });
      result = new Blob(chunks, { type: "video/mp4" });
    }
    rec.end();

    const summary = JSON.parse(summaryText);
    if (audioNote) {
      summary.warnings = [...(summary.warnings ?? []), audioNote];
    }
    const diagnostics = buildDiagnostics({
      version: wasmVersion,
      env: collectEnv(),
      file,
      recorder: rec,
      storage: state.storage,
      report: state.report,
    });
    postMessage({
      type: "done",
      file: result,
      summary,
      outputName,
      inMemory: !state.opfs,
      diagnostics,
    });
    self.close();
  } catch (err) {
    await discardOutput(state.opfs);
    await abortQuietly(state.writable);
    state.writable = null;
    // A failed write is reported with its own numbers instead of the engine's wrapper text.
    const message = state.failure ? state.failure.message : errorText(err);
    if (state.storage && state.failure) {
      const estimate = await readStorageEstimate();
      state.storage = {
        ...state.storage,
        atFailure: estimate ? { quota: estimate.quota ?? null, usage: estimate.usage ?? null } : null,
      };
    }
    const diagnostics = buildDiagnostics({
      version: wasmVersion,
      env: collectEnv(),
      file: file instanceof Blob ? file : null,
      recorder: rec,
      storage: state.storage,
      report: state.report,
      error: { name: err?.name, message, stack: err?.stack },
      extra: { failedStage: rec.stageName, write: state.failure, read: state.readFailure },
    });
    postMessage({ type: "error", message, details: message, diagnostics });
    self.close();
  }
}

/**
 * Converts straight into a file the user picked. The engine hands the MP4 out block by block
 * (`stream_begin` / `stream_next`) because a writable file stream has to be awaited, which the
 * engine's synchronous write callback cannot do. Nothing is kept in memory or in the browser's
 * private storage; the file is only replaced when `close()` succeeds.
 */
async function saveToChosenFile(ctx) {
  const { msg, scan, read, replacement, report, rec, state, file, outputName, audioNote } = ctx;
  const handle = msg.outputHandle;
  const total = report.outputSize;
  let position = 0;
  let chunkBytes = 0;
  state.storage = { mode: "chosen file", needed: total };

  /** Records why a write to the chosen file failed and returns the error to throw. */
  const saveError = (e) => {
    const failure = classifySaveFailure({ name: e?.name, message: e?.message, position, total });
    state.failure = { ...failure, position, total, chunkBytes, written: null, errorName: e?.name ?? null };
    return new Error(failure.message);
  };

  if (typeof handle.createWritable !== "function") {
    throw saveError({ name: "TypeError", message: "the chosen file cannot be written" });
  }
  rec.begin("convert");
  postMessage({ type: "stage", stage: "converting" });
  try {
    state.writable = await handle.createWritable();
  } catch (e) {
    throw saveError(e);
  }
  const writable = state.writable;

  // Planning problems (for example a size limit) are engine errors, not save errors.
  const summary = JSON.parse(scan.stream_begin(0, read, replacement));
  const onProgress = makeProgressReporter();
  for (;;) {
    const chunk = scan.stream_next();
    if (!chunk) {
      break;
    }
    chunkBytes = chunk.byteLength;
    const started = performance.now();
    try {
      await writable.write(chunk);
    } catch (e) {
      throw saveError(e);
    }
    rec.write(chunk.byteLength, performance.now() - started);
    position += chunk.byteLength;
    onProgress(scan.stream_fraction());
  }
  chunkBytes = 0;
  postMessage({ type: "progress", fraction: 1 });
  rec.begin("finalize");
  postMessage({ type: "stage", stage: "finalizing" });
  try {
    await writable.close();
  } catch (e) {
    throw saveError(e);
  }
  state.writable = null;

  // The file on disk must be exactly what was written; a mismatch is reported, never hidden.
  let size = null;
  try {
    size = (await handle.getFile()).size;
  } catch {
    // Reading the size back is a check, not a requirement: some browsers deny it.
  }
  if (size !== null && size !== total) {
    throw saveError({
      name: "SizeMismatch",
      message: `the saved file is ${size} bytes but ${total} were written`,
    });
  }
  rec.end();

  if (audioNote) {
    summary.warnings = [...(summary.warnings ?? []), audioNote];
  }
  const diagnostics = buildDiagnostics({
    version: wasmVersion,
    env: collectEnv(),
    file,
    recorder: rec,
    storage: state.storage,
    report: state.report,
  });
  postMessage({
    type: "done",
    saved: true,
    savedName: typeof handle.name === "string" ? handle.name : outputName,
    size: total,
    summary,
    outputName,
    inMemory: false,
    diagnostics,
  });
  self.close();
}

/** Discards a half-written chosen file (the target is left as it was). Never throws. */
async function abortQuietly(writable) {
  if (!writable) {
    return;
  }
  try {
    await writable.abort();
  } catch {
    // Already closed or aborted.
  }
}

/** Environment facts that help explain speed and memory problems (no personal data). */
function collectEnv() {
  const nav = self.navigator ?? {};
  return {
    userAgent: nav.userAgent ?? null,
    platform: nav.userAgentData?.platform ?? nav.platform ?? null,
    cores: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    opfs: typeof nav.storage?.getDirectory === "function",
    audioDecoder: typeof self.AudioDecoder === "function",
    audioEncoder: typeof self.AudioEncoder === "function",
  };
}

/** @returns {Promise<{quota?: number, usage?: number}|null>} */
async function readStorageEstimate() {
  try {
    if (navigator.storage && typeof navigator.storage.estimate === "function") {
      return await navigator.storage.estimate();
    }
  } catch {
    // No estimate: callers treat that as "unknown", which never blocks a conversion.
  }
  return null;
}

/** Posts scan progress (bytes read / file size) at most every PROGRESS_INTERVAL_MS. */
function makeScanReporter() {
  let last = 0;
  return (fraction) => {
    const now = Date.now();
    if (Number.isFinite(fraction) && now - last >= PROGRESS_INTERVAL_MS) {
      last = now;
      postMessage({ type: "scan-progress", fraction });
    }
  };
}

/**
 * Re-encodes one Vorbis track. Never throws: on any problem the track simply stays skipped and
 * `note` says why (it is shown to the user as a warning).
 * @param {{export_audio_track: Function, probe: Function}} scan the scanned file
 * @param {(offset: number, length: number) => Uint8Array} read
 * @param {{number: number, codecId: string}} track
 * @returns {Promise<{note: string, replacement?: object, report?: object}>}
 */
async function reencodeAudio(scan, read, track) {
  const skipped = (why) => ({
    note: `track ${track.number} (${track.codecId}) skipped: ${why}`,
  });
  const deps = {
    AudioDecoder: self.AudioDecoder,
    AudioEncoder: self.AudioEncoder,
    EncodedAudioChunk: self.EncodedAudioChunk,
  };
  if (!deps.AudioDecoder || !deps.AudioEncoder || !deps.EncodedAudioChunk) {
    return skipped("this browser cannot re-encode Vorbis audio (no WebCodecs audio support)");
  }
  try {
    postMessage({ type: "stage", stage: "reencoding-audio" });
    const packets = [];
    let bytes = 0;
    const info = scan.export_audio_track(read, track.number, (ptsNs, data) => {
      bytes += data.length;
      if (bytes > MAX_BUFFER_BYTES) {
        throw new Error("the audio track is too large to re-encode in the browser");
      }
      packets.push({ ptsNs, data });
    });
    const format = {
      codecPrivate: info.codecPrivate,
      sampleRate: info.sampleRate,
      channels: info.channels,
    };
    const encoder = await canReencodeVorbis(deps, format);
    if (!encoder) {
      return skipped("this browser cannot decode Vorbis or encode AAC/Opus audio");
    }
    const result = await transcodeVorbis({ info: format, packets, encoder, deps });
    const replacement = buildReplacement(track.number, result);
    const report = JSON.parse(scan.probe(read, replacement));
    const label = encoder.id === "aac" ? "AAC" : "Opus";
    return {
      note: `Audio track ${track.number} (Vorbis) was re-encoded to ${label} because MP4 cannot hold Vorbis (this step is lossy).`,
      replacement,
      report,
    };
  } catch (err) {
    return skipped(`re-encoding failed (${errorText(err)})`);
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

/**
 * Synchronous random-access reader used by wasm. Counts calls, bytes and time for the
 * diagnostics, and remembers where a read failed so the error can say so.
 */
function makeReader(file, rec, state) {
  const fileReader = new FileReaderSync();
  return (offset, length) => {
    const started = performance.now();
    let buffer;
    try {
      buffer = fileReader.readAsArrayBuffer(file.slice(offset, offset + length));
    } catch (e) {
      const name = e?.name ?? "Error";
      state.readFailure = { offset, length, name, message: String(e?.message ?? e) };
      throw new Error(`read failed at offset ${offset} (${name}: ${state.readFailure.message})`);
    }
    rec.read(length, performance.now() - started);
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== length) {
      state.readFailure = { offset, length, name: "ShortRead", got: bytes.byteLength };
      throw new Error(`short read at offset ${offset}: got ${bytes.byteLength} of ${length} bytes`);
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
