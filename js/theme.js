// Applies the chosen light or dark theme before the page paints, so it never flashes.
// "auto" (no attribute) follows the system setting.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem("kassenbuch.prefs") || "{}").theme;
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* storage blocked: follow the system */ }
})();
