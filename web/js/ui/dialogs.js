/**
 * Native <dialog> wrappers (DESIGN.md B5 accessibility contract).
 * showModal() gives the focus trap and Esc handling; focus is restored to the
 * opener explicitly on every close path (button, Esc, backdrop click).
 */

import { h, clear, uid } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { formatBytes } from "../core/format.js";

/**
 * @typedef {object} DialogHandle
 * @property {HTMLDialogElement} el
 * @property {(opener?: Element) => void} open
 * @property {() => void} close
 * @property {(node: Node|string|null) => void} setBody
 */

/**
 * Creates a modal dialog (not yet attached to the document).
 * @param {{title: string, testid?: string, body?: Node|Node[]|string, closeLabel?: string}} options
 * @returns {DialogHandle}
 */
export function createDialog({ title, testid, body, closeLabel = "Close" } = {}) {
  const titleId = uid("dialog-title-");
  let opener = null;

  const slot = h("div", { class: "dialog__body" }, body ?? null);
  const closeX = h(
    "button",
    {
      class: "icon-btn",
      attrs: { type: "button", "aria-label": closeLabel },
      on: { click: () => close() },
    },
    icon("x", { size: 18 }),
  );
  const footerButton = h(
    "button",
    {
      class: "btn btn--secondary",
      attrs: { type: "button" },
      on: { click: () => close() },
    },
    closeLabel,
  );

  const el = h(
    "dialog",
    {
      class: "dialog",
      dataset: { testid },
      attrs: { "aria-labelledby": titleId },
    },
    h(
      "div",
      { class: "dialog__inner" },
      h(
        "header",
        { class: "dialog__header" },
        h("h2", { class: "dialog__title", attrs: { id: titleId }, text: title }),
        closeX,
      ),
      slot,
      h("footer", { class: "dialog__footer" }, footerButton),
    ),
  );

  /** Returns focus to the element that opened the dialog (once). */
  function restoreFocus() {
    const target = opener;
    opener = null;
    if (target && target.isConnected && typeof target.focus === "function") {
      target.focus();
    }
  }

  /**
   * Opens the dialog modally and focuses the close button.
   * @param {Element} [openerEl] defaults to document.activeElement
   */
  function open(openerEl) {
    if (el.open) return;
    if (openerEl instanceof HTMLElement) {
      opener = openerEl;
    } else {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (typeof el.showModal === "function") {
      el.showModal();
    } else {
      // Fallback for engines without <dialog>.showModal: no focus trap, but usable.
      el.setAttribute("open", "");
    }
    closeX.focus();
  }

  /** Closes the dialog and restores focus to the opener. */
  function close() {
    if (!el.open) return;
    if (typeof el.close === "function") {
      el.close();
    } else {
      el.removeAttribute("open");
    }
    restoreFocus();
  }

  // Esc fires 'cancel' first. Take it over so the close and the focus restore
  // happen synchronously: the native 'close' event is queued and could land
  // after the caller has already moved focus elsewhere (observed as a race).
  el.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // Any other native close path still restores focus (no-op if already done).
  el.addEventListener("close", restoreFocus);
  // The dialog box fills its own content (padding 0), so a click whose target
  // is the dialog element itself landed on the ::backdrop.
  el.addEventListener("click", (event) => {
    if (event.target === el) close();
  });

  return {
    el,
    open,
    close,
    setBody(node) {
      clear(slot);
      if (node !== null && node !== undefined) slot.append(node);
    },
  };
}

/**
 * Privacy explainer. Opened from the "Processed locally" badge.
 * @returns {DialogHandle}
 */
export function createPrivacyDialog() {
  const points = h(
    "ul",
    { class: "prose-list" },
    h("li", {}, "Processing happens in your browser, using WebAssembly."),
    h("li", {}, "No uploads, no accounts, no analytics."),
    h(
      "li",
      {},
      "A Content-Security-Policy blocks all network access except this site\u2019s own static files.",
    ),
    h("li", {}, "The site needs no server to process files."),
    h(
      "li",
      {},
      "To verify it yourself: open DevTools \u2192 Network, convert a file, and check that no request carries your file.",
    ),
  );
  return createDialog({
    title: "Your files never leave this device",
    testid: "privacy-dialog",
    body: h("div", {}, points),
  });
}

/** Labels for About dialog keys; unknown keys are humanised. */
const INFO_LABELS = {
  version: "Version",
  storage: "Storage",
  workerConfinement: "Worker confinement",
  memoryBudget: "Memory budget",
  browser: "Browser",
};

/**
 * @param {string} key
 * @returns {string}
 */
function infoLabel(key) {
  if (INFO_LABELS[key]) return INFO_LABELS[key];
  const words = String(key).replace(/([A-Z])/g, " $1").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function infoValue(key, value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return key === "memoryBudget" ? formatBytes(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "\u2014";
  return String(value);
}

/**
 * About dialog with a definition list filled by setInfo().
 * @returns {{dialog: DialogHandle, setInfo: (info: Record<string, unknown>) => void}}
 */
export function createAboutDialog() {
  const list = h("dl", { class: "info-list" });
  const dialog = createDialog({
    title: "About Convertor",
    testid: "about-dialog",
    body: h(
      "div",
      {},
      h(
        "p",
        { class: "dialog__lead" },
        "Convertor turns MKV video into MP4 entirely inside your browser. Your files are never uploaded.",
      ),
      list,
      h("p", { class: "dialog__meta" }, "Open-source: Rust + WebAssembly"),
    ),
  });

  /**
   * Replaces the definition list. The memory budget value carries
   * data-testid="memory-budget".
   * @param {Record<string, unknown>} info
   */
  function setInfo(info) {
    clear(list);
    const data = info && typeof info === "object" ? info : {};
    for (const [key, value] of Object.entries(data)) {
      list.append(
        h("dt", {}, infoLabel(key)),
        h(
          "dd",
          { dataset: key === "memoryBudget" ? { testid: "memory-budget" } : undefined },
          infoValue(key, value),
        ),
      );
    }
  }

  return { dialog, setInfo };
}
