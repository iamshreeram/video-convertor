/**
 * App shell: sticky header, tool sidebar (nav), <main id="main">, footer.
 * The controller appends `el` into #app and renders page content into `main`.
 */

import { h, clear } from "../core/dom.js";
import { icon, logoMark } from "../core/icons.js";
import { cycleTheme, getThemePref } from "../core/theme.js";

const THEME_ICON = { auto: "monitor", light: "sun", dark: "moon" };
const THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };

/**
 * @typedef {object} ToolDef
 * @property {string} id
 * @property {string} group
 * @property {string} title
 * @property {string} [subtitle]
 * @property {'ready'|'soon'} status
 */

/**
 * @param {{tools?: ToolDef[], activeId?: string|null, onSelect?: (id: string) => void}} options
 * @returns {{
 *   el: HTMLElement, main: HTMLElement, setActive: (id: string|null) => void,
 *   setVersion: (text: string) => void, privacyButton: HTMLButtonElement,
 *   aboutButton: HTMLButtonElement, themeButton: HTMLButtonElement,
 *   refreshThemeButton: () => void
 * }}
 */
export function createShell({ tools = [], activeId = null, onSelect } = {}) {
  /** @type {Map<string, HTMLElement>} */
  const navItems = new Map();
  let active = activeId;

  // ---- header -----------------------------------------------------------
  const privacyButton = h(
    "button",
    {
      class: "privacy-badge",
      dataset: { testid: "privacy-badge" },
      attrs: { type: "button", "aria-haspopup": "dialog" },
    },
    icon("shield", { size: 16 }),
    h("span", { class: "privacy-badge__text" }, "Processed locally"),
  );

  const themeButton = h("button", {
    class: "icon-btn",
    dataset: { testid: "theme-toggle" },
    attrs: { type: "button" },
    on: {
      click: () => {
        cycleTheme();
        refreshThemeButton();
      },
    },
  });

  /** Syncs icon and label with the current preference. */
  function refreshThemeButton() {
    const pref = getThemePref();
    const next = THEME_NEXT[pref] || "auto";
    const label = `Theme: ${pref}. Switch to ${next}`;
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
    clear(themeButton);
    themeButton.append(icon(THEME_ICON[pref] || "monitor", { size: 18 }));
  }

  const aboutButton = h(
    "button",
    {
      class: "icon-btn",
      dataset: { testid: "about-open" },
      attrs: { type: "button", "aria-label": "About", "aria-haspopup": "dialog" },
    },
    icon("info", { size: 18 }),
  );

  const header = h(
    "header",
    { class: "topbar" },
    h(
      "div",
      { class: "brand" },
      logoMark({ size: 28 }),
      h(
        "div",
        { class: "brand__text" },
        h("span", { class: "brand__name" }, "Convertor"),
        h("span", { class: "brand__tag" }, "Local-first media tools"),
      ),
    ),
    h("div", { class: "topbar__actions" }, privacyButton, themeButton, aboutButton),
  );

  // ---- sidebar ----------------------------------------------------------
  /** @param {ToolDef} tool */
  function buildItem(tool) {
    const soon = tool.status === "soon";
    const body = [
      h(
        "span",
        { class: "nav-item__title" },
        h("span", {}, tool.title),
        soon ? h("span", { class: "pill" }, "Soon") : null,
      ),
      tool.subtitle ? h("span", { class: "nav-item__sub" }, tool.subtitle) : null,
    ];
    let el;
    if (soon) {
      // Focusable so assistive tech reaches it and reads "dimmed/Soon"; inert on click.
      el = h(
        "button",
        {
          class: "nav-item nav-item--soon",
          dataset: { testid: "nav-item", tool: tool.id },
          attrs: { type: "button", "aria-disabled": "true", tabindex: "0" },
          on: { click: (event) => event.preventDefault() },
        },
        body,
      );
    } else {
      el = h(
        "a",
        {
          class: "nav-item",
          dataset: { testid: "nav-item", tool: tool.id },
          attrs: { href: `#/${encodeURIComponent(tool.id)}` },
          on: {
            click: () => {
              if (typeof onSelect === "function") onSelect(tool.id);
            },
          },
        },
        body,
      );
    }
    navItems.set(tool.id, el);
    return el;
  }

  const groups = new Map();
  for (const tool of tools) {
    const group = tool.group || "Tools";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(tool);
  }

  const sidebar = h("nav", { class: "sidebar", attrs: { "aria-label": "Tools" } });
  for (const [group, items] of groups) {
    sidebar.append(
      h(
        "div",
        { class: "sidebar__group" },
        h("p", { class: "sidebar__label" }, group),
        h(
          "ul",
          { class: "sidebar__list" },
          items.map((tool) => h("li", { class: "sidebar__item" }, buildItem(tool))),
        ),
      ),
    );
  }

  // ---- main and footer --------------------------------------------------
  const main = h("main", { class: "content", attrs: { id: "main", tabindex: "-1" } });

  const version = h("span", {
    class: "footer__version",
    dataset: { testid: "app-version" },
    attrs: { hidden: true },
  });
  const footer = h(
    "footer",
    { class: "footer" },
    h(
      "p",
      { class: "footer__text" },
      "Built with Rust + WebAssembly \u00b7 runs entirely in your browser",
    ),
    version,
  );

  // The footer lives inside the body grid so the sticky sidebar's containing block
  // reaches the bottom of the page; otherwise the sidebar is clamped by the footer
  // height at the end of scroll and slides under the header.
  const el = h("div", { class: "shell" }, header, h("div", { class: "shell__body" }, sidebar, main, footer));

  // Below 840px the sidebar is a horizontal tab bar. Flag which edge still has
  // tabs beyond it so CSS can fade that edge (layout.css).
  function syncEdges() {
    const max = sidebar.scrollWidth - sidebar.clientWidth;
    sidebar.dataset.fadeStart = String(sidebar.scrollLeft > 2);
    sidebar.dataset.fadeEnd = String(max > 2 && sidebar.scrollLeft < max - 2);
  }
  sidebar.addEventListener("scroll", syncEdges, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(syncEdges).observe(sidebar);
  window.addEventListener("resize", syncEdges);

  /**
   * Marks one ready tool as the current page. Soon items are never active.
   * @param {string|null} id
   */
  function setActive(id) {
    active = id;
    for (const [toolId, item] of navItems) {
      const isActive = toolId === id && !item.classList.contains("nav-item--soon");
      item.classList.toggle("is-active", isActive);
      if (isActive) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
  }

  /** @param {string} text empty text hides the slot */
  function setVersion(text) {
    const value = text === null || text === undefined ? "" : String(text);
    version.textContent = value;
    version.hidden = value === "";
  }

  refreshThemeButton();
  setActive(active);

  return {
    el,
    main,
    setActive,
    setVersion,
    privacyButton,
    aboutButton,
    themeButton,
    refreshThemeButton,
  };
}
