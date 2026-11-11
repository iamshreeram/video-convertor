/**
 * The "where should converted files be saved?" panel shown above the dropzone.
 *
 * Browsers that can pick a folder (Chrome and Edge on desktop) ask for it up front, so every
 * conversion is written straight into that folder: no browser storage, no memory, no extra
 * click per file. Anywhere else, or if the user prefers, files are kept in browser storage and
 * offered as downloads. The panel is hidden when the folder choice does not exist.
 */

import { h } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { canPickFolder, readSavePreference, writeSavePreference } from "../core/destination.js";

/**
 * @typedef {{mode: "unset"|"folder"|"browser", dir: any, folderName: string}} DestinationState
 */

/**
 * @param {{
 *   win?: any, storage?: any,
 *   pickFolder?: () => Promise<any>,
 *   onChange?: (state: DestinationState) => void,
 *   notify?: (message: string) => void,
 * }} [options]
 * @returns {{el: HTMLElement, state: () => DestinationState}}
 */
export function createDestinationBar({ win = window, storage, pickFolder, onChange, notify } = {}) {
  const supported = canPickFolder(win);
  const picker =
    pickFolder ??
    (() => win.showDirectoryPicker({ id: "mkv2mp4-output", mode: "readwrite", startIn: "videos" }));

  /** @type {DestinationState} */
  let current = {
    mode: !supported || readSavePreference(storage) === "browser" ? "browser" : "unset",
    dir: null,
    folderName: "",
  };

  const el = h("section", {
    class: "destination",
    dataset: { testid: "destination" },
    attrs: { "aria-label": "Save location" },
  });
  el.hidden = !supported;

  /** @param {DestinationState} next */
  function setState(next) {
    current = next;
    render(true);
    if (typeof onChange === "function") onChange({ ...current });
  }

  async function choose() {
    let dir;
    try {
      dir = await picker();
    } catch (err) {
      // Closing the dialog is not an error.
      if (err && err.name === "AbortError") return;
      if (typeof notify === "function") notify("Couldn\u2019t open the folder dialog. Try again.");
      return;
    }
    if (!dir || dir.kind !== "directory") return;
    writeSavePreference(storage, null);
    setState({ mode: "folder", dir, folderName: typeof dir.name === "string" ? dir.name : "folder" });
  }

  function useBrowser() {
    writeSavePreference(storage, "browser");
    setState({ mode: "browser", dir: null, folderName: "" });
  }

  /** @param {string} testid @param {string} label @param {() => void} onClick @param {boolean} primary */
  function button(testid, label, onClick, primary) {
    return h(
      "button",
      {
        class: primary ? "btn btn--primary btn--sm" : "btn btn--secondary btn--sm",
        dataset: { testid },
        attrs: { type: "button" },
        on: { click: onClick },
      },
      label,
    );
  }

  /** @param {boolean} keepFocus move focus into the new content when it was inside the panel */
  function render(keepFocus) {
    const hadFocus = keepFocus && el.contains(document.activeElement);
    el.dataset.mode = current.mode;
    let text;
    let actions;
    if (current.mode === "folder") {
      text = h(
        "p",
        { class: "destination__text", dataset: { testid: "destination-summary" } },
        "Saving converted files to the folder ",
        h("strong", { dataset: { testid: "destination-name" } }, current.folderName),
        ".",
      );
      actions = [
        button("destination-choose", "Change folder\u2026", choose, false),
        button("destination-browser", "Use normal downloads instead", useBrowser, false),
      ];
    } else if (current.mode === "browser") {
      text = h(
        "p",
        { class: "destination__text", dataset: { testid: "destination-summary" } },
        "Converted files are kept in browser storage and offered as downloads. Very large files may not fit.",
      );
      actions = [button("destination-choose", "Save to a folder instead\u2026", choose, false)];
    } else {
      text = h(
        "div",
        { class: "destination__text" },
        h("p", { class: "destination__title", dataset: { testid: "destination-summary" } }, "Choose where to save converted files"),
        h(
          "p",
          { class: "destination__hint" },
          "Pick a folder once. Each file is written straight into it, so even very large files need no browser storage or memory.",
        ),
      );
      actions = [
        button("destination-choose", "Choose a folder\u2026", choose, true),
        button("destination-browser", "Use normal downloads instead", useBrowser, false),
      ];
    }
    el.replaceChildren(
      h("span", { class: "destination__icon", attrs: { "aria-hidden": "true" } }, icon("folder", { size: 20 })),
      text, h("div", { class: "destination__actions" }, ...actions));
    if (hadFocus) {
      const first = el.querySelector("button");
      if (first) first.focus();
    }
  }

  render(false);

  return { el, state: () => ({ ...current }) };
}
