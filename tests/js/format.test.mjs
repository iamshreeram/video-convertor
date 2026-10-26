import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatDuration, formatEta, formatSpeed, createMeter } from "../../web/js/core/format.js";

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10240), "10 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(389 * 1024 * 1024), "389 MB");
  assert.equal(formatBytes(1.5 * 2 ** 30), "1.5 GB");
  assert.equal(formatBytes(2 ** 40), "1.0 TB");
  assert.equal(formatBytes(5 * 2 ** 40), "5.0 TB");
  assert.equal(formatBytes(NaN), "—");
  assert.equal(formatBytes(-5), "—");
  assert.equal(formatBytes(Infinity), "—");
  assert.equal(formatBytes(undefined), "—");
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(3029), "0:03");
  assert.equal(formatDuration(59_999), "0:59");
  assert.equal(formatDuration(60_000), "1:00");
  assert.equal(formatDuration(754_000), "12:34");
  assert.equal(formatDuration(3_599_000), "59:59");
  assert.equal(formatDuration(3_600_000), "1:00:00");
  assert.equal(formatDuration(3_725_000), "1:02:05");
  assert.equal(formatDuration(36_000_000), "10:00:00");
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatDuration(NaN), "—");
  assert.equal(formatDuration(null), "—");
});

test("formatEta", () => {
  assert.equal(formatEta(0), "0 s");
  assert.equal(formatEta(0.4), "1 s");
  assert.equal(formatEta(12), "12 s");
  assert.equal(formatEta(59.2), "1m 00s");
  assert.equal(formatEta(60), "1m 00s");
  assert.equal(formatEta(185), "3m 05s");
  assert.equal(formatEta(3599), "59m 59s");
  assert.equal(formatEta(3600), "1h 00m");
  assert.equal(formatEta(3720), "1h 02m");
  assert.equal(formatEta(null), "—");
  assert.equal(formatEta(NaN), "—");
  assert.equal(formatEta(Infinity), "—");
  assert.equal(formatEta(-1), "—");
});

test("formatSpeed", () => {
  assert.equal(formatSpeed(0), "0 B/s");
  assert.equal(formatSpeed(10 * 1024 * 1024), "10 MB/s");
  assert.equal(formatSpeed(1.5 * 1024 * 1024), "1.5 MB/s");
  assert.equal(formatSpeed(null), "—");
  assert.equal(formatSpeed(NaN), "—");
});

test("createMeter: first sample has no estimate, then converges to the true speed", () => {
  const total = 100 * 1024 * 1024; // 100 MiB at exactly 10 MiB/s
  const m = createMeter(total);
  const first = m.sample(0.1, 1000);
  assert.deepEqual(first, { bytesPerSec: null, etaSeconds: null });
  let last;
  for (let i = 2; i <= 6; i++) last = m.sample(0.1 * i, 1000 * i);
  assert.ok(Math.abs(last.bytesPerSec - 10 * 1024 * 1024) / (10 * 1024 * 1024) < 0.01, `speed ${last.bytesPerSec}`);
  // fraction 0.6 at t=6s -> 40 MiB left at 10 MiB/s -> 4 s
  assert.ok(Math.abs(last.etaSeconds - 4) < 0.1, `eta ${last.etaSeconds}`);
});

test("createMeter: EMA smooths a speed change, ignores regressions and time going backwards", () => {
  const total = 1000;
  const m = createMeter(total);
  m.sample(0.0, 0);
  const a = m.sample(0.1, 1000); // 100 B/s
  assert.ok(Math.abs(a.bytesPerSec - 100) < 1e-6);
  const b = m.sample(0.3, 2000); // instantaneous 200 B/s -> ema = 0.3*200 + 0.7*100 = 130
  assert.ok(Math.abs(b.bytesPerSec - 130) < 1e-6, `${b.bytesPerSec}`);
  const back = m.sample(0.2, 2500); // fraction regressed -> previous values
  assert.deepEqual(back, b);
  const stale = m.sample(0.5, 2000); // time not advancing -> previous values
  assert.deepEqual(stale, b);
  const done = m.sample(1.0, 4000);
  assert.equal(done.etaSeconds, 0);
  assert.ok(done.bytesPerSec > 0);
});
