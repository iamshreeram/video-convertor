/**
 * Job list section: heading with count, "Clear finished", card container
 * (role=list) and the empty state. Focus is never moved here; removeCard()
 * only reports where focus should go.
 */

import { h, uid } from "../core/dom.js";
import { icon } from "../core/icons.js";

/**
 * @param {Element|null|undefined} card
 * @returns {HTMLElement|null} first enabled action of a card
 */
function firstAction(card) {
  if (!card) return null;
  const target = card.querySelector(".job__actions a[href], .job__actions button:not([disabled])");
  return target instanceof HTMLElement ? target : null;
}

/**
 * @param {{onClearFinished?: () => void}} [options]
 */
export function createJobList({ onClearFinished } = {}) {
  /** @type {Map<string, HTMLElement>} */
  const cards = new Map();
  const headingId = uid("jobs-heading-");

  const countBadge = h("span", {
    class: "count-badge",
    dataset: { testid: "job-count" },
    text: "0",
  });

  const clearButton = h(
    "button",
    {
      class: "btn btn--ghost btn--sm",
      dataset: { testid: "clear-finished" },
      attrs: { type: "button", hidden: true },
      on: {
        click: () => {
          if (typeof onClearFinished === "function") onClearFinished();
        },
      },
    },
    "Clear finished",
  );

  const list = h("div", { class: "job-list__cards", attrs: { role: "list" } });

  const emptyEl = h(
    "div",
    { class: "empty-state", dataset: { testid: "empty-state" } },
    h(
      "div",
      { class: "empty-state__art", attrs: { "aria-hidden": "true" } },
      h("span", { class: "empty-state__badge" }, icon("file", { size: 22 })),
      h("span", { class: "empty-state__badge empty-state__badge--main" }, icon("layers", { size: 26 })),
      h("span", { class: "empty-state__badge" }, icon("video", { size: 22 })),
    ),
    h("p", { class: "empty-state__text" }, "No files yet \u2014 add an MKV above to get started"),
  );

  const el = h(
    "section",
    { class: "job-list", attrs: { "aria-labelledby": headingId } },
    h(
      "div",
      { class: "job-list__head" },
      h(
        "h2",
        { class: "job-list__title", attrs: { id: headingId } },
        "Files",
        countBadge,
      ),
      clearButton,
    ),
    list,
    emptyEl,
  );

  /** Refreshes the count, the empty state and the list visibility. */
  function sync() {
    const total = cards.size;
    countBadge.textContent = String(total);
    emptyEl.hidden = total > 0;
    list.hidden = total === 0;
  }

  /**
   * Appends a card. Replaces an existing card with the same id.
   * @param {HTMLElement} cardEl
   * @param {string} id
   */
  function addCard(cardEl, id) {
    const key = String(id);
    const previous = cards.get(key);
    if (previous && previous !== cardEl) previous.remove();
    cards.set(key, cardEl);
    if (!cardEl.isConnected || cardEl.parentNode !== list) list.appendChild(cardEl);
    sync();
  }

  /**
   * Removes a card and reports the element that should receive focus next:
   * the first action of the following card, else of the previous card, else null.
   * Focus is not moved here.
   * @param {string} id
   * @returns {{nextFocusEl: HTMLElement|null}}
   */
  function removeCard(id) {
    const key = String(id);
    const card = cards.get(key);
    if (!card) return { nextFocusEl: null };
    const siblings = Array.from(list.children);
    const index = siblings.indexOf(card);
    const next = index >= 0 ? siblings[index + 1] : undefined;
    const previous = index > 0 ? siblings[index - 1] : undefined;
    const nextFocusEl = firstAction(next) || firstAction(previous) || null;
    cards.delete(key);
    card.remove();
    sync();
    return { nextFocusEl };
  }

  /** @returns {number} number of cards */
  function count() {
    return cards.size;
  }

  /** @param {boolean} value true shows "Clear finished" */
  function setHasFinished(value) {
    clearButton.hidden = !value;
  }

  sync();

  return { el, addCard, removeCard, count, setHasFinished, emptyEl };
}
