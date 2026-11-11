/*
 * First-paint theme. A classic script in <head>, before the stylesheets, so the
 * page never paints in the wrong theme. Mirrors core/theme.js (the runtime
 * owner: cycle, persist, follow OS changes). Keep the storage key and the
 * attribute names identical to theme.js.
 */
(function () {
  var root = document.documentElement;
  var pref = "auto";
  try {
    var stored = window.localStorage.getItem("convertor.theme");
    if (stored === "light" || stored === "dark") pref = stored;
  } catch (error) {
    // Storage blocked: follow the OS preference below.
  }
  var osDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var resolved = pref === "auto" ? (osDark ? "dark" : "light") : pref;
  root.setAttribute("data-theme", resolved);
  root.setAttribute("data-theme-pref", pref);
})();
