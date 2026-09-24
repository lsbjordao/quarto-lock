#!/usr/bin/env node

import {
  createCipheriv,
  pbkdf2Sync,
  randomBytes,
  createHash,
} from "node:crypto";
import {
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VERSION = "0.1.0";
const MAGIC = "quarto-lock";
const DEFAULT_ITERATIONS = 600_000;
const PUBLIC_FILES = new Set([
  ".nojekyll",
  "CNAME",
  "quarto-lock-sw.js",
  "quarto-lock-bridge.js",
  "robots.txt",
]);

function log(message) {
  console.log(`[quarto-lock] ${message}`);
}

function fail(message) {
  console.error(`[quarto-lock] ERROR: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function deriveKey(password, salt, iterations) {
  return pbkdf2Sync(password, salt, iterations, 32, "sha256");
}

function encryptBuffer(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // File format v1: 12-byte IV || ciphertext || 16-byte GCM tag
  return Buffer.concat([iv, ciphertext, tag]);
}

async function walkFiles(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  await visit(root);
  return result;
}

async function removeOldLockArtifacts(root) {
  for (const file of await walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (
      rel.endsWith(".qlock") ||
      rel === "quarto-lock-sw.js" ||
      rel === "quarto-lock-bridge.js"
    ) {
      await rm(file, { force: true });
    }
  }
}

function relativeRootFor(relHtml) {
  const dir = path.posix.dirname(relHtml);
  if (dir === ".") return "./";
  const depth = dir.split("/").filter(Boolean).length;
  return "../".repeat(depth);
}

function bridgeScript(buildId) {
  return `(() => {
  const BUILD_ID = ${JSON.stringify(buildId)};
  const KEY_NAME = "quarto-lock:key:" + BUILD_ID;

  function rawKey() {
    try { return sessionStorage.getItem(KEY_NAME); } catch { return null; }
  }

  function sendKey(target) {
    const key = rawKey();
    if (!key || !target) return;
    target.postMessage({ type: "QUARTO_LOCK_SET_KEY", buildId: BUILD_ID, key });
  }

  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "QUARTO_LOCK_NEED_KEY" && event.data?.buildId === BUILD_ID) {
      sendKey(event.source || navigator.serviceWorker.controller);
    }
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    sendKey(navigator.serviceWorker.controller);
  });

  sendKey(navigator.serviceWorker.controller);
})();
`;
}

function serviceWorkerScript(buildId) {
  return `const BUILD_ID = ${JSON.stringify(buildId)};
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
`;
}

function injectBridge(originalHtml, rootRel, buildId) {
  const src = `${rootRel}quarto-lock-bridge.js`;
  const tag = `<script src="${src}" data-quarto-lock-build="${escapeHtml(buildId)}"></script>`;
  const lower = originalHtml.toLowerCase();
  const headEnd = lower.indexOf("</head>");
  if (headEnd >= 0) return originalHtml.slice(0, headEnd) + tag + originalHtml.slice(headEnd);
  return tag + originalHtml;
}

function lockWrapper({ relHtml, rootRel, saltB64, iterations, buildId, title, message }) {
  const payloadName = path.posix.basename(relHtml) + ".qlock";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const rootJson = JSON.stringify(rootRel);
  const payloadJson = JSON.stringify(payloadName);

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f5f7; --card:#fff; --fg:#161617; --muted:#6e6e73; --line:#d2d2d7; --accent:#111; --danger:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f10; --card:#18181a; --fg:#f5f5f7; --muted:#a1a1a6; --line:#38383a; --accent:#f5f5f7; --danger:#ff8a80; } }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; background:var(--bg); color:var(--fg); font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  body { min-height:100vh; display:grid; place-items:center; padding:24px; }
  .ql-card { width:min(100%,420px); background:var(--card); border:1px solid var(--line); border-radius:18px; padding:30px; box-shadow:0 18px 50px rgba(0,0,0,.08); }
  .ql-mark { width:44px; height:44px; border:1px solid var(--line); border-radius:12px; display:grid; place-items:center; margin-bottom:20px; font-size:21px; }
  h1 { margin:0 0 8px; font-size:1.45rem; letter-spacing:-.02em; }
  p { margin:0 0 24px; color:var(--muted); line-height:1.5; }
  label { display:block; margin-bottom:8px; font-size:.9rem; font-weight:650; }
  .ql-row { display:flex; gap:8px; }
  input { min-width:0; flex:1; border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:10px; padding:12px 13px; font:inherit; outline:none; }
  input:focus { border-color:var(--fg); box-shadow:0 0 0 3px color-mix(in srgb,var(--fg) 12%,transparent); }
  button { border:0; border-radius:10px; padding:12px 16px; font:inherit; font-weight:700; background:var(--accent); color:var(--bg); cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  #error { min-height:1.3em; margin:12px 0 0; font-size:.88rem; color:var(--danger); }
  .ql-foot { margin-top:22px; font-size:.76rem; color:var(--muted); }
</style>
</head>
<body>
<main class="ql-card" aria-labelledby="ql-title">
  <div class="ql-mark" aria-hidden="true">&#128274;</div>
  <h1 id="ql-title">${safeTitle}</h1>
  <p>${safeMessage}</p>
  <form id="lock-form">
    <label for="password">Senha</label>
    <div class="ql-row">
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button id="submit" type="submit">Entrar</button>
    </div>
    <div id="error" role="alert" aria-live="polite"></div>
  </form>
  <div class="ql-foot">Protegido por Quarto Lock</div>
</main>
<script>
(() => {
  "use strict";
  const BUILD_ID = ${JSON.stringify(buildId)};
  const SALT = ${JSON.stringify(saltB64)};
  const ITERATIONS = ${iterations};
  const ROOT_REL = ${rootJson};
  const PAYLOAD = ${payloadJson};
  const KEY_NAME = "quarto-lock:key:" + BUILD_ID;
  const form = document.getElementById("lock-form");
  const input = document.getElementById("password");
  const button = document.getElementById("submit");
  const error = document.getElementById("error");

  function fromBase64Url(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBase64Url(bytes) {
    let bin = "";
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  }

  async function derive(password) {
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name:"PBKDF2", salt:fromBase64Url(SALT), iterations:ITERATIONS, hash:"SHA-256" },
      material,
      { name:"AES-GCM", length:256 },
      true,
      ["decrypt"]
    );
  }

  async function importSessionKey(encoded) {
    return crypto.subtle.importKey("raw", fromBase64Url(encoded), { name:"AES-GCM" }, true, ["decrypt"]);
  }

  async function decryptPayload(key) {
    const url = new URL(PAYLOAD, location.href);
    url.searchParams.set("qlock-build", BUILD_ID);
    const response = await fetch(url, { cache:"no-store", credentials:"same-origin" });
    if (!response.ok) throw new Error("payload");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 29) throw new Error("payload");
    const iv = bytes.slice(0, 12);
    const data = bytes.slice(12);
    const clear = await crypto.subtle.decrypt({ name:"AES-GCM", iv }, key, data);
    return new TextDecoder().decode(clear);
  }

  async function ensureServiceWorker(rawKey) {
    if (!("serviceWorker" in navigator)) throw new Error("service-worker");
    const root = new URL(ROOT_REL, location.href);
    const swUrl = new URL("quarto-lock-sw.js", root);
    const registration = await navigator.serviceWorker.register(swUrl, { scope: root.pathname });
    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once:true })),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }

    const target = navigator.serviceWorker.controller || registration.active;
    target?.postMessage({ type:"QUARTO_LOCK_SET_KEY", buildId:BUILD_ID, key:rawKey });
  }

  async function unlockWithKey(key) {
    const clearHtml = await decryptPayload(key);
    const raw = await crypto.subtle.exportKey("raw", key);
    const encoded = toBase64Url(raw);
    try { sessionStorage.setItem(KEY_NAME, encoded); } catch {}
    await ensureServiceWorker(encoded);
    document.open();
    document.write(clearHtml);
    document.close();
  }

  async function trySession() {
    let encoded = null;
    try { encoded = sessionStorage.getItem(KEY_NAME); } catch {}
    if (!encoded) return false;
    try {
      await unlockWithKey(await importSessionKey(encoded));
      return true;
    } catch {
      try { sessionStorage.removeItem(KEY_NAME); } catch {}
      return false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    error.textContent = "";
    try {
      const key = await derive(input.value);
      await unlockWithKey(key);
    } catch {
      error.textContent = "Senha incorreta.";
      input.select();
      button.disabled = false;
    }
  });

  if (!window.isSecureContext || !window.crypto?.subtle) {
    error.textContent = "Este site precisa ser aberto por HTTPS (ou localhost).";
    button.disabled = true;
    return;
  }

  trySession().then((unlocked) => {
    if (!unlocked) input.focus();
  });
})();
</script>
</body>
</html>`;
}

