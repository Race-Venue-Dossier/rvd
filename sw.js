/* Service Worker: App-Gefühl und Offline-Zugriff (GitHub-Pages-Version).
   Alle Daten bleiben verschlüsselt im Cache; entschlüsselt wird nur in der Seite. */
var V='rvd-b9728cfe25b7',SHELL=['./','index.html','key.json','manifest.webmanifest','icons/apple-touch-icon.png','icons/icon-192.png','icons/favicon.svg','data/core.gz.enc'];
self.addEventListener('install',function(e){ e.waitUntil(caches.open(V).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); })); });
self.addEventListener('activate',function(e){ e.waitUntil(caches.keys().then(function(ks){ return Promise.all(ks.filter(function(k){ return k.indexOf('rvd-')===0&&k!==V&&k!=='rvd-media'&&k!=='rvd-map'; }).map(function(k){ return caches.delete(k); })); }).then(function(){ return self.clients.claim(); })); });
function netFirst(req,cache){
  var key=req.url.split('?')[0];
  var net=fetch(req,{cache:'no-cache'}).then(function(r){ if(r.ok){ var cl=r.clone(); caches.open(cache).then(function(c){ c.put(key,cl); }); } return r; })
    .catch(function(){ return caches.match(key).then(function(m){ return m||(req.mode==='navigate'?caches.match('index.html'):Response.error()); }); });
  /* langsames Netz: nach 3 s gespeicherten Stand zeigen */
  var slow=new Promise(function(res){ setTimeout(function(){ caches.match(key).then(function(m){ if(m) res(m); }); },3000); });
  return Promise.race([net,slow]);
}
function cacheFirst(req,cache,max){
  return caches.open(cache).then(function(c){ return c.match(req).then(function(m){
    var f=fetch(req).then(function(r){ if(r.ok||r.type==='opaque'){ c.put(req,r.clone()); if(max) c.keys().then(function(ks){ if(ks.length>max) ks.slice(0,ks.length-max).forEach(function(k){ c.delete(k); }); }); } return r; });
    return m||f; }); });
}
self.addEventListener('fetch',function(e){
  var req=e.request; if(req.method!=='GET') return;
  var u=new URL(req.url);
  if(u.origin===location.origin){
    if(/\/(img|kurs|gtgpdf|mon|monasset)\//.test(u.pathname)) return e.respondWith(cacheFirst(req,'rvd-media',1500));
    return e.respondWith(netFirst(req,V));
  }
  if(/cdnjs\.cloudflare\.com/.test(u.host)) return e.respondWith(cacheFirst(req,V));
  if(/arcgisonline\.com/.test(u.host)) return e.respondWith(cacheFirst(req,'rvd-map',600));
});
