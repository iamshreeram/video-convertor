/**
 * Run diagnostics: stage timings, I/O counters, storage numbers and the environment, collected
 * while a file converts so that a failure (or a slow run) can be understood from one copyable
 * record. Pure: no DOM or worker globals except the optional `console` passed to the logger.
 *
 * Privacy: records contain sizes, codecs, timings and error text only. The file NAME and file
 * contents are never included (only a short extension such as "mkv").
 */

import { formatBytes } from "./format.js";

export const DIAGNOSTICS_SCHEMA = 1;
const MAX_TEXT = 2000;
const MB = 1024 * 1024;

/** @param {unknown} v @returns {boolean} */
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** @param {unknown} text @param {number} [max] @returns {string} */
function clip(text, max = MAX_TEXT) {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}

/**
 * Collects stage timings and read/write counters. Each finished stage keeps the I/O that
 * happened while it was running, which separates "scanning the input" from "copying the data".
 */
export class Recorder {
  /** @param {() => number} [now] monotonic clock in milliseconds */
  constructor(now = () => performance.now()) {
    this._now = now;
    this._start = now();
    this._stages = [];
    this._current = null;
    this.io = { readCalls: 0, readBytes: 0, readMs: 0, writeCalls: 0, writeBytes: 0, writeMs: 0 };
  }

  /** Name of the stage that is running (or ran last). */
  get stageName() {
    return this._current ? this._current.name : (this._stages.at(-1)?.name ?? "");
  }

  /** Ends the running stage, if any, and starts `name`. @param {string} name */
  begin(name) {
    const t = this._now();
    this._close(t);
    this._current = { name, t0: t, io0: { ...this.io } };
  }

  /** Ends the running stage. */
  end() {
    this._close(this._now());
  }

  /** @param {number} bytes @param {number} ms */
  read(bytes, ms) {
    this.io.readCalls += 1;
    this.io.readBytes += bytes;
    this.io.readMs += ms;
  }

  /** @param {number} bytes @param {number} ms */
  write(bytes, ms) {
    this.io.writeCalls += 1;
    this.io.writeBytes += bytes;
    this.io.writeMs += ms;
  }

  /** @param {number} t */
  _close(t) {
    if (!this._current) return;
    this._stages.push(this._entry(this._current, t));
    this._current = null;
  }

  /** @param {{name: string, t0: number, io0: object}} cur @param {number} t */
  _entry(cur, t) {
    const d = (key) => Math.round((this.io[key] - cur.io0[key]) * 100) / 100;
    return {
      name: cur.name,
      ms: Math.round(t - cur.t0),
      readCalls: d("readCalls"),
      readBytes: d("readBytes"),
      readMs: d("readMs"),
      writeCalls: d("writeCalls"),
      writeBytes: d("writeBytes"),
      writeMs: d("writeMs"),
    };
  }

  /** A copy of everything recorded so far; a running stage is included up to now. */
  snapshot() {
    const t = this._now();
    const stages = this._stages.map((s) => ({ ...s }));
    if (this._current) stages.push(this._entry(this._current, t));
    const io = {};
    for (const [key, value] of Object.entries(this.io)) io[key] = Math.round(value * 100) / 100;
    return { stages, io, totalMs: Math.round(t - this._start) };
  }
}

/**
 * Compares the space a result needs with what the browser says is left.
 * `known` is false when the browser gave no usable numbers; then `enough` is true so that a
 * missing estimate never blocks a conversion.
 * @param {{quota?: unknown, usage?: unknown}|null|undefined} estimate navigator.storage.estimate()
 * @param {number} neededBytes
 */
export function assessStorage(estimate, neededBytes) {
  const needed = isNum(neededBytes) && neededBytes > 0 ? neededBytes : 0;
  const quota = estimate && isNum(estimate.quota) && estimate.quota > 0 ? estimate.quota : null;
  if (quota === null) {
    return { known: false, quota: null, usage: null, available: null, needed, enough: true };
  }
  const usage = isNum(estimate.usage) && estimate.usage > 0 ? estimate.usage : 0;
  const available = Math.max(0, quota - usage);
  return { known: true, quota, usage, available, needed, enough: available >= needed };
}

/**
 * Error text for "the browser reports too little room". Matched by `describeError`
 * (web/js/core/errors.js); change both together.
 * @param {{needed: number, available: number, quota: number, usage: number}} a
 */
export function storageFullMessage(a) {
  return (
    `storage full: the converted file needs ${a.needed} bytes but only ${a.available} bytes ` +
    `are available (quota ${a.quota}, used ${a.usage})`
  );
}

/**
 * Turns a failed output write into an error code and message.
 * A short write or QuotaExceededError means the storage is full; anything else is a generic
 * output error that keeps the browser's own error name and text.
 * @param {{name?: string, message?: string, written?: number, expected?: number,
 *          position?: number, total?: number}} f
 * @returns {{code: "STORAGE_FULL"|"OUTPUT_ERROR", message: string}}
 */
export function classifyWriteFailure(f) {
  const shortWrite = isNum(f.written) && isNum(f.expected) && f.written < f.expected;
  if (shortWrite || f.name === "QuotaExceededError") {
    const of = isNum(f.total) && f.total > 0 ? ` of ${f.total}` : "";
    const position = isNum(f.position) ? f.position : 0;
    return {
      code: "STORAGE_FULL",
      message: `storage full: disk write failed after ${position}${of} bytes`,
    };
  }
  const name = f.name || "Error";
  return { code: "OUTPUT_ERROR", message: `output error: ${name}: ${f.message ?? ""}`.trimEnd() };
}

