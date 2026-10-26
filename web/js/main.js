/**
 * Bootstrap (DESIGN.md B3): capability check -> theme -> live region ->
 * session lock -> dialogs and shell -> hash router -> first tool.
 * html[data-state] goes init -> ready, or -> unsupported / error. Failures
 * always show a visible panel instead of a blank page.
 */

import { h, clear } from "./core/dom.js";
import { detectCapabilities } from "./core/caps.js";
import { acquireSession } from "./core/session.js";
import { initTheme } from "./core/theme.js";
import { initLive, announce, showToast } from "./core/toast.js";
import { createShell } from "./ui/shell.js";
import { createPrivacyDialog, createAboutDialog } from "./ui/dialogs.js";
import { tools, defaultToolId } from "./tools/registry.js";

const SUPPORT_HINT =
  "Try a current version of Chrome, Edge, Firefox or Safari, with JavaScript and WebAssembly enabled.";

/** @returns {HTMLElement} the app root, or <body> if #app is missing */
function appRoot() {
  return document.getElementById("app") || document.body;
}

/** @param {'init'|'ready'|'unsupported'|'error'} state */
function setState(state) {
  document.documentElement.dataset.state = state;
}

/**
 * Replaces the app with a plain panel (no shell). Used for unsupported
 * browsers and fatal start-up errors.
 * @param {string} title
 * @param {Node[]} body
 */
function renderPanel(title, body) {
  const root = appRoot();
  clear(root);
  root.append(
    h(
      "main",
      { class: "content", attrs: { id: "main" } },
      h(
        "section",
        { class: "page-head", dataset: { testid: "fatal-panel" } },
        h("h1", { class: "page-title" }, title),
        ...body,
      ),
    ),
  );
}

/** @param {string[]} missing */
function renderUnsupported(missing) {
  renderPanel("This browser can\u2019t run Convertor", [
    h("p", { class: "page-desc" }, "Convertor needs features that this browser does not provide:"),
    h(
      "ul",
      { class: "prose-list", dataset: { testid: "missing-features" } },
      ...missing.map((item) => h("li", {}, item)),
    ),
    h("p", { class: "page-desc" }, SUPPORT_HINT),
  ]);
  setState("unsupported");
}

/** @param {unknown} err */
function renderFatal(err) {
  const detail = err && typeof err.message === "string" ? err.message : String(err);
  try {
    renderPanel("Convertor couldn\u2019t start", [
      h(
        "p",
        { class: "page-desc" },
        "Reload the page. If the problem continues, try a current version of Chrome, Edge, Firefox or Safari.",
      ),
      h("p", { class: "callout", dataset: { testid: "fatal-details" } }, detail),
    ]);
  } catch {
    // Even the panel failed: the data-state below still tells the tests what happened.
  }
  setState("error");
}

/**
 * Parses the route from the hash. Empty, unknown or 'soon' tools fall back to
 * the default tool.
 * @param {string} hash
 * @returns {string} ready tool id
 */
function resolveToolId(hash) {
  let id = "";
  try {
    id = decodeURIComponent(String(hash || "").replace(/^#\/?/, ""));
  } catch {
    id = "";
  }
  const tool = tools.find((item) => item.id === id);
  return tool && tool.status === "ready" ? tool.id : defaultToolId;
}

async function start() {
  const caps = detectCapabilities();
  if (!caps.ok) {
    renderUnsupported(caps.missing);
    return;
  }

  initTheme();
  initLive();
  const session = await acquireSession();

  const privacy = createPrivacyDialog();
  const about = createAboutDialog();
  let storageInfo = { storage: "\u2014", workerConfinement: "not started yet", memoryBudget: "\u2014" };

  /** Merges facts reported by the tool into the About dialog. @param {object} patch */
  function setStorageInfo(patch) {
    storageInfo = { ...storageInfo, ...patch };
    about.setInfo(storageInfo);
  }

  const initialId = resolveToolId(window.location.hash);
  const shell = createShell({ tools, activeId: initialId });
  clear(appRoot());
  appRoot().append(shell.el, privacy.el, about.dialog.el);

  shell.privacyButton.addEventListener("click", () => privacy.open(shell.privacyButton));
  shell.aboutButton.addEventListener("click", () => {
    about.setInfo(storageInfo);
    about.dialog.open(shell.aboutButton);
  });

  const ctx = {
    session,
    caps,
    announce,
    showToast,
    setVersion: (text) => shell.setVersion(text),
    setStorageInfo,
    privacy,
  };

  let currentId = null;
  let unmountCurrent = null;
  let routeSeq = 0;

  /** Mounts a ready tool into the main region, unmounting the previous one. @param {string} id */
  async function showTool(id) {
    const seq = ++routeSeq;
    const tool = tools.find((item) => item.id === id);
    if (!tool || typeof tool.load !== "function") return;
    const mod = await tool.load();
    if (seq !== routeSeq) return; // a newer route won while this one loaded
    if (unmountCurrent) {
      const previous = unmountCurrent;
      unmountCurrent = null;
      previous();
    }
    clear(shell.main);
    const handle = await mod.mount(shell.main, ctx);
    if (seq !== routeSeq) {
      handle.unmount();
      return;
    }
    unmountCurrent = () => handle.unmount();
    currentId = id;
    shell.setActive(id);
  }

  /** Routes the current hash; rewrites unknown hashes to the default tool. */
  function route() {
    const id = resolveToolId(window.location.hash);
    if (window.location.hash !== `#/${encodeURIComponent(id)}`) {
      window.history.replaceState(null, "", `#/${encodeURIComponent(id)}`);
    }
    if (id !== currentId) {
      showTool(id).catch(renderFatal);
    }
  }

  window.addEventListener("hashchange", route);

  // First paint: mount the chosen tool before declaring the app ready.
  const first = initialId;
  if (window.location.hash !== `#/${encodeURIComponent(first)}`) {
    window.history.replaceState(null, "", `#/${encodeURIComponent(first)}`);
  }
  await showTool(first);
  setState("ready");
}

start().catch(renderFatal);
