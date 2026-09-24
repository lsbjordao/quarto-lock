#!/usr/bin/env node

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function languageTag(value) {
  const lang = String(value || "en").trim();
  return /^[A-Za-z0-9-]+$/.test(lang) ? lang : "en";
}

async function walkHtml(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) files.push(full);
    }
  }
  await visit(root);
  return files;
}

async function main() {
  const outputDir = path.resolve(process.env.QUARTO_PROJECT_OUTPUT_DIR || "_site");
  try {
    if (!(await stat(outputDir)).isDirectory()) return;
  } catch {
    return;
  }

  const lang = languageTag(process.env.QUARTO_LOCK_LANG);
  const label = escapeHtml(process.env.QUARTO_LOCK_PASSWORD_LABEL || "Password");
  const button = escapeHtml(process.env.QUARTO_LOCK_BUTTON_LABEL || "Unlock");
  const footer = escapeHtml(process.env.QUARTO_LOCK_FOOTER || "Protected by Quarto Lock");
  const incorrect = process.env.QUARTO_LOCK_ERROR_INCORRECT || "Incorrect password.";
  const secureContext = process.env.QUARTO_LOCK_ERROR_SECURE_CONTEXT || "This site must be opened over HTTPS (or localhost).";

  let changed = 0;
  for (const file of await walkHtml(outputDir)) {
    const html = await readFile(file, "utf8");
    if (!html.includes('id="lock-form"') || !html.includes("Quarto Lock")) continue;

    const configured = html
      .replace(/<html lang="[^"]*">/, `<html lang="${lang}">`)
      .replace('<label for="password">Senha</label>', `<label for="password">${label}</label>`)
      .replace('<button id="submit" type="submit">Entrar</button>', `<button id="submit" type="submit">${button}</button>`)
      .replace("Protegido por Quarto Lock", footer)
      .replace('error.textContent = "Senha incorreta.";', `error.textContent = ${JSON.stringify(incorrect)};`)
      .replace(
        'error.textContent = "Este site precisa ser aberto por HTTPS (ou localhost).";',
        `error.textContent = ${JSON.stringify(secureContext)};`
      );

    if (configured !== html) {
      await writeFile(file, configured, "utf8");
      changed++;
    }
  }

  if (changed > 0) {
    console.log(`[quarto-lock] lock UI configured for ${changed} page${changed === 1 ? "" : "s"} (${lang}).`);
  }
}

main().catch((error) => {
  console.error(`[quarto-lock] ERROR: ${error?.stack || error}`);
  process.exitCode = 1;
});
