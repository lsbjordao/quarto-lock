#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEMO_PASSWORD = "quarto-lock-demo";
const host = process.env.QUARTO_LOCK_PREVIEW_HOST || "127.0.0.1";
const port = Number(process.env.QUARTO_LOCK_PREVIEW_PORT || 3073);
const root = path.resolve(process.cwd(), "_site");

const password = process.env.QUARTO_LOCK_PASSWORD || DEMO_PASSWORD;
if (!process.env.QUARTO_LOCK_PASSWORD) {
  console.log(`[quarto-lock] QUARTO_LOCK_PASSWORD not set; using public demo password: ${DEMO_PASSWORD}`);
}

console.log("[quarto-lock] rendering documentation site...");
const render = spawnSync("quarto", ["render"], {
  stdio: "inherit",
  env: { ...process.env, QUARTO_LOCK_DISABLED: "1" },
});

if (render.error) {
  console.error(`[quarto-lock] unable to run Quarto: ${render.error.message}`);
  process.exit(1);
}
if (render.status !== 0) process.exit(render.status ?? 1);

console.log("[quarto-lock] applying lock to rendered output...");
const lock = spawnSync(process.execPath, ["_extensions/quarto-lock/run.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    QUARTO_LOCK_PASSWORD: password,
    QUARTO_LOCK_FORCE: "1",
    QUARTO_PROJECT_OUTPUT_DIR: root,
  },
});

if (lock.error) {
  console.error(`[quarto-lock] unable to run locker: ${lock.error.message}`);
  process.exit(1);
}
if (lock.status !== 0) process.exit(lock.status ?? 1);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".qlock": "application/octet-stream",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative || "index.html");
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

const server = createServer(async (req, res) => {
  try {
    let file = safePath(req.url || "/");
    if (!file) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const info = await stat(file);
      if (info.isDirectory()) file = path.join(file, "index.html");
    } catch {
      if (!path.extname(file)) file += ".html";
    }

    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`[quarto-lock] locked preview: http://${host}:${port}/`);
  console.log(`[quarto-lock] demo password: ${password === DEMO_PASSWORD ? DEMO_PASSWORD : "(from QUARTO_LOCK_PASSWORD)"}`);
  console.log("[quarto-lock] press Ctrl+C to stop");
});
