/* PaperQuill service worker — offline-first app shell + IndexedDB helpers
 * Cache bump (v9) pushes editable title page, open desktop sidebar, polished sections panel.
 */
const CACHE = 'paperquill-v9';
const IDB_NAME = 'paperquill-sw';
const IDB_VERSION = 1;
const IDB_STORE = 'meta';

/** App shell (same-origin). Paths match typical deploy next to index.html. */
const ASSETS = [
  './',
  './index.html',
  './PaperQuill.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

/** Third-party scripts the writing desk needs offline (export, etc.). */
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js',
  'https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Source+Sans+3:wght@400;500;600&display=swap',
];

/** Online-only APIs — never cache; fail fast offline. */
function isOnlineOnly(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === 'api.languagetool.org' ||
      h === 'api.crossref.org' ||
      h === 'api.openalex.org' ||
      h.endsWith('googleapis.com') ||
      h.endsWith('googleusercontent.com') ||
      h === 'accounts.google.com' ||
      h === 'paperquill.authormasoncarter.com'
    );
  } catch (_) {
    return false;
  }
}

/* ---------- IndexedDB (SW-side metadata / offline queue) ---------- */
function openSwDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openSwDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ key, value, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openSwDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const q = tx.objectStore(IDB_STORE).get(key);
    q.onsuccess = () => resolve(q.result ? q.result.value : null);
    q.onerror = () => reject(q.error);
  });
}

async function queueAdd(entry) {
  const db = await openSwDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    const req = tx.objectStore('queue').add({
      ...entry,
      createdAt: Date.now(),
    });
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() {
  const db = await openSwDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readonly');
    const q = tx.objectStore('queue').getAll();
    q.onsuccess = () => resolve(q.result || []);
    q.onerror = () => reject(q.error);
  });
}

async function queueClear() {
  const db = await openSwDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- Install / activate (push new changes) ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Shell first — add one-by-one so a missing icon does not fail install
      for (const asset of ASSETS) {
        try {
          await cache.add(new Request(asset, { cache: 'reload' }));
        } catch (_) {
          try {
            await cache.add(asset);
          } catch (__) {}
        }
      }
      // Best-effort CDN cache for offline export / fonts
      for (const url of CDN_ASSETS) {
        try {
          const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
          if (res && res.ok) await cache.put(url, res.clone());
        } catch (_) {}
      }
      await idbPut('cacheVersion', CACHE);
      await idbPut('installedAt', Date.now());
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await idbPut('activatedAt', Date.now());
      await self.clients.claim();
      // Tell open tabs a new SW is live
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({ type: 'SW_ACTIVATED', cache: CACHE });
      }
    })()
  );
});

/* ---------- Fetch: offline-first for shell, network for APIs ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  // Never intercept online-only APIs (Drive, LT, DOI, etc.)
  if (isOnlineOnly(url)) return;

  // Navigations: app shell offline fallback
  if (req.mode === 'navigate') {
    e.respondWith(navigationHandler(req));
    return;
  }

  // Same-origin static / cached
  e.respondWith(assetHandler(req));
});

async function navigationHandler(req) {
  // Network-first for HTML so deploys (install button, etc.) reach clients quickly
  try {
    const net = await fetch(req, { cache: 'no-store' });
    if (net && net.ok) {
      const cache = await caches.open(CACHE);
      try {
        await cache.put(req, net.clone());
        await cache.put('./', net.clone());
        await cache.put('./index.html', net.clone());
      } catch (_) {}
      return net;
    }
  } catch (_) {}
  const cached =
    (await caches.match(req)) ||
    (await caches.match('./index.html')) ||
    (await caches.match('./')) ||
    (await caches.match('./PaperQuill.html'));
  if (cached) return cached;
  return new Response(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>PaperQuill offline</title></head><body style="font-family:system-ui;padding:2rem"><h1>Offline</h1><p>PaperQuill shell is not cached yet. Connect once to install the app, then your drafts stay available offline via IndexedDB.</p></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function assetHandler(req) {
  const cached = await caches.match(req);
  if (cached) {
    // Stale-while-revalidate for CDN / fonts
    eRevalidate(req);
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(CACHE);
      try {
        await cache.put(req, res.clone());
      } catch (_) {}
    }
    return res;
  } catch (_) {
    // Offline and not cached
    if (req.destination === 'script' || req.destination === 'style' || req.destination === 'font') {
      return new Response('', { status: 503, statusText: 'Offline' });
    }
    return cached || new Response('', { status: 503, statusText: 'Offline' });
  }
}

function eRevalidate(req) {
  // Fire-and-forget update
  fetch(req)
    .then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
      }
    })
    .catch(() => {});
}

/* ---------- Messages from the page ---------- */
self.addEventListener('message', (e) => {
  const data = e.data || {};
  const reply = (payload) => {
    if (e.ports && e.ports[0]) e.ports[0].postMessage(payload);
    else if (e.source) e.source.postMessage(payload);
  };

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    reply({ ok: true });
    return;
  }

  if (data.type === 'GET_STATUS') {
    (async () => {
      const version = await idbGet('cacheVersion');
      const queue = await queueAll();
      reply({
        ok: true,
        cache: CACHE,
        storedVersion: version,
        queueLength: queue.length,
        offline: !self.navigator?.onLine,
      });
    })().catch((err) => reply({ ok: false, error: String(err) }));
    return;
  }

  if (data.type === 'QUEUE_OFFLINE_ACTION') {
    // Optional: page can enqueue failed network actions for later
    queueAdd(data.action || { kind: 'unknown' })
      .then((id) => reply({ ok: true, id }))
      .catch((err) => reply({ ok: false, error: String(err) }));
    return;
  }

  if (data.type === 'CLEAR_QUEUE') {
    queueClear()
      .then(() => reply({ ok: true }))
      .catch((err) => reply({ ok: false, error: String(err) }));
    return;
  }

  if (data.type === 'CACHE_URLS') {
    const urls = Array.isArray(data.urls) ? data.urls : [];
    (async () => {
      const cache = await caches.open(CACHE);
      for (const u of urls) {
        try {
          const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
          if (res && res.ok) await cache.put(u, res.clone());
        } catch (_) {}
      }
      reply({ ok: true, cached: urls.length });
    })().catch((err) => reply({ ok: false, error: String(err) }));
  }
});

/* ---------- Background sync (when browser supports it) ---------- */
self.addEventListener('sync', (e) => {
  if (e.tag === 'paperquill-flush-queue') {
    e.waitUntil(
      (async () => {
        const items = await queueAll();
        // App data lives in the page's IndexedDB (paperquill-db).
        // This queue is only for optional deferred network actions.
        if (!items.length) return;
        // Notify clients to process queue when online
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          client.postMessage({ type: 'FLUSH_QUEUE', items });
        }
        await queueClear();
      })()
    );
  }
});
