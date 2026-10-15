// Classic (non-module) script: if the app cannot start, say why instead of loading forever.
(function () {
  var errors = [];
  window.addEventListener("error", function (e) { errors.push(e.message || String(e.error || "Unbekannter Fehler")); });
  window.addEventListener("unhandledrejection", function (e) { errors.push(String((e.reason && e.reason.message) || e.reason)); });
  setTimeout(function () {
    var loading = document.getElementById("lock-loading");
    if (!loading || loading.hidden) return; // the app started
    var ios = (navigator.userAgent.match(/OS (\d+)_(\d+)/) || []).slice(1).join(".");
    loading.textContent = "Das Kassenbuch konnte nicht starten. "
      + (ios && parseFloat(ios) < 15.4 ? "Dein iPhone hat iOS " + ios + ", die App braucht iOS 15.4 oder neuer (Einstellungen → Allgemein → Softwareupdate). " : "")
      + "Lade die Seite neu. Hilft das nicht, schicke ein Bildschirmfoto dieser Meldung. "
      + (errors.length ? "Fehler: " + errors.slice(0, 3).join(" | ") : "Browser: " + navigator.userAgent);
    loading.className = "msg err";
  }, 8000);
})();
