# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/). Phiên bản theo SemVer.
Mỗi bản phát hành cần một mục `## [x.y.z] - YYYY-MM-DD` — workflow release lấy nội dung mục
này làm ghi chú phát hành (scripts/release-notes.mjs).

## [Unreleased]

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
