/**
 * Aggregate in-memory output budget (DESIGN.md B3.4 / B5). Pure.
 * Invalid totals fail closed (budget of 0).
 */

/** @param {unknown} n @returns {boolean} true for finite numbers >= 0 */
function isValidBytes(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * @param {number} totalBytes overall budget in bytes
 * @returns {{remaining: () => number, used: () => number, canFit: (bytes: number) => boolean,
 *   reserve: (key: string, bytes: number) => boolean, release: (key: string) => void}}
 */
export function createMemoryBudget(totalBytes) {
  const total = isValidBytes(totalBytes) ? totalBytes : 0;
  /** @type {Map<string, number>} */
  const holds = new Map();
  let used = 0;

  const remaining = () => Math.max(0, total - used);

  return {
    remaining,
    used: () => used,
    /** @param {number} bytes @returns {boolean} whether `bytes` fits right now */
    canFit: (bytes) => isValidBytes(bytes) && bytes <= remaining(),
    /**
     * Reserves `bytes` under `key`. Fails (changing nothing) for invalid sizes,
     * an existing key, or insufficient space.
     * @returns {boolean} true when reserved
     */
    reserve(key, bytes) {
      if (!isValidBytes(bytes) || holds.has(key) || bytes > remaining()) return false;
      holds.set(key, bytes);
      used += bytes;
      return true;
    },
    /** Frees the reservation under `key`; unknown keys are ignored. */
    release(key) {
      if (!holds.has(key)) return;
      used -= holds.get(key);
      holds.delete(key);
    },
  };
}