/**
 * Keeps only codecs, sizes and counts from an analysis report.
 * @param {any} report
 */
export function summarizeReport(report) {
  if (!report || typeof report !== "object") return null;
  const tracks = Array.isArray(report.tracks) ? report.tracks : [];
  return {
    tracks: tracks.map((t) => ({
      kind: t?.kind ?? null,
      codec: t?.codec ?? null,
      width: t?.width ?? 0,
      height: t?.height ?? 0,
      channels: t?.channels ?? 0,
      sampleRate: t?.sampleRate ?? 0,
      samples: t?.sampleCount ?? 0,
    })),
    durationMs: isNum(report.durationMs) ? report.durationMs : null,
    outputSize: isNum(report.outputSize) ? report.outputSize : null,
    warnings: Array.isArray(report.warnings)
      ? report.warnings.filter((w) => typeof w === "string").slice(0, 20).map((w) => clip(w, 300))
      : [],
  };
}

/** @param {unknown} name @returns {string} lowercase extension, or "" when not a short plain one */
function safeExtension(name) {
  const m = typeof name === "string" ? /\.([A-Za-z0-9]{1,8})$/.exec(name) : null;
  return m ? m[1].toLowerCase() : "";
}

/**
 * Assembles the record. All parts are optional.
 * @param {{version?: string, env?: object, file?: {name?: string, size?: number},
 *   recorder?: Recorder, storage?: object, report?: object,
 *   error?: {code?: string, name?: string, message?: string, stack?: string},
 *   extra?: object}} parts
 */
export function buildDiagnostics(parts) {
  const p = parts && typeof parts === "object" ? parts : {};
  const snap = p.recorder ? p.recorder.snapshot() : null;
  const err = p.error && typeof p.error === "object" ? p.error : null;
  return {
    schema: DIAGNOSTICS_SCHEMA,
    app: { version: p.version ?? null },
    time: new Date().toISOString(),
    env: p.env && typeof p.env === "object" ? { ...p.env } : {},
    input: {
      bytes: p.file && isNum(p.file.size) ? p.file.size : null,
      extension: safeExtension(p.file?.name),
    },
    stages: snap ? snap.stages : [],
    io: snap ? snap.io : null,
    totalMs: snap ? snap.totalMs : null,
    storage: p.storage ?? null,
    report: summarizeReport(p.report),
    error: err
      ? {
          code: err.code ?? "UNKNOWN",
          name: clip(err.name ?? "Error", 100),
          message: clip(err.message ?? ""),
          stack: clip(err.stack ?? ""),
        }
      : null,
    ...(p.extra && typeof p.extra === "object" ? { extra: p.extra } : {}),
  };
}

/** @param {object} diag @returns {string} pretty JSON for pasting into a bug report */
export function formatDiagnostics(diag) {
  return JSON.stringify(diag, null, 2);
}

/** @param {number} bytes @param {number} ms @returns {string} e.g. "76 MB/s" */
function rate(bytes, ms) {
  if (!isNum(bytes) || !isNum(ms) || ms <= 0) return "n/a";
  const mbPerSec = bytes / MB / (ms / 1000);
  return `${mbPerSec.toFixed(mbPerSec < 10 ? 1 : 0)} MB/s`;
}

/** One readable line: outcome, stage, timings and throughput. @param {any} diag */
export function summaryLine(diag) {
  if (!diag || typeof diag !== "object") return "";
  const io = diag.io ?? {};
  const last = Array.isArray(diag.stages) ? diag.stages.at(-1) : null;
  const seconds = isNum(diag.totalMs) ? `${(diag.totalMs / 1000).toFixed(1)} s` : "unknown time";
  const head = diag.error
    ? `failed (${diag.error.code}) in stage "${last?.name ?? "start"}" after ${seconds}`
    : `finished in ${seconds}`;
  const reads = `read ${formatBytes(io.readBytes ?? 0)} in ${io.readCalls ?? 0} calls (${rate(io.readBytes, io.readMs)})`;
  const writes = `wrote ${formatBytes(io.writeBytes ?? 0)} in ${io.writeCalls ?? 0} calls (${rate(io.writeBytes, io.writeMs)})`;
  const stages = Array.isArray(diag.stages)
    ? diag.stages.map((s) => `${s.name} ${(s.ms / 1000).toFixed(1)}s`).join(", ")
    : "";
  return `${head}; input ${formatBytes(diag.input?.bytes)}; ${reads}; ${writes}; stages: ${stages || "none"}`;
}

/**
 * Writes a collapsed console group with the summary line and the full JSON record.
 * @param {"error"|"info"} kind
 * @param {object|null} diag
 * @param {Partial<Console>|null} [con]
 */
export function logDiagnostics(kind, diag, con = typeof console === "undefined" ? null : console) {
  if (!con || !diag) return;
  try {
    const title =
      kind === "error"
        ? "[mkv2mp4] Conversion failed \u2014 diagnostics (copy into a bug report)"
        : "[mkv2mp4] Conversion finished \u2014 diagnostics";
    if (typeof con.groupCollapsed === "function") con.groupCollapsed(title);
    const line = `[mkv2mp4] ${summaryLine(diag)}`;
    const out = kind === "error" ? con.error : con.info;
    (typeof out === "function" ? out : con.log)?.call(con, line);
    con.log?.call(con, formatDiagnostics(diag));
    if (typeof con.groupEnd === "function") con.groupEnd();
  } catch {
    // Logging must never break the page.
  }
}
