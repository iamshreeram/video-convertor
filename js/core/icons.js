/**
 * Inline SVG icons (24x24 stroke icons) and the brand mark, built with svg().
 * Icons are decorative (aria-hidden) unless a label is given.
 */

import { svg } from "./dom.js";

/** Each entry: [tagName, attributes] for the icon's shapes. */
const ICONS = {
  upload: [
    ["path", { d: "M12 16V4" }],
    ["path", { d: "M7 9l5-5 5 5" }],
    ["path", { d: "M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" }],
  ],
  file: [
    ["path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }],
    ["path", { d: "M14 3v5h5" }],
  ],
  video: [
    ["rect", { x: 3, y: 6, width: 13, height: 12, rx: 2 }],
    ["path", { d: "M16 10l5-3v10l-5-3" }],
  ],
  audio: [
    ["path", { d: "M9 18V5l12-2v13" }],
    ["circle", { cx: 6, cy: 18, r: 3 }],
    ["circle", { cx: 18, cy: 16, r: 3 }],
  ],
  check: [["path", { d: "M20 6L9 17l-5-5" }]],
  alert: [
    ["path", { d: "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" }],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }],
  ],
  x: [
    ["path", { d: "M18 6L6 18" }],
    ["path", { d: "M6 6l12 12" }],
  ],
  download: [
    ["path", { d: "M12 3v12" }],
    ["path", { d: "M7 10l5 5 5-5" }],
    ["path", { d: "M5 21h14" }],
  ],
  play: [["path", { d: "M7 4l13 8-13 8z" }]],
  shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }]],
  lock: [
    ["rect", { x: 4, y: 11, width: 16, height: 10, rx: 2 }],
    ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }],
  ],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["path", { d: "M12 2v2" }],
    ["path", { d: "M12 20v2" }],
    ["path", { d: "M4.9 4.9l1.4 1.4" }],
    ["path", { d: "M17.7 17.7l1.4 1.4" }],
    ["path", { d: "M2 12h2" }],
    ["path", { d: "M20 12h2" }],
    ["path", { d: "M4.9 19.1l1.4-1.4" }],
    ["path", { d: "M17.7 6.3l1.4-1.4" }],
  ],
  moon: [["path", { d: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" }]],
  monitor: [
    ["rect", { x: 2, y: 3, width: 20, height: 14, rx: 2 }],
    ["path", { d: "M8 21h8" }],
    ["path", { d: "M12 17v4" }],
  ],
  info: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ],
  trash: [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M8 6V4h8v2" }],
    ["path", { d: "M19 6l-1 14H6L5 6" }],
  ],
  "chevron-down": [["path", { d: "M6 9l6 6 6-6" }]],
  clock: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 6v6l4 2" }],
  ],
  layers: [
    ["path", { d: "M12 2L2 7l10 5 10-5-10-5z" }],
    ["path", { d: "M2 17l10 5 10-5" }],
    ["path", { d: "M2 12l10 5 10-5" }],
  ],
};

/** Shape names accepted by icon(). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Builds a stroke icon.
 * @param {string} name one of ICON_NAMES (unknown names fall back to "info")
 * @param {{size?: number, label?: string}} [options] label makes it a named image
 * @returns {SVGElement}
 */
export function icon(name, { size = 20, label } = {}) {
  const parts = ICONS[name] || ICONS.info;
  const attrs = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    class: "icon",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.75,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  };
  const children = parts.map(([tag, shape]) => svg(tag, shape));
  if (label) {
    attrs.role = "img";
    children.unshift(svg("title", {}, String(label)));
  } else {
    attrs["aria-hidden"] = "true";
  }
  return svg("svg", attrs, ...children);
}

/**
 * Brand mark: rounded square with a play triangle. Colours come from the
 * .logo-mark__bg / .logo-mark__fg classes (components.css).
 * @param {{size?: number}} [options]
 * @returns {SVGElement}
 */
export function logoMark({ size = 28 } = {}) {
  return svg(
    "svg",
    {
      viewBox: "0 0 32 32",
      width: size,
      height: size,
      class: "logo-mark",
      "aria-hidden": "true",
      focusable: "false",
    },
    svg("rect", { class: "logo-mark__bg", x: 0, y: 0, width: 32, height: 32, rx: 9 }),
    svg("path", { class: "logo-mark__fg", d: "M13 10.5v11l9-5.5z" }),
  );
}
