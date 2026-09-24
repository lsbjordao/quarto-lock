import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadDotEnv(env) {
  const file = path.resolve(Deno.cwd(), ".env");
  try {
    const parsed = parseDotEnv(await readFile(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] == null) env[key] = value;
    }
    console.log("[quarto-lock] loaded optional .env configuration.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function withDefaults(env) {
  const defaults = {
    QUARTO_LOCK_LANG: "en",
    QUARTO_LOCK_TITLE: "Protected content",
    QUARTO_LOCK_MESSAGE: "Enter the password to unlock this content.",
    QUARTO_LOCK_PASSWORD_LABEL: "Password",
    QUARTO_LOCK_BUTTON_LABEL: "Unlock",
    QUARTO_LOCK_FOOTER: "Protected by Quarto Lock",
    QUARTO_LOCK_ERROR_INCORRECT: "Incorrect password.",
    QUARTO_LOCK_ERROR_SECURE_CONTEXT: "This site must be opened over HTTPS (or localhost).",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (env[key] == null) env[key] = value;
  }
}

function runNode(script, env) {
  const command = new Deno.Command("node", {
    args: [path.join(here, script)],
    cwd: Deno.cwd(),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = command.outputSync();
  if (!result.success) Deno.exit(result.code || 1);
}

const env = Deno.env.toObject();
await loadDotEnv(env);
withDefaults(env);
runNode("lock.mjs", env);
runNode("ui-config.mjs", env);
