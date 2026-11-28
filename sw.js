/* オフラインでも開けるようにする。
   入口のページ（index.html）は毎回サーバーに確認する（公開したら新しい版に切りかわるように）。
   アプリのファイルは公開のたびに ?v=版 が付くので、同じ名前なら中身は同じ。端末に控えたものをすぐ使う（起動のたびにサーバーへ確認しに行って遅くならないように）。
   画像（アイコンなど）は控えをすぐ使い、裏で新しいものに取りかえる */
const CACHE = "entame-20261123e";
const SHELL = [
  "./",
  "app.css",
  "core.js",
  "view.js",
  "filters.js",
  "paste.js",
  "detail.js",
  "img.js",
  "episodes.js",
  "epaste.js",
  "dropdown.js",
  "form.js",
  "settings.js",
  "yt.js",
  "yt-detail.js",
  "lists.js",
  "anilist.js",
  "tmdb.js",
  "al-ui.js",
  "events.js",
  "helpers.js",
  "boot.js",
  "manifest.json",
  "icon-180.png",
  "icon-192.png",
  "logos/abema.png", "logos/asahi.png", "logos/danime.png", "logos/disney.png", "logos/fuji.png", "logos/lemino.png", "logos/mx.png", "logos/netflix.png",
  "logos/nhk.png", "logos/ntv.png", "logos/prime.png", "logos/tbs.png", "logos/tver.png", "logos/tvtokyo.png", "logos/unext.png",
];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("entame-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET") return;
  const own = u.origin === location.origin;
  const lib = u.hostname === "www.gstatic.com" || u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com";
  if (!own && !lib) return; /* Firebase との通信などは触らない */
  const put = res => { if (res && (res.ok || res.type === "opaque")) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); } return res; };
  const cacheFirst = () => caches.match(r).then(hit => hit || fetch(r).then(put));
  if (lib) return e.respondWith(cacheFirst());
  /* 入口のページ：毎回サーバーに確認（つながらなければ控え） */
  if (r.mode === "navigate" || u.pathname.endsWith("/") || u.pathname.endsWith("/index.html"))
    return e.respondWith(fetch(r.url, { cache: "no-cache", credentials: "same-origin" }).then(put).catch(() => caches.match(r, { ignoreSearch: true }).then(hit => hit || caches.match("./"))));
  /* 版の付いたファイル（?v=）：控えがあればそれ。なければ取ってきて控える */
  if (u.searchParams.has("v")) return e.respondWith(cacheFirst().catch(() => caches.match(r, { ignoreSearch: true })));
  /* そのほか（アイコン・sw.js 以外の版のないファイル）：控えをすぐ使い、裏で取りかえる */
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => { const net = fetch(r).then(put).catch(() => hit); return hit || net; }));
});
