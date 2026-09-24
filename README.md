# quarto-lock

Password-lock a rendered **Quarto HTML website or book on static hosting** (including GitHub Pages) without embedding the password in the published files.

`quarto-lock` is intentionally a **lock**, not an account/authentication system. It turns the static output into ciphertext at build time and decrypts it in the browser after the visitor enters the shared password.

## What it protects

Version 0.1 encrypts the local rendered site, not just the HTML:

- HTML pages
- CSS and JavaScript
- images and fonts
- JSON/search indexes
- PDFs, ZIPs and other local downloads

The public site contains only:

- a minimal password screen at each HTML route;
- encrypted `*.qlock` payloads;
- a small service worker/bridge needed to decrypt resources in the browser;
- hosting-control files such as `.nojekyll` and `CNAME`.

External resources (CDNs, remote images, remote APIs) remain external and are not encrypted by quarto-lock.

## Cryptography

- password KDF: PBKDF2-HMAC-SHA-256 (600,000 iterations by default)
- content encryption: AES-256-GCM
- random 128-bit salt per build
- unique random 96-bit IV per protected file
- authenticated ciphertext (GCM tag)
- the password is never written to the HTML, JavaScript, repository, or GitHub Pages artifact

The browser implementation uses the Web Crypto API. Web Crypto is available in secure contexts, so production use should be over HTTPS (GitHub Pages already is).

## Install

From a Quarto project:

```bash
quarto add lsbjordao/quarto-lock
```

Then activate the extension in `_quarto.yml`:

```yaml
filters:
  - quarto-lock
```

The filter itself is intentionally a no-op. Activating it also contributes a project `post-render` step that runs the locker after Quarto finishes rendering.

## Local use

Normal `quarto preview` is **not locked**. This is deliberate: Quarto preview performs incremental renders, while quarto-lock's production build is destructive—it replaces clear output with encrypted payloads.

A full render is locked:

```bash
export QUARTO_LOCK_PASSWORD='use-a-long-shared-password'
quarto render
```

To inspect that locked build locally, serve `_site` directly instead of starting `quarto preview` afterwards:

```bash
python3 -m http.server 3073 -d _site
```

Then open `http://localhost:3073/`.

For this repository's public demo, there is also a convenience command:

```bash
npm run preview:locked
```

It renders a locked build and serves `_site` on port 3073. If `QUARTO_LOCK_PASSWORD` is not set, the repository demo intentionally falls back to the public password `quarto-lock-demo`.

> Important: running `quarto preview` after `quarto render` causes Quarto to render the site again in preview mode, recreating clear HTML. Use the static-server command above (or `npm run preview:locked`) when testing the lock locally.

To force locking outside a full-project render:

```bash
QUARTO_LOCK_FORCE=1 \
QUARTO_LOCK_PASSWORD='use-a-long-shared-password' \
node _extensions/quarto-lock/lock.mjs
```

The password must contain at least 12 UTF-8 bytes. A longer passphrase is strongly recommended.

## GitHub Pages

Keep the source repository private if desired, and add a repository Actions secret:

`Settings → Secrets and variables → Actions → New repository secret`

Name it:

```text
QUARTO_LOCK_PASSWORD
```

A GitHub Pages workflow is included under `.github/workflows/publish.yml`.

The important part is that the secret exists **only while GitHub Actions renders the project**:

```yaml
env:
  QUARTO_LOCK_PASSWORD: ${{ secrets.QUARTO_LOCK_PASSWORD }}
```

Never put the password directly into `_quarto.yml`, a `.qmd` file, JavaScript, or the workflow YAML for real protected content. The public demo in this repository is intentionally an exception.

## Configuration

All configuration in v0.1 is environment-based so secrets and deployment options stay out of the Quarto source.

| Variable | Default | Meaning |
|---|---|---|
| `QUARTO_LOCK_PASSWORD` | required for full render | shared passphrase |
| `QUARTO_LOCK_TITLE` | `Área reservada` | lock-screen title |
| `QUARTO_LOCK_MESSAGE` | `Digite a senha para abrir este conteúdo.` | lock-screen message |
| `QUARTO_LOCK_ITERATIONS` | `600000` | PBKDF2 iteration count; minimum 100000 |
| `QUARTO_LOCK_DISABLED` | false | skip locking |
| `QUARTO_LOCK_FORCE` | false | lock even when Quarto does not report a full render |

## Session behavior

After a successful unlock, the derived AES key—not the password—is kept in `sessionStorage`. Navigation within the same tab therefore stays unlocked. Closing the tab/session discards it.

A new build gets a new salt and build id, so an old session key cannot unlock newly deployed content.

## Security model and limits

This is client-side cryptographic access control for static hosting. Anyone can download the ciphertext, but a strong password is required to decrypt it.

It is **not** equivalent to server-side identity/authentication:

- there are no individual users, roles, audit logs, revocation lists, MFA, or password recovery;
- every person with the shared password has the same access;
- changing/revoking the password requires a rebuild/redeploy;
- password strength matters because attackers can download ciphertext and attempt guesses offline;
- once unlocked, content exists in the visitor's browser and can be copied or saved;
- very large/range-request-heavy media (especially streaming video) is not a primary v0.1 target because the service worker currently decrypts a protected resource as a whole.

For highly sensitive or regulated material, use server-side authentication instead.

## Development

Run the integration tests with Node 20+:

```bash
node --test tests/quarto-lock.test.mjs
```

The crypto/post-render layer has no npm dependencies.

## License

MIT
