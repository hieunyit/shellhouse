# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately through GitHub's
"Report a vulnerability" (Security Advisories) on this repository. Include the version
(Settings → About / Diagnostics), OS, and steps to reproduce.

We aim to acknowledge reports within 3 working days and to ship a fix for confirmed high-severity
issues within 30 days. We will credit reporters in the release notes unless asked not to.

## Supported versions

Only the latest release receives security fixes. Auto-update is on by default.

## Scope

In scope: the Shellhouse desktop app, its update channel and release artifacts.
Out of scope: vulnerabilities in remote servers you connect to, and attacks that require an
attacker who already controls your unlocked user account.

## Design summary

- Secrets (passwords, private keys) are encrypted at rest with XChaCha20-Poly1305 under a key
  derived from your master password with Argon2id. They are never written to logs.
- The UI runs in a sandboxed renderer with context isolation, a strict CSP and no Node.js access;
  every IPC call is schema-validated and accepted only from the app's own top-level frame.
- SSH host keys are verified on every connection; a changed key blocks the connection until you
  explicitly confirm.
- Release builds disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` (Electron
  Fuses) and validate the app archive's integrity. Linux update metadata is signed with ed25519.

Details: `docs/adr/0004-ssh-auth-and-secrets.md`, `docs/adr/0006-vault-ux-keys-updates.md`,
`docs/adr/0008-hardening-and-release.md`, `docs/security-review.md`.
