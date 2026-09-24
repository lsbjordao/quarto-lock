# quarto-lock

Password-lock a rendered **Quarto HTML website or book on static hosting** (including GitHub Pages) without embedding the password in published files.

`quarto-lock` is intentionally a **lock**, not an account/authentication system. It turns static output into ciphertext at build time and decrypts it in the browser only after the visitor enters the shared password.

## Live demo

The extension repository and documentation are public. The protected demonstration is separate:

**https://lsbjordao.github.io/quarto-lock-demo/**

Demo password:

```text
quarto-lock-demo
```

The password is public on purpose. The demo exists to show that a Quarto source project can remain private while only encrypted static output is exposed publicly.

> Never reuse `quarto-lock-demo` for real protected content.

## Architecture

```text
lsbjordao/quarto-lock
PUBLIC
extension + documentation
        |
        | quarto add lsbjordao/quarto-lock
        v
private Quarto project
*.qmd / data / notebooks / scripts
        |
        | quarto render
        | quarto-lock encrypts
        v
public static host
lock shell + *.qlock ciphertext
        |
        | shared password
        v
browser-side decryption
```

The key deployment principle is:

> **Secrets enter the build; only ciphertext leaves the build.**

## What it protects

Version 0.1 encrypts the local rendered site, not just HTML:

- HTML pages
- CSS and JavaScript
- images and fonts
- JSON/search indexes
- PDFs, ZIPs and other local downloads

The public site contains only a minimal lock screen, encrypted `*.qlock` payloads, a small service-worker/bridge runtime, and hosting-control files such as `.nojekyll`, `CNAME`, and `robots.txt`.

External resources such as CDNs, remote images, and remote APIs remain external and are not encrypted by `quarto-lock`.

## Cryptography

- PBKDF2-HMAC-SHA-256 password derivation
- 600,000 iterations by default
- AES-256-GCM content encryption
- random 128-bit salt per build
- unique random 96-bit IV per protected file
- authenticated ciphertext
- password is never written to generated HTML, JavaScript, or encrypted payloads

## Install

From a Quarto project:

```bash
quarto add lsbjordao/quarto-lock
```

Enable it in the consuming project's `_quarto.yml`:

```yaml
filters:
  - quarto-lock
```

Render with a private password:

```bash
export QUARTO_LOCK_PASSWORD='use-a-long-shared-password'
quarto render
```

## Local locked preview

Normal `quarto preview` is intentionally **not locked** because incremental renders can recreate clear HTML in `_site`.

To inspect a locked build in a consuming project:

```bash
export QUARTO_LOCK_PASSWORD='use-a-long-shared-password'
quarto render
python3 -m http.server 3073 -d _site
```

Then open `http://127.0.0.1:3073/`.

For extension development in this repository:

```bash
npm run preview:locked
```

That command renders the public documentation, explicitly applies the lock to `_site`, and serves it locally. If no password is set, it uses the public test password `quarto-lock-demo`.

## Customize or translate the lock screen

The built-in default interface is English, but every user-facing lock-screen string can be changed without editing the extension source.

Copy the supplied example file into your Quarto project:

```bash
cp .env.example .env
```

`quarto-lock` automatically reads `.env` from the project root. Existing environment variables—including GitHub Actions `env` values and Secrets—take precedence over `.env`.

Example:

```dotenv
QUARTO_LOCK_LANG=en
QUARTO_LOCK_TITLE="Protected content"
QUARTO_LOCK_MESSAGE="Enter the password to unlock this content."
QUARTO_LOCK_PASSWORD_LABEL="Password"
QUARTO_LOCK_BUTTON_LABEL="Unlock"
QUARTO_LOCK_FOOTER="Protected by Quarto Lock"
QUARTO_LOCK_ERROR_INCORRECT="Incorrect password."
QUARTO_LOCK_ERROR_SECURE_CONTEXT="This site must be opened over HTTPS (or localhost)."
```

A Portuguese UI is simply:

