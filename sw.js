/* Cache mínimo: la app abre sin conexión con los últimos datos vistos. */
var CACHE = "vigia-59246085";
var APP = ["./", "index.html", "app.css", "app.js", "manifest.json", "icono.svg"];
self.addEventListener("install", function(e){ e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(APP); })); self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(caches.keys().then(function(ks){ return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);})); })); self.clients.claim(); });
self.addEventListener("fetch", function(e){
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // datos: red primero, cache de respaldo
  e.respondWith(fetch(e.request).then(function(r){ var copy=r.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, copy); }); return r; })
    .catch(function(){ return caches.match(e.request, {ignoreSearch:true}); }));
// nota: index.html referencia app.js/app.css con ?v=<hash>; scripts/bump.py lo actualiza en cada cambio
});
