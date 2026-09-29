# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/). Phiên bản theo SemVer.
Mỗi bản phát hành cần một mục `## [x.y.z] - YYYY-MM-DD` — workflow release lấy nội dung mục
này làm ghi chú phát hành (scripts/release-notes.mjs).

## [Unreleased]

### Added

- Import hosts from MobaXterm (`MobaXterm.ini`): SSH sessions with their bookmark folders as
  nested groups, private keys and jump hosts. Other session types are listed as skipped; saved
  passwords are never read.

### Fixed

- Checking for updates while a new release is still being published no longer shows a raw
  HTTP 404 error; update errors are shown as one short sentence (details go to the log).

## [1.0.0-beta.1] - 2026-09-29

First public beta.

### Added

- **Local shells**: pick PowerShell, PowerShell 7, Command Prompt, any WSL distribution, Git Bash
  (Windows) or any shell from `/etc/shells` (macOS/Linux) from the menu next to "+ Terminal";
  choose a default shell in Settings.
- **Nested groups** with drag and drop, recursive host counts, search by group path and safe
  deletion (hosts and subgroups move up).
- **Group defaults**: username, port, SSH key, jump hosts and an environment color that hosts
  inside inherit unless they override them. Production-style environment colors on tabs and the
  session bar.
- **MultiExec**: tile every open terminal on one screen and type into the ones you select.
- **Context menus** for hosts, groups and the terminal (copy, paste, split, SFTP, copy SSH command,
  duplicate, move, tags); multi-select with Ctrl/Shift; favorites, recent hosts and manual ordering.
- **Copy and paste**: terminal menu or PuTTY-style right-click, Ctrl+Insert / Shift+Insert, and a
  standard Cut/Copy/Paste menu in text fields.
- **Legacy algorithms** per host for old switches and routers (ssh-rsa, SHA-1 key exchange, CBC),
  with a "Legacy" badge on the session bar.
- Resizable sidebar; refreshed look (Inter / JetBrains Mono, smoother dialogs and panels).

### Fixed

- Terminal output stays in scrollback when a Windows (ConPTY) session restarts.
- Tabs keep the shell name instead of an `.exe` path on Windows, including elevated shells.
- Keys typed into a new tab while its session is still starting are no longer lost.
- `~/.ssh/...` paths from `~/.ssh/config` are imported with native separators on Windows.
- Much lower GPU memory with many tabs (WebGL only for visible terminals).
- Dialogs no longer lose what you typed when they open while loading.

### Verified

- Real SSH servers: OpenSSH 7.4, 8.2, 9.6, 10.3, Dropbear, legacy-only devices, password + TOTP
  2FA and two-level bastions — from Linux and Windows.

## [0.1.0] - 2026-09-28

### Added

- Local terminal tabs and split panes (xterm.js, WebGL with automatic DOM fallback).
- SSH: saved hosts and groups, quick connect, ProxyJump chains, agent / key / password /
  keyboard-interactive auth, host key verification with change warnings, auto-reconnect.
- Encrypted vault (Argon2id + XChaCha20-Poly1305) for passwords and private keys; auto-lock on
  idle, sleep and screen lock; optional "remember on this device" via the OS keychain.
- Port forwarding (local, remote, dynamic SOCKS5) with auto-start per host.
- SFTP browser with parallel, resumable transfers.
- Key generation (ed25519 / RSA), deploy key to server, `~/.ssh/config` import.
- Snippets with variables, command palette, customizable shortcuts.
- Light and dark themes, terminal color themes, screen reader mode.
- Encrypted backup export and restore; automatic daily database backups.
- Auto-update (signed update channel on Linux).
