/**
 * Feature detection (DESIGN.md B3). `ok` is true only when every required
 * capability exists; `missing` names the required ones that do not.
 * Optional capabilities (OPFS, Web Locks, <dialog>) are reported but never
 * block the app: they only change how files are stored or protected.
 */

/**
 * @returns {{
 *   worker: boolean, wasm: boolean, file: boolean, blobUrl: boolean,
 *   opfs: boolean, locks: boolean, dialog: boolean,
 *   ok: boolean, missing: string[]
 * }}
 */
export function detectCapabilities() {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;

  const caps = {
    worker: typeof Worker === "function",
    wasm: typeof WebAssembly === "object" && WebAssembly !== null,
    file: typeof File === "function" && typeof Blob === "function",
    blobUrl: typeof URL === "function" && typeof URL.createObjectURL === "function",
    opfs: typeof nav?.storage?.getDirectory === "function",
    locks: Boolean(nav?.locks),
    dialog: typeof HTMLDialogElement !== "undefined",
  };

  const required = [
    ["worker", "Web Workers"],
    ["wasm", "WebAssembly"],
    ["file", "File and Blob APIs"],
    ["blobUrl", "Blob URLs"],
  ];
  const missing = required.filter(([key]) => !caps[key]).map(([, label]) => label);

  caps.ok = missing.length === 0;
  caps.missing = missing;
  return caps;
}
