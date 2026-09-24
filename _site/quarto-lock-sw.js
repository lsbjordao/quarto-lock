const BUILD_ID = "e1420d06f7412718";
let rawKeyB64 = null;
let cryptoKey = null;
let keyWaiters = [];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importCurrentKey() {
  if (cryptoKey) return cryptoKey;
  if (!rawKeyB64) return null;
  cryptoKey = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(rawKeyB64),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  return cryptoKey;
}

function resolveWaiters() {
  for (const resolve of keyWaiters) resolve();
  keyWaiters = [];
}

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg?.type !== "QUARTO_LOCK_SET_KEY" || msg?.buildId !== BUILD_ID || !msg?.key) return;
  rawKeyB64 = msg.key;
  cryptoKey = null;
  resolveWaiters();
  event.source?.postMessage({ type: "QUARTO_LOCK_KEY_ACK", buildId: BUILD_ID });
});

async function requestKey() {
  if (rawKeyB64) return;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "QUARTO_LOCK_NEED_KEY", buildId: BUILD_ID });
  }
  if (rawKeyB64) return;
  await Promise.race([
    new Promise((resolve) => keyWaiters.push(resolve)),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
}

function mimeType(pathname) {
  const ext = pathname.toLowerCase().split(".").pop();
  return ({
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    pdf: "application/pdf",
    wasm: "application/wasm",
    woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", otf: "font/otf",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm",
    zip: "application/zip",
  })[ext] || "application/octet-stream";
}

async function decryptPayload(buffer, key) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 29) throw new Error("Invalid quarto-lock payload");
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12); // ciphertext includes the 16-byte GCM tag
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
}

function isPublicRuntime(url) {
  return url.pathname.endsWith("/quarto-lock-sw.js") ||
    url.pathname.endsWith("/quarto-lock-bridge.js") ||
    url.pathname.endsWith("/.nojekyll") ||
    url.pathname.endsWith("/CNAME") ||
    url.pathname.endsWith("/robots.txt") ||
    url.pathname.endsWith(".qlock");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate" || isPublicRuntime(url)) return;

  event.respondWith((async () => {
    await requestKey();
    const key = await importCurrentKey();
    if (!key) return new Response("Locked", { status: 423 });

    const encryptedUrl = new URL(url.href);
    encryptedUrl.pathname += ".qlock";
    encryptedUrl.searchParams.set("qlock-build", BUILD_ID);

    const encrypted = await fetch(encryptedUrl, { cache: "no-store", credentials: "same-origin" });
    if (!encrypted.ok) {
      return new Response("Protected resource not found", { status: 404 });
    }

    try {
      const clear = await decryptPayload(await encrypted.arrayBuffer(), key);
      return new Response(clear, {
        status: 200,
        headers: {
          "Content-Type": mimeType(url.pathname),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Unable to decrypt protected resource", { status: 403 });
    }
  })());
});
