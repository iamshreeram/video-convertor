import test from "node:test";
import assert from "node:assert/strict";
import {
  Recorder,
  assessStorage,
  buildDiagnostics,
  classifyWriteFailure,
  formatDiagnostics,
  logDiagnostics,
  storageFullMessage,
  summarizeReport,
  summaryLine,
} from "../../web/js/core/diagnostics.js";

function clock(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("Recorder times each stage and attributes I/O to the stage it happened in", () => {
  const rec = new Recorder(clock(0, 10, 110, 410, 1000));
  rec.begin("scan"); // t=10 (0 was the constructor)
  rec.read(1000, 5);
  rec.read(500, 2);
  rec.begin("convert"); // t=110 closes scan (100 ms)
  rec.write(2000, 7);
  rec.end(); // t=410 closes convert (300 ms)
  const snap = rec.snapshot(); // t=1000
  assert.deepEqual(
    snap.stages.map((s) => [s.name, s.ms, s.readCalls, s.readBytes, s.writeCalls, s.writeBytes]),
    [
      ["scan", 100, 2, 1500, 0, 0],
      ["convert", 300, 0, 0, 1, 2000],
    ],
  );
  assert.equal(snap.io.readBytes, 1500);
  assert.equal(snap.io.writeBytes, 2000);
  assert.equal(snap.io.readMs, 7);
  assert.equal(snap.totalMs, 1000);
});

test("Recorder.snapshot closes a running stage and reports its name", () => {
  const rec = new Recorder(clock(0, 5, 25));
  rec.begin("scan");
  assert.equal(rec.stageName, "scan");
  const snap = rec.snapshot();
  assert.equal(snap.stages.length, 1);
  assert.equal(snap.stages[0].name, "scan");
  assert.equal(rec.stageName, "scan");
});

test("assessStorage compares needed bytes with quota minus usage", () => {
  const ok = assessStorage({ quota: 10_000, usage: 1_000 }, 8_000);
  assert.deepEqual(ok, { known: true, quota: 10_000, usage: 1_000, available: 9_000, needed: 8_000, enough: true });
  const exact = assessStorage({ quota: 10_000, usage: 2_000 }, 8_000);
  assert.equal(exact.enough, true);
  const short = assessStorage({ quota: 10_000, usage: 3_000 }, 8_000);
  assert.equal(short.enough, false);
  assert.equal(short.available, 7_000);
});

test("assessStorage never blocks when the browser gives no usable numbers", () => {
  for (const est of [undefined, null, {}, { quota: NaN, usage: 1 }, { quota: 0, usage: 0 }, { quota: "x" }]) {
    const r = assessStorage(est, 5_000);
    assert.equal(r.known, false, JSON.stringify(est));
    assert.equal(r.enough, true);
  }
  // usage above quota (possible while storage is being evicted) means nothing is available
  const over = assessStorage({ quota: 100, usage: 500 }, 10);
  assert.equal(over.available, 0);
  assert.equal(over.enough, false);
  // missing usage counts as zero
  assert.equal(assessStorage({ quota: 100 }, 10).available, 100);
});

test("storageFullMessage and classifyWriteFailure build messages the error mapper understands", () => {
  const m = storageFullMessage({ needed: 1500, available: 600, quota: 900, usage: 300 });
  assert.match(m, /^storage full: /);
  assert.match(m, /needs 1500 bytes but only 600 bytes/);
  assert.match(m, /quota 900/);

  const short = classifyWriteFailure({ written: 10, expected: 20, position: 4096, total: 9999 });
  assert.equal(short.code, "STORAGE_FULL");
  assert.equal(short.message, "storage full: disk write failed after 4096 of 9999 bytes");

  const quota = classifyWriteFailure({ name: "QuotaExceededError", message: "q", position: 1, total: 2 });
  assert.equal(quota.code, "STORAGE_FULL");

  const other = classifyWriteFailure({ name: "NoModificationAllowedError", message: "locked", position: 1, total: 2 });
  assert.equal(other.code, "OUTPUT_ERROR");
  assert.equal(other.message, "output error: NoModificationAllowedError: locked");

  // unknown total still produces a readable message
  assert.equal(
    classifyWriteFailure({ written: 0, expected: 5, position: 7 }).message,
    "storage full: disk write failed after 7 bytes",
  );
});

test("summarizeReport keeps codecs and sizes but drops anything free-form", () => {
  const s = summarizeReport({
    tracks: [
      { kind: "video", codec: "h264", width: 1280, height: 720, channels: 0, sampleRate: 0, language: "und", sampleCount: 24 },
      { kind: "audio", codec: "aac", width: 0, height: 0, channels: 2, sampleRate: 48000, language: "eng", sampleCount: 40 },
    ],
    durationMs: 9000,
    outputSize: 12345,
    warnings: ["a", "b"],
    reencodable: [{ number: 2, codecId: "A_VORBIS", channels: 2, sampleRate: 44100 }],
    secret: "do not copy",
  });
  assert.equal(s.tracks.length, 2);
  assert.deepEqual(s.tracks[0], { kind: "video", codec: "h264", width: 1280, height: 720, channels: 0, sampleRate: 0, samples: 24 });
  assert.equal(s.durationMs, 9000);
  assert.equal(s.outputSize, 12345);
  assert.deepEqual(s.warnings, ["a", "b"]);
  assert.equal(s.secret, undefined);
  assert.equal(summarizeReport(null), null);
  assert.deepEqual(summarizeReport({}).tracks, []);
});

test("buildDiagnostics never contains the file name and clips long text", () => {
  const rec = new Recorder(clock(0, 1, 2));
  const diag = buildDiagnostics({
    version: "0.1.0",
    env: { userAgent: "UA", cores: 2 },
    file: { name: "Holiday 2024 (private).mkv", size: 123 },
    recorder: rec,
    error: { code: "X", name: "Boom", message: "m".repeat(5000), stack: "s\n".repeat(5000) },
  });
  assert.equal(diag.input.extension, "mkv");
  assert.equal(diag.input.bytes, 123);
  const json = JSON.stringify(diag);
  assert.ok(!json.includes("Holiday"), "file name leaked");
  assert.ok(!json.includes("private"), "file name leaked");
  assert.ok(diag.error.message.length <= 2100);
  assert.ok(diag.error.stack.length <= 2100);
  assert.equal(diag.schema, 1);
  assert.equal(diag.app.version, "0.1.0");
  assert.equal(diag.env.cores, 2);
  assert.equal(typeof diag.time, "string");
});

test("buildDiagnostics tolerates missing pieces", () => {
  const diag = buildDiagnostics({});
  assert.equal(diag.input.bytes, null);
  assert.equal(diag.input.extension, "");
  assert.equal(diag.error, null);
  assert.equal(diag.report, null);
  assert.deepEqual(diag.stages, []);
  // extensions are reduced to a safe short token
  assert.equal(buildDiagnostics({ file: { name: "x.we ird/../é", size: 1 } }).input.extension, "");
  assert.equal(buildDiagnostics({ file: { name: "a.MKV", size: 1 } }).input.extension, "mkv");
});

test("formatDiagnostics is valid pretty JSON and summaryLine is one readable line", () => {
  const rec = new Recorder(clock(0, 0, 2000, 4000));
  rec.begin("convert");
  rec.read(40_000_000, 500);
  rec.write(20_000_000, 400);
  const diag = buildDiagnostics({
    version: "1",
    file: { name: "a.mkv", size: 40_000_000 },
    recorder: rec,
    error: { code: "STORAGE_FULL", name: "Error", message: "storage full: x" },
  });
  assert.deepEqual(JSON.parse(formatDiagnostics(diag)), diag);
  const line = summaryLine(diag);
  assert.ok(!line.includes("\n"));
  assert.match(line, /STORAGE_FULL/);
  assert.match(line, /convert/);
  assert.match(line, /MB\/s/);
});

test("logDiagnostics writes a grouped, copyable record to the console and never throws", () => {
  const calls = [];
  const con = {
    groupCollapsed: (...a) => calls.push(["groupCollapsed", ...a]),
    groupEnd: () => calls.push(["groupEnd"]),
    error: (...a) => calls.push(["error", ...a]),
    info: (...a) => calls.push(["info", ...a]),
    log: (...a) => calls.push(["log", ...a]),
  };
  const diag = buildDiagnostics({ version: "1", error: { code: "READ_FAILED", name: "E", message: "m" } });
  logDiagnostics("error", diag, con);
  assert.equal(calls[0][0], "groupCollapsed");
  assert.match(String(calls[0][1]), /mkv2mp4/);
  assert.ok(calls.some((c) => c[0] === "error"));
  assert.ok(calls.some((c) => c[0] === "log" && String(c[1]).includes('"schema"')));
  assert.equal(calls.at(-1)[0], "groupEnd");
  // a console without group support and a null console are both fine
  logDiagnostics("info", diag, { log: () => {} });
  logDiagnostics("info", diag, null);
  logDiagnostics("info", null, con);
});
