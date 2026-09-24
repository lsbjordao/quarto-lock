#!/usr/bin/env node

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

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

  let changed = 0;
  for (const file of await walkHtml(outputDir)) {
    let html = await readFile(file, "utf8");

    // Only touch quarto-lock shell pages, never normal Quarto output.
    if (!html.includes('id="lock-form"') || !html.includes("Quarto Lock")) continue;

    const translated = html
      .replace('<html lang="pt-BR">', '<html lang="en">')
      .replace("Área reservada", "Protected content")
      .replace("Digite a senha para abrir este conteúdo.", "Enter the password to unlock this content.")
      .replace('<label for="password">Senha</label>', '<label for="password">Password</label>')
      .replace('<button id="submit" type="submit">Entrar</button>', '<button id="submit" type="submit">Unlock</button>')
      .replace("Protegido por Quarto Lock", "Protected by Quarto Lock")
      .replace('error.textContent = "Senha incorreta.";', 'error.textContent = "Incorrect password.";')
      .replace(
        'error.textContent = "Este site precisa ser aberto por HTTPS (ou localhost).";',
        'error.textContent = "This site must be opened over HTTPS (or localhost).";'
      );

    if (translated !== html) {
      await writeFile(file, translated, "utf8");
      changed++;
    }
  }

  if (changed > 0) {
    console.log(`[quarto-lock] English lock UI applied to ${changed} page${changed === 1 ? "" : "s"}.`);
  }
}

main().catch((error) => {
  console.error(`[quarto-lock] ERROR: ${error?.stack || error}`);
  process.exitCode = 1;
});