```dotenv
QUARTO_LOCK_LANG=pt-BR
QUARTO_LOCK_TITLE="Área reservada"
QUARTO_LOCK_MESSAGE="Digite a senha para abrir este conteúdo."
QUARTO_LOCK_PASSWORD_LABEL="Senha"
QUARTO_LOCK_BUTTON_LABEL="Entrar"
QUARTO_LOCK_FOOTER="Protegido por Quarto Lock"
QUARTO_LOCK_ERROR_INCORRECT="Senha incorreta."
QUARTO_LOCK_ERROR_SECURE_CONTEXT="Este site precisa ser aberto por HTTPS (ou localhost)."
```

See `customize.qmd` for a complete localization guide.

### Why `.env.example` is committed but `.env` is ignored

The UI strings themselves are not secrets. However, `.env` files commonly accumulate credentials later. The repository tracks `.env.example` as documentation and ignores the working `.env` file.

For a real site, keep the password in your shell or a GitHub Actions Secret:

```bash
export QUARTO_LOCK_PASSWORD='your-private-passphrase'
```

Configuration precedence is:

1. existing environment variables / GitHub Actions values;
2. `.env`;
3. built-in English defaults.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `QUARTO_LOCK_PASSWORD` | required for locked render | shared passphrase |
| `QUARTO_LOCK_LANG` | `en` | HTML language tag for the lock shell |
| `QUARTO_LOCK_TITLE` | `Protected content` | lock-screen title |
| `QUARTO_LOCK_MESSAGE` | `Enter the password to unlock this content.` | explanatory text |
| `QUARTO_LOCK_PASSWORD_LABEL` | `Password` | password-field label |
| `QUARTO_LOCK_BUTTON_LABEL` | `Unlock` | submit button text |
| `QUARTO_LOCK_FOOTER` | `Protected by Quarto Lock` | footer text |
| `QUARTO_LOCK_ERROR_INCORRECT` | `Incorrect password.` | wrong-password message |
| `QUARTO_LOCK_ERROR_SECURE_CONTEXT` | HTTPS/localhost warning | Web Crypto availability message |
| `QUARTO_LOCK_ITERATIONS` | `600000` | PBKDF2 iteration count; minimum 100000 |
| `QUARTO_LOCK_DISABLED` | false | skip locking |
| `QUARTO_LOCK_FORCE` | false | force locking outside a full Quarto render |

## GitHub deployment

There are two useful patterns.

### Same repository → GitHub Pages

Use this when the source may be public or your GitHub plan supports Pages from private repositories.

Store the password as a repository Actions Secret named:

```text
QUARTO_LOCK_PASSWORD
```

Then render before uploading the Pages artifact. The extension's post-render step encrypts `_site` before publication.

### Private source → separate public Pages output

This is the most useful pattern when the Quarto source must remain private on GitHub Free.

```text
PRIVATE source repository
        |
        | GitHub Actions
        | QUARTO_LOCK_PASSWORD
        v
quarto render + quarto-lock
        |
        v
PUBLIC Pages repository
only lock shell + ciphertext
```

The public destination repository does not need the `.qmd` source, datasets, notebooks, scripts, or password.

The full `index.qmd` documentation contains complete workflow examples for both patterns.

## Session behavior

After a successful unlock, the derived AES key—not the password—is kept in `sessionStorage`. Navigation within the same tab therefore stays unlocked. Closing the tab/session discards it.

A new build gets a new salt and build id, so an old session key cannot unlock newly deployed content.

## Security model and limits

This is client-side cryptographic access control for static hosting. Anyone can download the ciphertext, but a strong password is required to decrypt it.

It is **not** equivalent to server-side identity/authentication:

- there are no individual users, roles, audit logs, revocation lists, MFA, or password recovery;
- everyone with the shared password has the same access;
- changing/revoking the password requires a rebuild/redeploy;
- password strength matters because ciphertext can be downloaded for offline guessing attempts;
- once unlocked, content exists in the visitor's browser and can be copied or saved;
- very large or range-request-heavy media, especially streaming video, is not a primary v0.1 target because protected resources are currently decrypted as whole files.

For highly sensitive or regulated material, use server-side authentication instead.

## Development

Run the integration tests with Node 20+:

```bash
npm test
```

The crypto/post-render layer has no npm dependencies.

## License

MIT
