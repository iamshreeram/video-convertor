/**
 * Where converted files go when the browser lets the user pick a folder (File System Access API).
 * Pure helpers with no DOM: the directory handle is passed in, so they can be tested with doubles.
 */

import { classifySaveFailure } from "./diagnostics.js";

/** localStorage key remembering that the user chose normal downloads instead of a folder. */
export const SAVE_PREF_KEY = "mkv2mp4.save-to";

const MAX_STEM_LENGTH = 120;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * @param {any} [win] the window (or a stand-in)
 * @returns {boolean} whether the browser can let the user pick a folder
 */
export function canPickFolder(win = globalThis) {
  return Boolean(win) && typeof win.showDirectoryPicker === "function";
}

/**
 * @param {any} storage a Storage-like object (may be missing or throw)
 * @returns {"browser"|null} the remembered choice, if any
 */
export function readSavePreference(storage) {
  try {
    return storage && storage.getItem(SAVE_PREF_KEY) === "browser" ? "browser" : null;
  } catch {
    return null;
  }
}

/**
 * @param {any} storage a Storage-like object (may be missing or throw)
 * @param {"browser"|null} value "browser" remembers the choice; null forgets it
 */
export function writeSavePreference(storage, value) {
  try {
    if (!storage) return;
    if (value === "browser") storage.setItem(SAVE_PREF_KEY, "browser");
    else storage.removeItem(SAVE_PREF_KEY);
  } catch {
    // Storage may be blocked; the choice then only lasts for this visit.
  }
}

/**
 * Makes a name safe to create as a file on Windows, macOS and Linux: no path separators or
 * reserved characters, no trailing dots or spaces, no device names such as CON, bounded length.
 * @param {unknown} name file name without its extension
 * @returns {string} never empty
 */
export function safeFileName(name) {
  let s = typeof name === "string" ? name : "";
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  s = s.slice(0, MAX_STEM_LENGTH).replace(/[. ]+$/, "");
  if (!s) return "output";
  if (RESERVED_WINDOWS_NAME.test(s)) s = `_${s}`;
  return s;
}

/**
 * @param {unknown} name the input file name
 * @returns {string} "<name without extension>.mp4", safe to create
 */
export function mp4Name(name) {
  const raw = typeof name === "string" ? name : "";
  const stem = raw.replace(/[\\/]/g, "_").replace(/\.[^.]*$/, "");
  return `${safeFileName(stem)}.mp4`;
}

/**
 * @param {string} name e.g. "clip.mp4"
 * @param {number} n 0 keeps the name; 1 gives "clip (1).mp4"
 * @returns {string}
 */
export function numberedName(name, n) {
  if (n <= 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Finds a file name that does not exist in the directory yet, so a converted file never
 * replaces something the user already has. Only looks; creates nothing.
 * @param {any} dir FileSystemDirectoryHandle
 * @param {string} name wanted name
 * @param {number} [limit] highest counter to try
 * @returns {Promise<string>}
 */
export async function uniqueFileName(dir, name, limit = 999) {
  for (let n = 0; n <= limit; n++) {
    const candidate = numberedName(name, n);
    try {
      await dir.getFileHandle(candidate);
    } catch (err) {
      if (err && err.name === "NotFoundError") return candidate;
      if (err && err.name === "TypeMismatchError") continue; // a folder has this name
      throw err;
    }
  }
  throw new Error("no free file name in the chosen folder");
}

/**
 * Creates the (empty) output file under a free name.
 * @param {any} dir FileSystemDirectoryHandle with write permission
 * @param {string} name wanted name
 * @returns {Promise<{handle: any, name: string}>}
 */
export async function createOutputFile(dir, name) {
  const free = await uniqueFileName(dir, name);
  const handle = await dir.getFileHandle(free, { create: true });
  return { handle, name: free };
}

/**
 * @param {{name?: string, message?: string}|null|undefined} err a failure while creating the file
 * @returns {{code: string, message: string}} same codes and wording as a failed write to a chosen file
 */
export function classifyFolderFailure(err) {
  return classifySaveFailure({ name: err?.name, message: err?.message, position: 0, total: 0 });
}
