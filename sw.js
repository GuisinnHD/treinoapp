// Rede primeiro (sempre pega a versão nova); sem internet, usa o cache. Ignora /api/.
const CACHE = "treino-v1";
const BASICO = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICO)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r && (r.ok || r.type === "opaque")) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
