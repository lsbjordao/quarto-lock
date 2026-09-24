import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const locker = path.join(repo, "_extensions", "quarto-lock", "lock.mjs");
const fixture = path.join(here, "fixtures", "site");

function fromBase64Url(s) { return Buffer.from(s, "base64url"); }

function decrypt(payload, key) {
  const iv = payload.subarray(0, 12);
  const bodyAndTag = payload.subarray(12);
  const tag = bodyAndTag.subarray(bodyAndTag.length - 16);
  const ciphertext = bodyAndTag.subarray(0, bodyAndTag.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function build() {
  const work = await mkdtemp(path.join(tmpdir(), "quarto-lock-test-"));
  const site = path.join(work, "_site");
  await cp(fixture, site, { recursive: true });
  const password = "correct horse battery staple";
  const run = spawnSync(process.execPath, [locker], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      QUARTO_PROJECT_OUTPUT_DIR: site,
      QUARTO_PROJECT_RENDER_ALL: "1",
      QUARTO_LOCK_PASSWORD: password,
      QUARTO_LOCK_ITERATIONS: "100000",
    },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return { site, password, stdout: run.stdout };
}

test("locks HTML and local assets without publishing plaintext", async () => {
  const { site } = await build();
  const wrapper = await readFile(path.join(site, "index.html"), "utf8");
  assert.match(wrapper, /Reserved area/);
  assert.doesNotMatch(wrapper, /TOP SECRET QUARTO TEXT/);
  assert.doesNotMatch(wrapper, /Very Secret Title/);
  await assert.rejects(access(path.join(site, "assets", "site.css")));
  await assert.rejects(access(path.join(site, "assets", "app.js")));
  await assert.rejects(access(path.join(site, "assets", "pixel.png")));
  await access(path.join(site, "assets", "site.css.qlock"));
  await access(path.join(site, "assets", "app.js.qlock"));
  await access(path.join(site, "assets", "pixel.png.qlock"));
  await access(path.join(site, "quarto-lock-sw.js"));
  await access(path.join(site, "quarto-lock-bridge.js"));
});

test("published payload decrypts back to the rendered HTML with the correct password", async () => {
  const { site, password } = await build();
  const wrapper = await readFile(path.join(site, "index.html"), "utf8");
  const saltMatch = wrapper.match(/const SALT = "([^"]+)"/);
  const iterMatch = wrapper.match(/const ITERATIONS = (\d+)/);
  assert.ok(saltMatch);
  assert.ok(iterMatch);
  const key = pbkdf2Sync(password, fromBase64Url(saltMatch[1]), Number(iterMatch[1]), 32, "sha256");
  const payload = await readFile(path.join(site, "index.html.qlock"));
  const clear = decrypt(payload, key).toString("utf8");
  assert.match(clear, /TOP SECRET QUARTO TEXT/);
  assert.match(clear, /Very Secret Title/);
  assert.match(clear, /quarto-lock-bridge\.js/);
});

test("wrong password cannot authenticate AES-GCM payload", async () => {
  const { site } = await build();
  const wrapper = await readFile(path.join(site, "index.html"), "utf8");
  const salt = fromBase64Url(wrapper.match(/const SALT = "([^"]+)"/)[1]);
  const iterations = Number(wrapper.match(/const ITERATIONS = (\d+)/)[1]);
  const wrong = pbkdf2Sync("this is the wrong password", salt, iterations, 32, "sha256");
  const payload = await readFile(path.join(site, "index.html.qlock"));
  assert.throws(() => decrypt(payload, wrong));
});

test("ciphertexts use different IVs for different files", async () => {
  const { site } = await build();
  const a = await readFile(path.join(site, "index.html.qlock"));
  const b = await readFile(path.join(site, "nested.html.qlock"));
  assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12));
});

test("no secret fixture strings appear in public clear files", async () => {
  const { site } = await build();
  const publicNames = ["index.html", "nested.html", "quarto-lock-sw.js", "quarto-lock-bridge.js", "robots.txt"];
  const secrets = ["TOP SECRET QUARTO TEXT", "NESTED SECRET TEXT", "SECRET CSS", "SECRET JAVASCRIPT", "Very Secret Title"];
  for (const name of publicNames) {
    const text = await readFile(path.join(site, name), "utf8");
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${secret} leaked in ${name}`);
  }
});
