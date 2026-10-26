/**
 * Drag-and-drop zone with a keyboard-operable file picker (DESIGN.md B5).
 * Only the "Browse files" button is a tab stop; the zone itself is not.
 */

import { h, uid } from "../core/dom.js";
import { icon } from "../core/icons.js";

/**
 * Collects files from a drop, skipping directories and non-file items.
 * webkitGetAsEntry must be read synchronously inside the drop event.
 * @param {DataTransfer|null} dt
 * @returns {File[]}
 */
function filesFromDrop(dt) {
  if (!dt) return [];
  if (dt.items && dt.items.length) {
    const files = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }
  return Array.from(dt.files || []);
}

/**
 * @param {DragEvent} event
 * @returns {boolean} true when the drag carries files
 */
function carriesFiles(event) {
  const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
  return types.includes("Files");
}

/**
 * @param {{accept?: string, multiple?: boolean, onFiles?: (files: File[]) => void}} options
 * @returns {{el: HTMLElement, setDisabled: (disabled: boolean) => void, focus: () => void}}
 */
export function createDropzone({ accept = "", multiple = true, onFiles } = {}) {
  let disabled = false;
  const titleId = uid("dropzone-title-");

  const input = h("input", {
    class: "sr-only",
    dataset: { testid: "file-input" },
    attrs: {
      type: "file",
      accept: accept || null,
      multiple,
      tabindex: "-1",
      "aria-hidden": "true",
    },
  });

  const browse = h(
    "button",
    {
      class: "btn btn--primary btn--lg",
      dataset: { testid: "browse" },
      attrs: { type: "button" },
      on: {
        click: () => {
          if (!disabled) input.click();
        },
      },
    },
    icon("upload", { size: 18 }),
    "Browse files",
  );

  /** @param {File[]} files */
  function emit(files) {
    if (files.length && typeof onFiles === "function") onFiles(files);
  }

  const el = h(
    "section",
    {
      class: "dropzone",
      dataset: { testid: "dropzone" },
      attrs: { "aria-labelledby": titleId },
      on: {
        dragenter: (event) => {
          if (!carriesFiles(event) || disabled) return;
          event.preventDefault();
          el.classList.add("is-dragover");
        },
        dragover: (event) => {
          if (!carriesFiles(event) || disabled) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          el.classList.add("is-dragover");
        },
        dragleave: (event) => {
          if (!el.contains(event.relatedTarget)) el.classList.remove("is-dragover");
        },
        drop: (event) => {
          event.preventDefault();
          el.classList.remove("is-dragover");
          if (disabled) return;
          emit(filesFromDrop(event.dataTransfer));
        },
        click: (event) => {
          if (disabled) return;
          // Only clicks on the bare zone open the picker; the button and the
          // input handle their own clicks.
          if (event.target.closest("button, input")) return;
          input.click();
        },
      },
    },
    h(
      "div",
      { class: "dropzone__icon", attrs: { "aria-hidden": "true" } },
      icon("upload", { size: 28 }),
    ),
    h("h2", { class: "dropzone__title", attrs: { id: titleId }, text: "Drop MKV files here" }),
    h(
      "p",
      { class: "dropzone__sub" },
      "or browse \u2014 H.264 / H.265 / AV1 video with AAC, MP3, Opus, FLAC or AC-3 audio",
    ),
    browse,
    input,
  );

  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    // Reset so choosing the same file again still fires 'change'.
    input.value = "";
    emit(files);
  });

  /**
   * Enables or disables the zone. Disabled: muted, ignores drops and clicks.
   * @param {boolean} value
   */
  function setDisabled(value) {
    disabled = Boolean(value);
    el.classList.toggle("is-disabled", disabled);
    browse.disabled = disabled;
    input.disabled = disabled;
    if (disabled) el.classList.remove("is-dragover");
  }

  /** Moves focus to the Browse button. */
  function focus() {
    browse.focus();
  }

  return { el, setDisabled, focus };
}
