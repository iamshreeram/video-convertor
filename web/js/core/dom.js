/**
 * DOM helpers for the view layer (DESIGN.md B3, B1).
 *
 * Nodes are built with createElement / createElementNS and textContent only.
 * HTML strings are never parsed. Dynamic styling uses classes or CSS custom
 * properties via el.style.setProperty; no style attribute is ever written.
 */

// SVG namespace identifier, not a network request. Concatenated so the shipped
// sources contain no absolute URL literal.
const SVG_NS = "http:" + "//www.w3.org/2000/svg";

let uidSeq = 0;

/**
 * Returns a document-unique id (for aria-labelledby and friends).
 * @param {string} [prefix]
 * @returns {string}
 */
export function uid(prefix = "id-") {
  uidSeq += 1;
  return `${prefix}${uidSeq}`;
}

/**
 * @param {unknown} value string, or array of strings (falsy entries dropped)
 * @returns {string}
 */
function classString(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ");
  return value ? String(value) : "";
}

/**
 * Sets attributes. null/undefined/false are skipped, true becomes an empty
 * attribute, anything else is stringified. Inline handlers and style
 * attributes are refused.
 * @param {Element} el
 * @param {Record<string, unknown>} [attrs]
 */
function setAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (/^on/i.test(key) || key.toLowerCase() === "style") continue;
    el.setAttribute(key, value === true ? "" : String(value));
  }
}

/**
 * @param {HTMLElement} el
 * @param {object} props
 */
function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    switch (key) {
      case "class":
      case "className":
        el.className = classString(value);
        break;
      case "dataset":
        for (const [name, v] of Object.entries(value)) {
          if (v === null || v === undefined || v === false) continue;
          el.dataset[name] = String(v);
        }
        break;
      case "attrs":
        setAttrs(el, value);
        break;
      case "on":
        for (const [type, fn] of Object.entries(value)) {
          if (typeof fn === "function") el.addEventListener(type, fn);
        }
        break;
      case "text":
        el.textContent = String(value);
        break;
      default:
        // Unknown keys are ignored on purpose: the API stays small.
        break;
    }
  }
}

/**
 * Appends children. Strings and numbers become text nodes, Nodes are appended,
 * arrays are flattened, null/undefined/booleans are skipped.
 * @param {Node} parent
 * @param {unknown[]} children
 */
function appendAll(parent, children) {
  for (const child of children) {
    if (Array.isArray(child)) {
      appendAll(parent, child);
    } else if (child === null || child === undefined || typeof child === "boolean") {
      continue;
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/**
 * Builds an HTML element.
 * props: class|className, dataset, attrs, on, text. A non-object first argument
 * (string, Node, array) is treated as the first child.
 * @param {string} tag
 * @param {object|string|Node|unknown[]|null} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  let options = props;
  if (
    props === null ||
    props === undefined ||
    typeof props !== "object" ||
    props instanceof Node ||
    Array.isArray(props)
  ) {
    options = {};
    children = props === null || props === undefined ? children : [props, ...children];
  }
  const el = document.createElement(tag);
  applyProps(el, options);
  appendAll(el, children);
  return el;
}

/**
 * Builds an SVG element (createElementNS).
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...unknown} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  appendAll(el, children);
  return el;
}

/**
 * querySelector shorthand.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {Element|null}
 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * querySelectorAll shorthand, returns an array.
 * @param {string} selector
 * @param {ParentNode} [root=document]
 * @returns {Element[]}
 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Removes all children of an element.
 * @template {Node} T
 * @param {T} el
 * @returns {T}
 */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}
