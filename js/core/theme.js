/**
 * Theme preference: 'auto' (follow the OS), 'light' or 'dark'.
 * Sets html[data-theme] to the RESOLVED value ('light'|'dark') and
 * html[data-theme-pref] to the preference. Persisted in localStorage under
 * "convertor.theme" (local only). Storage failures are ignored.
 */

const STORAGE_KEY = "convertor.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const NEXT = { auto: "light", light: "dark", dark: "auto" };

let pref = "auto";
let listening = false;

/** @returns {MediaQueryList|null} */
function darkQuery() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY)
    : null;
}

/** @returns {'auto'|'light'|'dark'} */
function readStored() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}

/** @param {string} value */
function writeStored(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage may be blocked (private mode, policy); the choice still applies.
  }
}

/** @returns {'light'|'dark'} */
function resolve() {
  if (pref === "light" || pref === "dark") return pref;
  const query = darkQuery();
  return query && query.matches ? "dark" : "light";
}

/** Writes the resolved theme and the preference onto <html>. */
function apply() {
  const root = document.documentElement;
  root.dataset.theme = resolve();
  root.dataset.themePref = pref;
}

/**
 * Reads the stored preference, applies it, and follows OS changes while 'auto'.
 * Safe to call more than once.
 */
export function initTheme() {
  pref = readStored();
  apply();
  const query = darkQuery();
  if (query && !listening) {
    listening = true;
    const onChange = () => {
      if (pref === "auto") apply();
    };
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
    } else if (typeof query.addListener === "function") {
      query.addListener(onChange);
    }
  }
}

/** @returns {'auto'|'light'|'dark'} the stored preference (not the resolved theme) */
export function getThemePref() {
  return pref;
}

/**
 * Sets an explicit preference.
 * @param {'auto'|'light'|'dark'} value
 * @returns {'auto'|'light'|'dark'}
 */
export function setThemePref(value) {
  pref = value === "light" || value === "dark" ? value : "auto";
  writeStored(pref);
  apply();
  return pref;
}

/**
 * Advances auto -> light -> dark -> auto, persists and applies it.
 * @returns {'auto'|'light'|'dark'} the new preference
 */
export function cycleTheme() {
  return setThemePref(NEXT[pref] || "auto");
}