async function main() {
  if (envBool("QUARTO_LOCK_DISABLED")) {
    log("disabled by QUARTO_LOCK_DISABLED; leaving rendered output unchanged.");
    return;
  }

  const isFullRender = process.env.QUARTO_PROJECT_RENDER_ALL === "1";
  if (!isFullRender && !envBool("QUARTO_LOCK_FORCE")) {
    log("skipping incremental/preview render (set QUARTO_LOCK_FORCE=1 to force locking).");
    return;
  }

  const password = process.env.QUARTO_LOCK_PASSWORD;
  if (!password) fail("QUARTO_LOCK_PASSWORD is required for a full locked render.");
  if (Buffer.byteLength(password, "utf8") < 12) {
    fail("QUARTO_LOCK_PASSWORD must contain at least 12 UTF-8 bytes.");
  }

  const iterations = Number.parseInt(process.env.QUARTO_LOCK_ITERATIONS || `${DEFAULT_ITERATIONS}`, 10);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) {
    fail("QUARTO_LOCK_ITERATIONS must be an integer >= 100000.");
  }

  const outputDir = path.resolve(process.env.QUARTO_PROJECT_OUTPUT_DIR || "_site");
  try {
    if (!(await stat(outputDir)).isDirectory()) fail(`output directory not found: ${outputDir}`);
  } catch {
    fail(`output directory not found: ${outputDir}`);
  }

  await removeOldLockArtifacts(outputDir);

  const salt = randomBytes(16);
  const key = deriveKey(password, salt, iterations);
  const buildSeed = Buffer.concat([salt, randomBytes(16), Buffer.from(String(Date.now()))]);
  const buildId = createHash("sha256").update(buildSeed).digest("hex").slice(0, 16);
  const title = process.env.QUARTO_LOCK_TITLE || "Área reservada";
  const message = process.env.QUARTO_LOCK_MESSAGE || "Digite a senha para abrir este conteúdo.";

  const files = await walkFiles(outputDir);
  const candidates = files.filter((file) => {
    const rel = path.relative(outputDir, file).split(path.sep).join("/");
    if (PUBLIC_FILES.has(rel)) return false;
    if (rel.endsWith(".qlock")) return false;
    return true;
  });

  let encryptedCount = 0;
  let encryptedBytes = 0;
  const htmlFiles = [];

  // Encrypt first, then replace/remove clear files only after every payload exists.
  for (const file of candidates) {
    const rel = path.relative(outputDir, file).split(path.sep).join("/");
    const clear = await readFile(file);
    let payloadClear = clear;
    if (rel.toLowerCase().endsWith(".html")) {
      const rootRel = relativeRootFor(rel);
      payloadClear = Buffer.from(injectBridge(clear.toString("utf8"), rootRel, buildId), "utf8");
      htmlFiles.push({ file, rel, rootRel });
    }
    const encrypted = encryptBuffer(payloadClear, key);
    await writeFile(`${file}.qlock`, encrypted);
    encryptedCount++;
    encryptedBytes += clear.byteLength;
  }

  await writeFile(path.join(outputDir, "quarto-lock-sw.js"), serviceWorkerScript(buildId), "utf8");
  await writeFile(path.join(outputDir, "quarto-lock-bridge.js"), bridgeScript(buildId), "utf8");
  await writeFile(path.join(outputDir, "robots.txt"), "User-agent: *\nDisallow: /\n", "utf8");

  // HTML paths remain as public lock shells so static hosts can navigate normally.
  const htmlSet = new Set(htmlFiles.map(({ file }) => file));
  for (const { file, rel, rootRel } of htmlFiles) {
    await writeFile(file, lockWrapper({
      relHtml: rel,
      rootRel,
      saltB64: toBase64Url(salt),
      iterations,
      buildId,
      title,
      message,
    }), "utf8");
  }

  // Everything else must exist only as ciphertext.
  for (const file of candidates) {
    if (!htmlSet.has(file)) await rm(file, { force: true });
  }

  log(`locked ${encryptedCount} files (${encryptedBytes.toLocaleString("en-US")} clear bytes) in ${outputDir}`);
  log(`build ${buildId}; PBKDF2-SHA256 ${iterations.toLocaleString("en-US")} iterations; AES-256-GCM`);
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error(`[quarto-lock] ERROR: ${error?.stack || error}`);
    process.exitCode = 1;
  }
});
