// Module worker: runs the Rust/WASM remuxer off the main thread.
// Messages in:  {type:"convert", file, sessionId, sweep, runId, inMemory}
//               {type:"cleanup", sessionId, keepNothing}
// Messages out: {type:"progress", fraction}
//               {type:"done", file, summary, outputName}
//               {type:"error", message}
//               {type:"cleaned"}
import init, { convert_mkv_to_mp4 } from "./pkg/mkv2mp4.js";

const MEMORY_CAP_BYTES = 1.5 * 2 ** 30;
const PROGRESS_INTERVAL_MS = 100;
const OUTPUT_NAME_PATTERN = /^out-(.+)-(\d+)\.mp4$/;

let wasmReady = null;

function ensureWasm() {
  if (!wasmReady) {
    wasmReady = init();
  }
  return wasmReady;
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") {
    return;
  }
  if (msg.type === "convert") {
    void runConvert(msg);
  } else if (msg.type === "cleanup") {
    void runCleanup(msg);
  }
};

async function runConvert(msg) {
  const state = { opfs: null };
  try {
    const file = msg.file;
    if (!(file instanceof Blob)) {
      throw new Error("No file was provided.");
    }
    await ensureWasm();

    const outputName = makeOutputName(file.name);
    const root = msg.inMemory ? null : await getOpfsRoot();
    if (root && msg.sweep === true) {
      await sweepOrphans(root);
    }
    if (root) {
      state.opfs = await createOpfsOutput(root, `out-${msg.sessionId}-${msg.runId}.mp4`);
    }

    const readChunk = makeReader(file);
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
      summaryText = convert_mkv_to_mp4(file.size, 0, readChunk, writeChunk, onProgress);
      opfs.access.flush();
      opfs.access.close();
      opfs.access = null;
      result = await opfs.handle.getFile();
    } else {
      const chunks = [];
      summaryText = convert_mkv_to_mp4(
        file.size,
        MEMORY_CAP_BYTES,
        readChunk,
        (chunk) => {
          chunks.push(chunk);
        },
        onProgress,
      );
      result = new Blob(chunks, { type: "video/mp4" });
    }

    const summary = JSON.parse(summaryText);
    postMessage({ type: "progress", fraction: 1 });
    postMessage({ type: "done", file: result, summary, outputName });
    self.close();
  } catch (err) {
    await discardOutput(state.opfs);
    postMessage({ type: "error", message: errorText(err) });
    self.close();
  }
}

async function runCleanup(msg) {
  try {
    const root = await getOpfsRoot();
    if (root) {
      for (const name of await listOutputNames(root)) {
        if (parseOutputName(name)?.sessionId === msg.sessionId) {
          await removeQuietly(root, name);
        }
      }
    }
  } catch {
    // Cleanup is best effort and must never fail a conversion.
  }
  postMessage({ type: "cleaned" });
  self.close();
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

function errorText(err) {
  if (err && typeof err.message === "string" && err.message) {
    return err.message;
  }
  if (typeof err === "string" && err) {
    return err;
  }
  return "Conversion failed.";
}
