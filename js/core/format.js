/**
 * Pure formatting helpers and a throughput/ETA meter.
 * Semantics: DESIGN.md B3.5. No DOM access; runs in browsers and node 22+.
 */

const DASH = "\u2014";
const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** @param {unknown} n @returns {boolean} true for finite numbers >= 0 */
function isNonNegative(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** @param {number} n @returns {string} zero-padded to two digits */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Human-readable byte count, base 1024.
 * @param {unknown} n
 * @returns {string} e.g. "1.5 KB", "389 MB"; em dash for invalid input
 */
export function formatBytes(n) {
  if (!isNonNegative(n)) return DASH;
  if (n < 1024) return `${Math.round(n)} B`;
  let unit = 0;
  let value = n;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  let text = value < 10 ? value.toFixed(1) : value.toFixed(0);
  // Rounding can reach 1024 (e.g. 1023.96 KB); promote to the next unit.
  if (Number(text) >= 1024 && unit < UNITS.length - 1) {
    unit++;
    value /= 1024;
    text = value < 10 ? value.toFixed(1) : value.toFixed(0);
  }
  return `${text} ${UNITS[unit]}`;
}

/**
 * Duration in milliseconds as "m:ss" or "h:mm:ss" (from one hour).
 * @param {unknown} ms
 * @returns {string} em dash for invalid input
 */
export function formatDuration(ms) {
  if (!isNonNegative(ms)) return DASH;
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${minutes}:${pad2(seconds)}`;
}

/**
 * Remaining time in seconds as a short human string (rounded up).
 * @param {unknown} seconds
 * @returns {string} "12 s", "3m 05s", "1h 02m"; em dash for invalid input
 */
export function formatEta(seconds) {
  if (!isNonNegative(seconds)) return DASH;
  const s = Math.ceil(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

/**
 * Throughput in bytes per second.
 * @param {unknown} bytesPerSec
 * @returns {string} e.g. "10 MB/s"; em dash for invalid input
 */
export function formatSpeed(bytesPerSec) {
  const bytes = formatBytes(bytesPerSec);
  return bytes === DASH ? DASH : `${bytes}/s`;
}

/**
 * Creates a meter that turns (fraction, time) samples into a smoothed speed
 * (EMA, alpha 0.3) and an ETA. Stale or regressing samples are ignored and
 * the previous values are returned.
 * @param {number} totalBytes
 * @returns {{sample: (fraction: number, nowMs: number) => {bytesPerSec: number|null, etaSeconds: number|null}}}
 */
export function createMeter(totalBytes) {
  const total = isNonNegative(totalBytes) ? totalBytes : 0;
  const ALPHA = 0.3;
  let last = null; // {fraction, nowMs} of the last accepted sample
  let speed = null; // smoothed bytes per second
  let eta = null;

  const current = () => ({ bytesPerSec: speed, etaSeconds: eta });

  return {
    /**
     * @param {number} fraction progress 0..1
     * @param {number} nowMs monotonic timestamp in milliseconds
     * @returns {{bytesPerSec: number|null, etaSeconds: number|null}}
     */
    sample(fraction, nowMs) {
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) return current();
      if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return current();
      const f = Math.min(1, Math.max(0, fraction));
      if (last === null) {
        last = { fraction: f, nowMs };
        return current();
      }
      if (nowMs <= last.nowMs || f < last.fraction) return current();

      const seconds = (nowMs - last.nowMs) / 1000;
      const instant = ((f - last.fraction) * total) / seconds;
      speed = speed === null ? instant : ALPHA * instant + (1 - ALPHA) * speed;
      last = { fraction: f, nowMs };

      if (f >= 1) eta = 0;
      else if (speed > 0) eta = ((1 - f) * total) / speed;
      else eta = null;
      return current();
    },
  };
}
