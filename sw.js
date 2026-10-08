// Offline support: the whole app (including the OCR model) is cached on first visit,
// so it starts and works without internet. Bump VERSION with every release.
const VERSION = "kassenbuch-v2";
const FILES = [
  "./", "index.html", "app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "js/main.js", "js/vault.js", "js/util.js", "js/categories.js", "js/learn.js", "js/parse.js", "js/extract.js", "js/process.js", "js/recurring.js",
  "vendor/jszip.min.js", "vendor/pdfjs/pdf.min.js", "vendor/pdfjs/pdf.worker.min.js",
  "vendor/tesseract/tesseract.min.js", "vendor/tesseract/worker.min.js",
  "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js", "vendor/tesseract/core/tesseract-core-lstm.wasm.js",
  "vendor/tesseract/lang/deu.traineddata.gz",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    // cache files that are not in the list (e.g. pdf.js fonts) once they were needed
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});
