/**
 * Polite announcements (#live, visually hidden) and transient toasts.
 * Toasts carry role=status; showToast() also announces its text.
 */

import { h, clear } from "./dom.js";
import { icon } from "./icons.js";

const TOAST_ICON = { info: "info", success: "check", error: "alert" };

/**
 * Creates (once) the #live region and the .toasts stack under root.
 * @param {HTMLElement} [root=document.body]
 * @returns {{live: HTMLElement, toasts: HTMLElement}}
 */
export function initLive(root = document.body) {
  let live = document.getElementById("live");
  if (!live) {
    live = h("div", {
      class: "sr-only",
      attrs: { id: "live", "aria-live": "polite", "aria-atomic": "true" },
    });
    root.appendChild(live);
  }
  let toasts = document.querySelector(".toasts");
  if (!toasts) {
    toasts = h("div", { class: "toasts" });
    root.appendChild(toasts);
  }
  return { live, toasts };
}

/** @returns {{live: HTMLElement, toasts: HTMLElement}} */
function ensure() {
  return initLive(document.body);
}

/** Runs fn on the next frame (falls back to a timer where rAF is absent). */
function nextFrame(fn) {
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => fn());
  } else {
    setTimeout(fn, 16);
  }
}

/**
 * Announces a message through the polite live region. The region is cleared
 * first so that repeating the same text is announced again.
 * @param {string} message
 */
export function announce(message) {
  const { live } = ensure();
  live.textContent = "";
  nextFrame(() => {
    live.textContent = String(message ?? "");
  });
}

/**
 * Shows a toast and announces it.
 * @param {string} message
 * @param {{kind?: 'info'|'success'|'error', timeout?: number}} [options]
 *   timeout <= 0 keeps the toast until dismissed.
 * @returns {HTMLElement} the toast element
 */
export function showToast(message, { kind = "info", timeout = 4500 } = {}) {
  const safeKind = TOAST_ICON[kind] ? kind : "info";
  const { toasts } = ensure();
  const text = String(message ?? "");

  const toast = h(
    "div",
    {
      class: `toast toast--${safeKind}`,
      attrs: { role: "status" },
      dataset: { testid: "toast" },
    },
    h("span", { class: "toast__icon" }, icon(TOAST_ICON[safeKind], { size: 18 })),
    h("p", { class: "toast__text", text }),
    h(
      "button",
      {
        class: "icon-btn toast__close",
        attrs: { type: "button", "aria-label": "Dismiss notification" },
        on: { click: () => toast.remove() },
      },
      icon("x", { size: 16 }),
    ),
  );

  toasts.appendChild(toast);
  if (Number.isFinite(timeout) && timeout > 0) {
    setTimeout(() => toast.remove(), timeout);
  }
  announce(text);
  return toast;
}

/** Removes every toast (used by tests and by the controller on reset). */
export function clearToasts() {
  clear(ensure().toasts);
}
