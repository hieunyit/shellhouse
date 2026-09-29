# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/). Phiên bản theo SemVer.
Mỗi bản phát hành cần một mục `## [x.y.z] - YYYY-MM-DD` — workflow release lấy nội dung mục
này làm ghi chú phát hành (scripts/release-notes.mjs).

## [Unreleased]

### Added

- Right-click a tab title: Reconnect (Restart shell for local tabs), Duplicate tab, Split,
  Close, Close other tabs. **Ctrl+Shift+R** (⌘⇧R) reconnects the current tab.
- Show / hide the sidebar with the button at the left of the tab bar or **Ctrl+Shift+B** (⌘B).
  Searching hosts shows it again.
- **Open SFTP** on a host now opens a two-pane file manager: your computer on the left, the
  server on the right. Drag between them, double-click a local file to upload, or use the
  Upload / Download buttons; downloads go straight into the open local folder. "Show terminal"
  switches to the shell of the same connection, and "File manager" switches back.

### Changed

- No menu bar on Windows and Linux (File / Edit / View / Window). macOS keeps a minimal menu.
  Developer Tools are no longer available in release builds.

### Fixed

- A connection that drops while the vault is locked (auto-lock) now waits and reconnects as
  soon as you unlock, instead of stopping with "VaultLockedError". Enter also retries a tab
  that could not connect.
- Opening SFTP right after connecting no longer fails with "SFTP is only available on a
  connected built-in SSH session" (same for Deploy key).
- Disk usage in the server statistics bar matches `df` (used / (used + available), rounded up).
- The right-click menu of a tab was cut off by the tab strip; menus now always open fully.
- The server statistics bar stays visible in the two-pane file manager; sizes of 1000 GB and
  more are shown in TB.
- Workspaces and "Duplicate tab" keep a tab in file-manager mode.
- The command palette no longer shows "—" next to commands without a shortcut.

## [1.1.0-beta.2] - 2026-09-29

### Fixed

- Saved hosts with "Automatic" authentication no longer fail with "Failed to retrieve
  identities from agent" when no SSH agent is running (Windows without the OpenSSH
  Authentication Agent service or Pageant). The agent is skipped and the next method is used,
  as OpenSSH does.
- Hosts set to **Password** or **SSH key** authentication use only that stored credential; the
  SSH agent and the default keys in `~/.ssh` are tried only with **Automatic**.

## [1.1.0-beta.1] - 2026-09-29

### Added

- Edit files on a server with your own editor: double-click a file (or **Edit**) in the SFTP
  panel; every save is uploaded back. The original permissions are kept, and if someone else
  changed the file on the server since you opened it, it is not overwritten. Choose the editor
  and the double-click action in Settings → Files.
- Session logs: record everything a session prints to a file, one folder per host (off, SSH
  sessions only, or all sessions). Plain text by default, with colors and control codes removed.
- Server statistics under SSH terminals: CPU, memory, disk, network and uptime of Linux
  servers. Measured over a separate channel (nothing is typed into your shell), only while the
  tab is visible. Can be turned off in Settings → Terminal.
- SFTP: upload and download whole folders (button, or drag a folder from Explorer/Finder).
  Symbolic links inside are skipped; an existing folder is only merged after you confirm.
- Import hosts from CSV (Termius export or any spreadsheet): columns are matched by name,
  groups become nested groups and tags are kept. Password columns are never imported.
- Workspaces: save the current tabs and splits under a name (tab bar → Workspaces) and reopen
  them in one step from the same dialog or the command palette. Hosts deleted since are
  skipped.

### Changed

- Lower latency on SSH connections: keystrokes and SFTP requests are sent immediately
  (TCP_NODELAY, as OpenSSH does). Many small SFTP transfers are several times faster.

## [1.0.0-beta.2] - 2026-09-29

### Added

- Import hosts from MobaXterm (`MobaXterm.ini`): SSH sessions with their bookmark folders as
  nested groups, private keys and jump hosts. Other session types are listed as skipped; saved
  passwords are never read.

### Fixed

- Checking for updates while a new release is still being published no longer shows a raw
  HTTP 404 error; update errors are shown as one short sentence (details go to the log).
- The Windows installer file name has no spaces, so the updater can download it from GitHub
  (`Shellhouse-Setup-<version>.exe`).

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
