# Changelog

Định dạng theo [Keep a Changelog](https://keepachangelog.com/). Phiên bản theo SemVer.
Mỗi bản phát hành cần một mục `## [x.y.z] - YYYY-MM-DD` — workflow release lấy nội dung mục
này làm ghi chú phát hành (scripts/release-notes.mjs).

## [Unreleased]

## [1.2.0-beta.20] - 2026-10-06

### Added

- Kubernetes: **Timeline** tab for Deployments, StatefulSets and DaemonSets — rollouts (with the
  image that changed), pods created, containers that crashed (OOMKilled, exit code), ConfigMaps /
  Secrets edited, node Ready / NotReady changes and events on one time axis, filterable by lane and
  by the last hour / 24 hours / 7 days. “What changed before?” jumps to the 30 minutes before the
  last crash. For clusters monitored on Home, events are recorded on this computer and kept for 7
  days (the cluster itself keeps them for about an hour).

- Home › **Infrastructure**: when Shellhouse starts it connects read-only to your Production
  Kubernetes clusters and Docker hosts (or any you mark “Monitor on Home” in their right-click
  menu) and shows their status — Kubernetes version and end-of-support date, nodes ready, failing
  pods, API server and kubeconfig client certificates about to expire; Docker containers running,
  restarting, unhealthy or exited with an error. Checked every 3 minutes, never asks for a password
  (a host that needs one shows “Needs sign-in”). Problems of monitored clusters appear in “Needs
  attention” without opening a tab. Turn it off in Settings › Appearance › Home.

- Kubernetes Map › Topology finds more broken links: an IngressClass that does not exist (or no
  class and no default one), two Ingresses claiming the same host / path, TLS certificates that
  expired or expire within 14 days, and PodDisruptionBudgets that allow no disruptions (node drains
  would hang). Every problem now comes with a one-line hint on how to fix it.

## [1.2.0-beta.19] - 2026-10-06

### Added

- Home › **Needs attention**: problems from the Kubernetes clusters you have open — crash-looping /
  failing pods, image pull errors, NotReady nodes, long-pending pods, unbound volumes (checked
  every minute only while the cluster tab is open, nothing runs in the background), sorted by
  severity; click an item to open it. Dropped sessions are no longer listed there. Can be turned
  off in Settings › Appearance › Home.

### Fixed

- Kubernetes: an open workload / resource tab now refreshes by itself — the pods of a workload
  and related resources reload every 10 seconds, and the whole list reloads when you come back to
  a tab that was hidden for a while (no more pressing Refresh).

## [1.2.0-beta.18] - 2026-10-06

### Added

- Log viewer (Kubernetes, Docker): regular-expression search (the `.*` button next to the search
  box; an invalid pattern is reported instead of filtering), matches highlighted in each line,
  error and warning lines colored (ERROR / WARN, `level=error`, JSON `"level":"warn"`, klog
  `E1006`, `[error]`, stack traces…) with "N errors" / "N warnings" chips to show only those lines.

## [1.2.0-beta.17] - 2026-10-05

### Added

- Kubernetes: live traffic from **Hubble** on Cilium clusters — no Caretta needed. Shellhouse
  follows Hubble Relay's flow stream through the API server (port-forward), counts new connections
  per pair of workloads and shows them as connections per second (Hubble has no byte counts);
  external destinations show their DNS name when Cilium's DNS visibility is on. When both are
  installed, Hubble is used.

### Fixed

- Kubernetes: "r.items is not iterable" on Helm releases (and missing counts / Map data) when a
  namespace has nothing of that kind — the API server answers an empty metadata-only list with
  `items: null`.
- Kubernetes Topology: hiding "live traffic" removed its chip, so it could not be turned back on
  without leaving the tab.

## [1.2.0-beta.16] - 2026-10-05

### Changed

- Kubernetes sidebar is back to resource groups (Workloads, Service Discovery, Storage…) with the
  namespace picked in the header — easier than the per-namespace tree. "N failing" stays next to
  Pods and Deployments.

## [1.2.0-beta.15] - 2026-10-05

### Fixed

- With no open sessions, the "No open sessions" panel covered Home and other pages.
- The date on Home followed the system language instead of the app language.
- Clicking Files with two or more sessions open jumped back to Hosts.

### Changed

- Closer to the v0.5 design: the command center is centered in the title bar (⌘K on macOS;
  Search hosts moves to ⌘⇧K), Kubernetes / Docker / S3 follow Files on the activity bar, interface
  text uses Inter like the design (host and resource names are no longer monospaced), every page
  has a header with its icon and breadcrumb, Settings has a search box and a short description
  per page.
- Session tabs: the open tab is highlighted, "+ Terminal" sits right after the tabs, Split and
  MultiExec on the right of the tab bar; the session bar uses icon buttons (SFTP and Forwarding
  keep their labels).
- Transfers lists transfers by state (Failed, Active, Queued, Completed) with the route
  (from → to), progress and speed, and filters by name, source and direction.
- Home shows "Start something new" only until you have recent or favorite hosts.
- Kubernetes sidebar follows the design: Overview, Map, Helm releases and Nodes for the cluster,
  then the namespaces — the namespace you are viewing opens its common resources (Pods,
  Deployments, Services…) with counts; everything else is under "More resources". Create is a
  quiet button.
- S3: the filter sits at the start of the toolbar and Upload / New bucket at its end; the path
  starts with "S3 storage"; accounts in the sidebar take one line (the endpoint is in the tooltip).
- Files opens "This computer" when no session has its file manager open, instead of showing a
  terminal.
- Server stats (CPU, memory, disk) sit on the session bar; network and uptime are in its tooltip.

### Added

- Notifications: a bell on the status bar counts new messages and lists the recent ones.
- Your initials on the activity bar (click to lock the vault).
- Transfers: Pause all / Resume all for SFTP transfers (paused transfers keep their partial file
  and continue where they stopped).
- Kubernetes: "N failing" next to namespaces, Pods and Deployments; Status and Node chips to filter
  Pods; a Live indicator while the table follows changes.
- S3: expand an account in the sidebar to list its buckets; click a bucket to open it.
- Windows / Linux: Ctrl+K opens the command palette (inside a terminal Ctrl+K still goes to the
  shell; Ctrl+Shift+P works everywhere).

## [1.2.0-beta.14] - 2026-10-05

### Changed

- **New interface (design v0.5)** is now the interface — no setting to turn it on:
  - Custom 38 px title bar with back / forward, a command center (Ctrl+Shift+P) and Quick connect
    (Ctrl+Shift+O: saved host names, `user@host:port` or an `ssh` command; Alt+Enter opens it
    split).
  - Activity bar: Home, Hosts, Files, one area per module (Kubernetes, Docker, S3), Transfers,
    Settings. Click the current area again (or Ctrl+Shift+B) to hide / show its sidebar.
  - Context sidebar (Explorer) per area: host tree, pinned / recent hosts, file managers, clusters
    / endpoints / accounts together with the module's own navigation (Pods, Containers…).
  - Kubernetes, Docker and S3 tabs open in their own area instead of between terminal tabs; closing
    a tab you opened from somewhere else takes you back there.
  - Settings is a page (Esc goes back) with a table of contents; Transfers collects every SFTP /
    S3 upload and download with status filters; the status bar shows sessions, the vault and
    transfer progress.
  - Home: greeting, quick connect, Favorites, Recent, dropped sessions and "get started" links.
  - Calmer colors: semantic status colors only (green healthy, amber warning, red failing, blue
    progress), teal reserved for actions / focus / selection, one-line host rows with monochrome OS
    icons, pill-shaped session tabs, neutral selected rows, 11 px minimum text, control borders that
    meet 3:1 contrast, softer "Match app" terminal colors.

### Removed

- The Windows Remote Desktop engine (`shellhouse-rdp-host.exe`, the mstsc control) and the
  "Remote Desktop engine" choice in the host form: Remote Desktop tabs always use the built-in
  viewer (IronRDP). Opening a host in the system's RDP client is unchanged.

### Added

- **Environments** (Settings → Environments): Production, Staging, Development, Test — or your
  own — with a short label, highlighted or neutral style, an optional line at the top of the
  content, how deleting is confirmed and read-only by default. Set one on a host group (subgroups
  and hosts inherit it), a Kubernetes context, a Docker endpoint or an S3 account (right-click →
  Environment). Production asks you to type the resource name before deleting (Kubernetes, Docker);
  leaving it asks first and offers Undo. Groups or contexts that only had a color keep their
  environment.
- Pick the environment while importing kubeconfig contexts; a Docker endpoint over SSH takes the
  environment of its host unless you set one.
- **Files → This computer**: browse local files without opening a session.
- Quick connect understands `ssh -J jump user@host` (the jump host can be a saved host or
  `user@host:port`); "Save as host" keeps the jump.
- Label selector errors in Kubernetes are translated.
- **Focus mode** (Ctrl+Shift+Enter or the ⤢ button): only the terminal and the title bar; a small
  pill shows where you are and exits. Esc stays with vim / less.
- **Copy as command**: Pods, Deployments… (kubectl with the right context / namespace /
  kubeconfig), containers (docker with `-H ssh://…` or WSL) and S3 objects (aws with profile /
  endpoint) — plus `kubectl get` for the current list.
- **Label selector** in the Kubernetes filter: `app=web`, `tier!=data`, `app in (web,api)`,
  `!canary` (or `-l …`), with clear errors; copied commands keep the selector.
- Kubernetes logs: time range (5 m – 24 h), logs of several selected pods in one tab, and the
  equivalent `kubectl logs` command at the bottom.
- **Export hosts** (Shellhouse YAML with groups and environments, OpenSSH config, CSV) for all or one
  group — never passwords or keys; Import reads Shellhouse YAML back.
- Quick connect: Ctrl+Enter saves the typed address as a new host.
- Group rows: a ⋯ menu (new host / subgroup, edit, export, environment, delete).

## [1.2.0-beta.13] - 2026-10-04

### Added

- **Native Remote Desktop on Windows** — RDP tabs on Windows now use Microsoft's own RDP engine
  (the one inside mstsc), embedded in the tab: native speed (GPU, modern codecs), NLA and the
  Windows sign-in experience. Each tab runs in its own small helper process. New host option
  "Remote Desktop engine: Automatic / Windows RDP / Built-in (IronRDP)". Overlays (menus,
  dialogs) temporarily show a snapshot of the remote screen.
- **Keychain** — Accounts and SSH keys are now one place in Settings: one searchable list with
  filters, details side by side (copy public key, deploy to server, export, usage), "+ New" for
  accounts and keys.
- RDP in a tab: "Visual experience" (Best performance / Balanced / Best quality) and an optional
  "HiDPI (sharper, slower)" mode; a performance overlay (Ctrl+Shift+Alt+P) shows fps, bandwidth,
  latency and codec.
- **Frameless window** like modern apps: no OS title bar; window controls sit in Shellhouse's top
  bar (macOS traffic lights inset).
- Settings → Appearance → "New interface (beta)": the first building blocks of the redesigned UI
  and a design kit (more coming in the next betas).

### Fixed

- **RDP in a tab was slow on HiDPI screens**: the remote desktop was requested at physical pixels
  (2.25× more at 150 % scaling); it now uses the window's logical size by default — about 2× the
  frame rate in our tests.
- RDP in a tab could show striped / corrupted images (e.g. on xrdp login) or freeze; IronRDP
  crashes now end the session with a Reconnect button instead of a frozen screen.

## [1.2.0-beta.12] - 2026-10-04

### Added

- **Accounts** — Settings → Accounts: reusable credentials with username, password, SSH key
  (pick, import or generate), key passphrase, domain (RDP) and notes; secrets stay encrypted in
  the vault. In the host form pick an account instead of typing credentials (SSH and RDP); editing
  the account updates every host that uses it, and SSH logins with the account's key + passphrase
  need no prompt. Deleting an account in use offers to keep the credentials on each host or move
  the hosts to another account.

### Fixed

- **RDP in a tab failed on Windows servers** with `KEY_USAGE_BIT_INCORRECT`: Windows' self-signed
  RDP certificates lack the digital-signature key usage, which Electron's TLS library enforces.
  Shellhouse now retries with TLS 1.2 RSA key exchange only for such certificates (certificate
  pinning unchanged; the status bar shows "TLS 1.2 (RSA)").
- **mstsc showed "Unknown publisher"**: Shellhouse now starts mstsc with command-line options
  instead of an unsigned `.rdp` file; a file is used only for options the command line cannot set
  (drive / printer redirection, RD Gateway…), and the host form says so.
- The "Save password in vault" option says when the password is saved to a shared account.

## [1.2.0-beta.11] - 2026-10-04

### Added

- **Remote Desktop (RDP)** — new host type next to SSH / Telnet / Serial:
  - **Opens inside a tab** (IronRDP): the remote desktop resizes with the tab (HiDPI aware), with
    Ctrl+Alt+Del, Windows key, clipboard, fit / 100 %, full screen and reconnect; several RDP tabs
    at once, tabs can be saved in workspaces.
  - The server certificate is confirmed on first connect and flagged if it changes (like SSH host
    keys); passwords come from the vault or are asked in the tab ("Save password in vault").
  - Can go through an SSH host without opening a local port; RD Gateway hosts can open in the
    external client.
  - Or open in the system client: mstsc (Windows), Windows App (macOS), xfreerdp / Remmina (Linux);
    the password is never written to a file or command line except Windows' `cmdkey`.
  - Import `.rdp` files.
- **Server OS icons** — after an SSH login Shellhouse detects the OS (Ubuntu, Debian, RHEL, CentOS,
  Rocky, AlmaLinux, Fedora, Amazon Linux, SUSE, Arch, Alpine, Oracle, Kali, Raspberry Pi OS,
  FreeBSD, macOS, Windows…) and shows its icon on the host, Home cards and tabs.
- **Kubernetes Traffic service map** — follows the selected namespaces; other namespaces collapse
  into one node each, external addresses group by /16 or domain (expand on demand), idle
  connections hidden, top connections first; click a service for per-peer rates. The workload
  Traffic tab gets a small focused map (callers → workload → callees).
- **Docker** — checkbox selection with bulk Start / Stop / Restart / Pause / Kill / Remove for
  containers, and bulk actions for images, volumes and networks.

### Changed

- Docker Compose page rebuilt as a full-width table: actions sit next to the project name, rows
  expand into services (image, state, health, ports, replicas, quick actions).
- Kubernetes Topology: every Ingress rule gets its own lane and entry point, so edges no longer
  merge into one trunk or cross in opposite directions.
- Consistent type scale on Kubernetes Overview and detail pages.
- Home adapts to the window width (1 → 3 columns).

### Fixed

- Kubernetes namespace / context menus were hidden under the Map toolbar and did not close when
  clicking outside.
- Map → Traffic ignored the selected namespaces.
- Opening a module item from the collapsed sidebar left the sidebar covering the new tab.
- Kubernetes requests on reused connections were ~100 ms slower on macOS (TCP_NODELAY).

## [1.2.0-beta.10] - 2026-10-03

### Added

- **Vietnamese interface** — Settings → Appearance → Language: System / English / Tiếng Việt
  (restart to apply). Dates, times, numbers and sizes follow the language (`17/08/2026, 22:44`,
  `1,5 KB`). Technical terms (pod, label, endpoint, container, bucket, Running, Pending, Scale,
  Drain…) stay in English, the way Vietnamese engineers use them.
- **Kubernetes Topology** is now the default Map view and works without any traffic data:
  - Lanes Entry → Services → Workloads → Pods, with every Ingress host/path rule as its own line
    and Service `port → targetPort`; opens at a readable zoom showing the whole chain.
  - Problems explained in words: Service selector matches no pods, no Ready endpoints, targetPort
    not exposed by any container, Ingress backend Service or TLS Secret missing, CrashLoop /
    Pending / image pull errors, HPA at max, unbound PVC, NetworkPolicy isolation.
  - Hover/select highlights the whole path; inspector with Logs / Shell / YAML / Port-forward;
    focus mode; search by name or `label=value`; overview cards stay readable when zoomed out.
  - Map toolbar fits narrow windows (actions fold into icons / the View menu).
- **Kubernetes**: multi-select bulk actions (delete, restart, scale, cordon); Helm rollback,
  uninstall and revision diff (no helm CLI needed); `kubectl debug` for pods and nodes; diff
  before apply; live events; YAML editor with syntax highlighting; Overview "Needs attention".
- **Docker**: create volumes and networks, connect/disconnect containers; private registries
  (credentials encrypted in the vault) for pull / push / tag; image builds with live output;
  Files tab to copy files in and out of containers; healthcheck status; disk usage bars show real
  usage with Clean up for build cache.
- **S3**: object versions (show, restore, delete), metadata and tags editing, bucket settings
  (versioning, lifecycle rules, CORS), object details panel, share links with chosen expiry.
- Terminal: warning before pasting multiple lines; confirmation before closing a connected tab;
  SSH password prompt with show/hide, Caps Lock warning and "Save password in vault".
- Interrupted downloads: `*.shellhouse-part` files are hidden; Resume / Discard in Transfers and a
  banner in the local file pane.

### Changed

- Module tabs collapse the host sidebar to an icon rail (hover to peek) for more room.
- Host form: chip tags, labelled colours, inline validation. Favorites / Recent are compact and no
  longer duplicate each other.
- Startup bundle halved (1.9 MB → 0.94 MB); faster startup, lower memory; large transfer queues
  and big host lists no longer stall the UI.

### Fixed

- A network error during login could crash the session host and close every tab.
- Security hardening: external editor chosen only through a file picker; only the app's own
  `index.html` gets IPC; path traversal in S3/SFTP folder downloads; read-only mode now enforced by
  the app (no exec / shell / port-forward); kubeconfig exec plugins limited to sign-in commands
  with a sanitised environment.
- SFTP: saves are atomic (no truncated file on a dropped connection); resume checks the source
  has not changed; downloaded private files keep restrictive permissions.
- Kubernetes OIDC token refresh never worked; requests now time out and reuse connections (much
  faster through an SSH bastion).
- Docker Engine 29+ (API version negotiation); volume prune no longer removes named volumes.
- Production-context Restart / Sync in Kubernetes did nothing; switching context could hang on
  "Loading…".
- Escape now closes a dialog the moment it appears; Map/Topology search results stay open when
  the window loses focus.

## [1.2.0-beta.9] - 2026-10-03

### Changed

- **UI polish across modules** (reviewed screen by screen, light and dark):
  - Detail panels no longer repeat a tab as a button — "View YAML" (Kubernetes) and "Inspect"
    (Docker) stay in the `…` menu and on their shortcut, next to their own tab.
  - Kubernetes Traffic tab: Total / Incoming / Outgoing on one row; peer names are no longer cut
    by an "(external)" suffix.
  - Service map: names use the whole first line, speed sits under it; columns are closer so the
    map fills the view instead of shrinking to unreadable text.
  - ConfigMaps and Secrets always open on Data; an unused Secret says "Not used by any workload."
    instead of "No used by.".
  - Docker: image ages read "6 years ago" instead of "2,210 days ago"; the Run dialog no longer
    shows an error before you type; disk-usage bars line up.
  - Create resource: the container "Name" field label no longer wraps and pushes its row out of
    line.
- Sizes passed to text fields and dropdowns now apply (e.g. the log "Last 500" picker was
  stretched across the whole toolbar).
- Docs: `docs/k8s-design-guide.md` — density, what is hidden by default, status colours, layout
  patterns and a pre-merge checklist for module screens. `pnpm screens` now also captures the
  Kubernetes, Docker and S3 screens.

### Fixed

- **Traffic service map readable on real clusters** — columns are now "hops from the entry point"
  instead of the longest call chain, so services that call each other back and forth no longer
  stretch the map into dozens of columns; within a column services are ordered next to the ones
  they talk to, so cables cross less.
- **Workload map: traffic between namespaces goes card to card** — when zoomed in, live traffic
  from another namespace is drawn from the exact workload that calls to the exact workload being
  called (not namespace to namespace). Workloads inside a collapsed namespace connect to its
  island. The far zoom still sums traffic between namespaces.
- **Topology names the Ingress behind the ingress controller** — Caretta sees the real TCP
  connection from the controller pods (ingress-nginx, Traefik…), so the live edge now reads e.g.
  "2.1 KB/s · via Ingress console-frontend-ingress".

## [1.2.0-beta.8] - 2026-10-02

### Added

- **Kubernetes Map → Traffic: a service map from Caretta** — every workload, Service and outside
  address that talks to another, across all namespaces (not only the ones you are viewing):
  callers on the left, databases and external APIs on the right, cables sized and coloured by
  bandwidth. Click one to see who calls it and what it calls; double-click to open it.
- **Topology shows live callers** — a Deployment's topology adds what Caretta saw calling it and
  being called by it, including other namespaces (e.g. the ingress controller) and addresses
  outside the cluster ("Live traffic" in the filter bar).

### Changed

- **Live traffic is faster and steadier** — one Caretta reader per cluster is shared by the Map,
  the Traffic tab and Topology, so switching views shows data immediately; the first figures
  appear after about 2 s; agents and Service → workload lookups are reused for a minute instead
  of being re-read every time. Throughput is averaged over the last minute, and a connection with
  no bytes in that window shows as "idle" instead of "0 B/s".

## [1.2.0-beta.7] - 2026-10-02

### Changed

- **Kubernetes details are calmer** — the Strategy section is gone; pods are listed one per line
  (status, restarts, node, ready, age) instead of large tiles; Conditions only appear when one is
  unhealthy; created time and UID are dropped (the age is in the header) and Labels are folded
  like Annotations, both at the top of Overview. The Security tab is removed. Topology starts with Access (RBAC) and Scheduling
  turned off — tick them in the filter bar when you need them.
- **Kubernetes Metrics show real history** — when the cluster runs Prometheus (kube-prometheus-stack,
  Rancher Monitoring, prometheus-server…), CPU and memory charts load the last 15 min / 1 h / 6 h
  / 24 h through the Kubernetes API proxy; otherwise live samples are kept for the whole session
  instead of restarting each time the tab opens. Charts scale to the data (no more flat line at the
  bottom because the limit sets the scale), show time and value axes, request / limit lines and
  the value under the pointer. The Pod page uses the same charts.
- **Pod page is shorter** — one summary line (node, IP) instead of six rows; containers show
  image, ports and requests / limits, with command, mounts and environment folded under Details.
  ConfigMaps and Secrets open on their data; empty node fields are hidden.
- **Map shows full namespace names** at any zoom — long names wrap onto two balanced lines (at the
  dashes) instead of being cut to "cattle-…".

## [1.2.0-beta.6] - 2026-10-02

### Changed

- **Kubernetes Map is roomier and easier to follow** — each workload gets its own column with its
  Ingress / route, Service and volumes straight above and below it (a Gateway sits on top of the
  routes it serves), so connections are short vertical lines that never run across another app.
  Cards are wider (names are no longer cut off) with more space between rows and namespaces;
  zoom in and out freely. Hovering a namespace no longer covers its cards with a tooltip.
- **Topology: drag objects** to rearrange the graph; **Reset layout** puts them back.
- **Kubernetes Map: clearer connections between apps** — an Ingress that sends some paths to
  another app's Service (e.g. the frontend's `/api` going to the backend) now shows that link as a
  curved line between the two columns instead of a short stub hidden under the cards, and the
  line is labelled with the host / path when highlighted. Selecting something lights up what it
  depends on and what depends on it — following the direction of the arrows — so selecting one
  Ingress no longer lights up an unrelated Ingress that happens to share a Service.

### Fixed

- Dropdown lists (Map grouping and others) were unreadable in the dark theme — white text on a
  white list.
- Kubernetes create form: **Edit as YAML** closed the dialog instead of opening the YAML editor
  with the generated manifest.

## [1.2.0-beta.5] - 2026-10-02

### Added

- **Kubernetes Map redesign** — regions are soft backgrounds instead of boxes inside boxes;
  namespaces are light islands with a health ring; workloads are layered cards with a status light
  (only failing ones pulse). Pods are small shaded beads; hovering one shows status, restarts,
  node, IP, uptime and live CPU / memory against requests. Live traffic is drawn as glowing cables
  coloured by bandwidth (teal → amber → red) with light pulses flowing in the direction of the
  data (only up close, off when the system asks for reduced motion). Selecting something lights
  up its path and sinks everything else; the side panel opens with ready, restarts, traffic in /
  out and blast radius at a glance. Labels stay readable at any zoom, and **Dark canvas** gives
  the map a control-room background even with the light theme.
- **Kubernetes Map for large clusters** — group namespaces into regions **by name prefix** or **by
  any label** (`team`, `app.kubernetes.io/part-of`… — read from the namespace, or from the
  workloads inside it) instead of guessing by name; the labels in use are suggested. **Collapse /
  expand** each namespace (or all at once — clusters with 25+ namespaces start collapsed); search
  still finds workloads in collapsed namespaces and opens them. **Filter by label** with kubectl
  syntax (`tier=backend`, `env in (prod,staging)`, `!canary`): only matching workloads stay,
  together with the services, routes, volumes and policies connected to them.
- **Kubernetes Map → Nodes** — the cluster seen machine by machine: CPU / memory requested vs
  allocatable with live usage (metrics-server), pods on each node (click to open), taints,
  cordoned / not-ready / pressure warnings, and a warning when every replica of a Deployment or
  StatefulSet runs on the same node.
- **Keep SSH sessions alive with tmux** (host → Advanced): if the server has tmux, each tab runs
  inside its own tmux session (`shellhouse-1`, `-2`…). When Wi-Fi drops or the laptop sleeps,
  reconnecting — even after restarting Shellhouse — brings you back to the same prompt with your
  programs still running. Servers without tmux get a plain shell, with a note in the terminal.
- **Built-in editor** — double-click a text file in SFTP (or **Edit** on an S3 object) to open it
  in an editor tab: syntax highlighting for YAML, JSON, nginx, shell, Dockerfile, INI / .env,
  Python, SQL and more, search, line numbers, word wrap. **Ctrl+S saves straight to the server**
  (in place — owner, permissions and hard links are kept; on S3 the content type and metadata are
  kept). If someone changed the file since you opened it, you choose: overwrite or reload theirs.
  Windows line endings are preserved, and closing a tab with unsaved changes asks first. Binary
  and very large files still open in your local editor (Settings → Files).
  On macOS ⌘S saves the file and ⌘F searches it while you are typing in the editor (elsewhere ⌘S
  still opens Snippets).
- **Two-pane file manager: F5 / F6** like Total Commander — F5 copies the selection to the other
  side, F6 moves it. A move only removes the original after every file arrived (items on this
  computer go to the Trash); anything that failed stays where it was.
- **Combined logs with a colour per source** — logs of a whole Deployment / StatefulSet (all pods)
  or a Compose project give each pod / service its own colour, and chips above the log show or
  hide sources (double-click a chip to see only that one), like stern / kubetail.
- **Kubernetes port forwards keep working** when the pod behind a service is replaced (rollout,
  crash): new connections go to the new pod automatically. Each forward has an on / off switch
  that keeps it in the list, shows the pod it reaches, the time to open a connection, and
  **Stop all**.

- **Kubernetes: cluster Map** — the whole cluster as a live map you can pan and zoom like a
  street map. Namespaces are islands grouped into regions by purpose (your applications, ingress
  & networking, platform, monitoring, system). Zoomed out you see each namespace's workload / pod
  counts and a health bar; zoom in for workload cards, services, Ingress / Gateway API routes and
  volume claims with the connections between them; closer still, every pod as a coloured dot.
  Search and fly to anything (`/`), jump to the next failing or degraded workload, show problems
  only, hide system namespaces, a minimap, keyboard control (+ / − / 0 / arrows). Click something
  to highlight everything connected to it and see its pods, traffic sources, volumes, autoscaler
  and network policies, with **Open details**, **Logs** and **Shell**. Drawn on a canvas and only
  what is on screen, so clusters with thousands of workloads stay smooth; refreshes every 20 s.
  The map also shows Gateways attached to routes, NetworkPolicies and the workloads they apply
  to, technology badges (Prometheus, Grafana, Argo CD, CoreDNS, NGINX, PostgreSQL, Redis… from
  the image), a Helm badge, and a **Blast radius** for any object: what is affected if it
  changes or fails.
- **Find in terminal** (Ctrl+Shift+F / ⌘F, or the Find button on the session bar) — searches the
  whole scrollback, highlights every match, shows "3 of 12", with match case, whole word and
  regex; Enter / Shift+Enter move between matches, Esc closes.
- **Terminal look menu** (Aa on the session bar) — change the colour theme, font and text size
  without leaving the terminal; only fonts installed on this computer are offered. 12 more
  built-in themes: One Dark, Monokai, Gruvbox (dark / light), Tokyo Night, Catppuccin (Mocha /
  Latte), GitHub (dark / light), Ayu Dark, Night Owl and Material.
- **Latency** — the session bar shows the round-trip time to the server (measured with an SSH
  keepalive, nothing runs on the server), green / amber / red.
- **Character encoding per host** (Edit host → Advanced) — for old devices whose output looks
  garbled: Windows-1252, ISO-8859-x, Cyrillic, Greek, Turkish, Vietnamese, Thai, GBK / GB18030,
  Big5, Shift_JIS, EUC-JP, EUC-KR. The session bar shows the encoding in use.
- **Terminal text size** — Ctrl+= / Ctrl+- / Ctrl+0 (⌘ on macOS) make the text bigger, smaller
  or back to the default.
- **Session bar** — shows where you are connected (user@host:port) and for how long.
- **SFTP quick look** — press Space (or Preview in the menu) to see a text file with line
  numbers or an image without downloading it; large text files show their beginning.
- **Transfer queue** — each transfer shows bytes done of total, speed and time left; the header
  shows the overall speed and time left, with **Cancel all** and **Retry failed**. Drop zones
  say where the files will go.
- **Tabs** — tabs of saved hosts show the host's coloured initials and a stronger colour line;
  the Terminal ▾ menu lists **Recently closed** tabs so you can bring back a specific one.
- **S3, Docker and Kubernetes look alike** — every empty table now explains itself and offers
  the next step (Create Job, Run a container, Upload files, Show all namespaces…), a filter
  with no results offers **Clear filter**, and each page has one solid main action (New bucket /
  Upload, Run, Create).
- **Reopen closed tab** — Ctrl+Alt+T (⌘⌥T), the command palette or the tab menu bring back the
  last closed tabs (up to 10), including SFTP file manager tabs.
- **Home** — Shellhouse now opens on a home page: a large quick-connect box, your recent
  connections and favorites as cards (Connect, open files, edit), ways to get started and the
  main shortcuts. Open it any time with the Home button; Settings → Appearance chooses whether
  the app starts on Home or a local terminal.
- **Sidebar** — hosts show a coloured avatar with their initials (the host colour, or a stable
  colour from the name) and quick buttons on hover: Connect, open files (SFTP) and Edit.
- **Host form** — rarely used options (legacy algorithms, system ssh) moved under a collapsible
  **Advanced** section that opens by itself when one of them is on.
- Saving, adding, duplicating and deleting hosts and copying the SSH command now confirm with a
  toast. S3 bucket dates show the full date.
- **Kubernetes: create resources with forms** (like Rancher / Lens) — Deployment,
  StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, ConfigMap, Secret (key / value,
  registry login, TLS, username / password), volume claim, autoscaler and namespace. Pick
  ConfigMaps, Secrets, volume claims, services and storage classes from the cluster; set image,
  ports, environment (values or keys of a ConfigMap / Secret), resources, health checks, volumes
  and schedules; tick **Also create a Service** to expose a workload. Fields are checked as you
  go, the YAML preview updates live, and **Edit as YAML** opens the generated manifest for hand
  edits. **Create** opens the form for the kind you are looking at; **YAML** still opens the
  editor directly.
- **Notifications** — actions in the Kubernetes and Docker modules report through toasts: a
  progress toast that turns into success or a clear error (with the reason from the cluster and
  a Copy button), plus an **Open** action after creating something.
- **Kubernetes: Map and Topology redrawn** with React Flow — cards, icons and edges are proper
  UI components that follow the light / dark theme. Every resource uses the official Kubernetes
  icon set, and recognised applications show their logo (Prometheus, Grafana, Argo CD, NGINX,
  PostgreSQL, Redis, Kafka, Istio… and language runtimes such as Node.js, Python, Java, Go).
- **Kubernetes: live traffic from Caretta** — when [Caretta](https://github.com/groundcover-com/caretta)
  runs in the cluster, the Map draws traffic roads between workloads (direction, colour and width
  by fixed absolute bands, so clusters are comparable; aggregated between namespaces when zoomed
  out) and Deployments, StatefulSets and DaemonSets get a **Traffic** tab: total, incoming and
  outgoing throughput with history and per peer and port. Traffic sent to a Service is counted
  for the workloads behind it. Read straight from the Caretta agents through the API server — no
  Prometheus needed. The states are explicit: connecting, live, no traffic, or unavailable with
  the reason (not installed, not allowed to read `pods/proxy`).
- **Kubernetes: Topology tab** — every pod, workload, service, Ingress / route / Gateway,
  ConfigMap, Secret, PVC, ServiceAccount and node now has a relationship graph: ownership
  (Deployment → ReplicaSet → Pod), scheduling (Pod → Node), traffic (Gateway → Route / Ingress →
  Service → workload), config and storage (ConfigMap / Secret / PVC → PV), policies (HPA, PDB,
  NetworkPolicy) and access (ServiceAccount → RoleBinding → Role, risky roles in red). Directed
  arrows, filters per kind of relationship, missing references flagged. Shared objects such as
  nodes are not expanded until you ask (**Expand**); **Blast radius** highlights everything that
  depends on the selected object — e.g. which workloads, pods, services and routes a ConfigMap
  change would hit.
- **Kubernetes: workload page** — Deployments, StatefulSets and DaemonSets open on a full page:
  rollout status (Available, Rolling out, Stalled, Paused) with desired / ready / up-to-date /
  available / unavailable, pod phases counted from the real pods, Strategy, Resources and limits
  per container (missing values highlighted, totals for all replicas, probes), a pod grid that
  uses the full width (failing pods first; click a pod to open it, click its node to open the
  node) and ReplicaSets by revision with **Roll back**. The detail panel can be expanded to full
  width.
- **Kubernetes: Metrics and Security tabs** — Metrics shows CPU / memory of all pods of a
  workload with history, against requests and limits, and per pod. Security lists risky pod
  settings (privileged, host network / PID / paths, root, added capabilities, `:latest`, missing
  limits or probes) and answers "if this is compromised, what can it reach?" — every RBAC
  permission of its ServiceAccount with the binding it comes from, sensitive ones (reading
  Secrets, exec into pods, escalation) first.

### Fixed

- The session host could crash when a Kubernetes request was cancelled while its connection was
  still opening (an unhandled "socket hang up"). Tabs of the Kubernetes and Docker modules then
  waited forever ("Loading…"); they now notice the session host restarting and reconnect on
  their own, and a stuck TLS handshake with the API server times out and is retried instead of
  hanging.
- Switching a terminal tab to the file manager and back no longer reconnects SSH — the
  running shell (and whatever it was doing) stays as it was. Only a tab opened with **Open SFTP**
  connects again, once, to start its first shell.

## [1.2.0-beta.4] - 2026-10-01

### Added

- **Docker inside WSL** (Windows): every running WSL distribution with Docker shows up in the
  Docker sidebar as “Ubuntu (WSL)” — containers, logs, stats, shells and Compose work as usual
  through `wsl.exe`. Stopped distributions can be added from the ＋ menu; any can be hidden. The
  module is also suggested when Docker is found in WSL.
- **Kubernetes: Related tab** (like Rancher): double-click a deployment, stateful set, daemon set,
  job, cron job, service or pod to see its pods, services, ingresses, the ConfigMaps / Secrets /
  volume claims it uses (missing ones are flagged in red — pods that need them will not start),
  autoscalers, disruption budgets, service account and owner. ConfigMaps, Secrets and volume
  claims show which workloads use them. Click any of them to open it; **Show in table** lists the
  pods in the main table.
- **Kubernetes: delete contexts** you no longer need (right-click → Delete context…). Imported
  ones are removed from the vault; contexts in `~/.kube` files are removed from the file like
  `kubectl config delete-context`, keeping a `.bak` copy. Nothing changes on the cluster.
- **Kubernetes: Refresh** button, and `~/.kube` is read again whenever you come back to the app —
  newly downloaded kubeconfigs appear without restarting.
- **Kubernetes sidebar like Rancher**: Workloads, Service Discovery (HorizontalPodAutoscalers,
  Ingresses, IngressClasses, NetworkPolicies, Services), Storage (PersistentVolumes,
  StorageClasses, ConfigMaps, PersistentVolumeClaims, Secrets), Policy (PodDisruptionBudgets,
  ResourceQuotas, LimitRanges, PriorityClasses, admission policies and webhooks), Access Control
  (ServiceAccounts, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings) and Cluster — with
  the number of objects next to each, for the namespaces you are looking at. Kinds the cluster
  does not have are hidden.
- **Kubernetes: Argo CD** (like Lens 2026.8): when Argo CD is installed, Applications,
  ApplicationSets and AppProjects get their own group with Sync / Health / Source columns and
  **Sync**, **Sync and prune**, **Refresh** and **Hard refresh** actions.
- **Kubernetes: Gateway API** (like Lens 2026.5): Gateways, GatewayClasses and routes get their own
  group; a Service's Related tab lists the HTTP / gRPC routes sending traffic to it, a Gateway
  lists its routes and a route shows its gateways and backend services.
- **Kubernetes: Helm releases** (Apps → Helm releases): chart, app version, status, revision and
  last update of every release, with notes, values, manifest and history — read straight from the
  cluster, no `helm` needed.
- **S3 sync**: choose how many objects are copied at once, see the time left, a smoother speed and
  the objects being copied right now.

### Performance

- **Large Kubernetes clusters stay smooth**: tables only draw the rows on screen and only recompute
  rows that changed. With 3,000 pods updating continuously: list in ~0.3 s (was 1.5 s), 60 fps
  while scrolling and updating (95th-percentile frame 18 ms, was 93 ms), filtering in ~70 ms, a
  quarter of the memory. Files (SFTP / local) and S3 tables benefit too.
- Kubernetes remembers which resource kinds the cluster has and what you may list for 5 minutes —
  switching namespaces no longer re-asks the cluster about every kind (~150 requests on Rancher
  clusters); **Reload** asks again.
- Docker CPU / memory columns refresh in ~0.1 s instead of ~1 s per container (100 containers: was
  ~13 s per refresh), with much less load on the Docker daemon.

### Changed

- Detail panels (Kubernetes, Helm, Docker) can be resized by dragging their left edge — the width
  is remembered; double-click the edge to reset. The Kubernetes resource list can be hidden with
  the button left of the cluster name.
- **Copy name** in the Kubernetes right-click menu (several selected → one name per line); **Copy
  name** / **Copy ID** for Docker containers.
- S3 bucket list export: a readable **Size** column (KB / MB / GB / TB) next to Size (bytes).
- Kubernetes: double-click / Enter on a workload opens its details (Related tab) instead of jumping
  to its pods.

### Fixed

- Windows: the Docker sidebar no longer waits for `wsl.exe` (which can take seconds when WSL is not
  installed) before listing your sources.
- Kubernetes: tables showed “aborted” after a few minutes on clusters behind Rancher, a load
  balancer or another proxy that closes long requests. Live updates and followed logs now
  reconnect silently from where they stopped.
- Kubernetes was not suggested when `~/.kube` only had kubeconfigs not named `config` (common for
  files downloaded from Rancher or cloud consoles).
- Docker via the `docker` command (WSL, or when the socket is not reachable): container and image
  dates were shown as unknown.

## [1.2.0-beta.3] - 2026-10-01

### Changed

- **S3 is now a module** (on by default — nothing changes for existing accounts, tabs, pins or
  saved workspaces). Its speed settings moved from Files to Settings → Modules → S3 storage.
- **New look**: a new logo and app icon (a roof over the terminal prompt) and a teal accent color.
- **Easier to read**: small text is now at least 12 px, and secondary text in both light and dark
  themes meets the WCAG AA contrast ratio (4.5:1) on every background.
- **SFTP panes rebuilt** to match the S3 browser: sortable Name / Size / Modified (and Permissions)
  columns, multi-select (Ctrl / Shift-click, Ctrl+A, arrow keys), right-click menu (Open, Edit,
  Download, Rename, Permissions, Copy path, Delete), F2 / Del / Enter / Backspace, a status bar,
  downloading or deleting several items at once, dragging several items between Local and Remote,
  and the compact transfer list.
- **Toolbar**: split right / split down are grouped under **Layout ▾**; Layout, Workspaces,
  Snippets and MultiExec show text labels when there is room.

### Added

- **Modules** (Settings → Modules): tools you can turn on and off. Search (by name, keyword or
  a near-miss like "kubernets"), filter by category and status, see what each module adds and
  exactly which permissions it uses before enabling it, and remove its data. Modules ship with
  the app and are reviewed like the rest of it.
- **Docker module**: containers, images, volumes, networks and Compose projects on this computer
  and on any SSH host — through the SSH connection, with no port opened and nothing installed on
  the server. Live CPU / memory, log tabs (follow, search, download), **Open shell** as a terminal
  tab, pull / prune with a preview, and a read-only mode for production servers.
- **Kubernetes module**: contexts from your kubeconfig (or imported into the vault), live
  resource tables for pods, deployments, services, CRDs and more, pod logs, shells, port-forwards,
  scale / rollout restart, secrets revealed only on request, and YAML edited in your own editor
  (applied only if nobody changed the object meanwhile). Clusters behind a bastion go through one
  of your SSH hosts; production contexts can be read-only or require typing the name to delete.
  Sign-in helpers (`aws`, `gcloud`, `kubelogin`) run only after you allow them.
- **Kubernetes, k9s / Lens style**: a cluster **Overview** (nodes, CPU / memory requests and live
  usage, unhealthy workloads, warning events), live **CPU / MEM** columns from metrics-server, a
  `:` command bar with aliases (`:po`, `:deploy kube-system`, `:crd`…) and suggestions, drill-down
  from a deployment / node / service to its pods with breadcrumbs, a sidebar with collapsible
  groups (custom resources grouped by API group), columns that make room for the detail panel
  instead of squeezing every value, optional single-key shortcuts (l logs, s shell, f forward,
  y YAML, e edit, d describe, ctrl+d delete… — press **?** for the list), a tabbed detail panel, **Create** from YAML (server-side apply, with templates), rollout **history and
  rollback**, **cordon / drain**, trigger / suspend CronJobs, force delete, and logs for every
  container or for all pods of a workload in one tab.
- **Import kubeconfig files** (Kubernetes ＋ menu or Settings → Modules → Kubernetes): pick one or
  more files; certificates and token files they reference are embedded before the result is
  stored encrypted in the vault. Every kubeconfig in `~/.kube` is also listed, like Lens, and
  contexts can be renamed, hidden from the sidebar or set read-only.
- **Docker, more complete**: an engine **Overview** (running / stopped / unhealthy, disk usage with
  one-click clean-up), **Run a container** (image, name, ports, volumes, environment, restart
  policy — pulls the image if needed), live CPU / memory columns for every container, All /
  Running / Stopped filter, multi-select with bulk start / stop / restart / remove, a detail panel
  (overview, stats, environment with secrets hidden until revealed, processes, inspect), image
  layers, **Exec…** with a custom command / user, Compose project logs in one tab, and optional
  keyboard shortcuts (press **?** for the list).
- Success messages in the Docker and Kubernetes tabs now disappear on their own after a few
  seconds; errors stay until dismissed.
- **S3: export the bucket list** of an account to CSV (opens in Excel) or JSON — name, region,
  created date, and optionally object count and total size (counts reused when already
  calculated) and versioning / encryption.
- **S3: sync** a bucket or folder to another place — the same account or another S3 account, even
  at a different provider (AWS → R2, MinIO → Wasabi…). Always previewable (new / changed /
  unchanged / to delete), **Copy new & changed** or **Mirror** (also deletes extra objects at the
  destination, only after a preview), creates the destination bucket if needed, compares by size
  and checksum, can be stopped at any time and resumes by simply running it again. Within one
  account objects are copied on the server; between accounts they are streamed through this
  computer without touching the disk.
- **Suggestions**: when Docker is found on a server you connect to, or a kubeconfig on this
  computer, a one-line hint offers the matching module (at most once a month; can be turned off).
- **Welcome screen** when no tab is open: add a host, import hosts, quick connect or open a local
  terminal. The sidebar shows a compact **Add your servers** card instead of a large empty box.
- **Settings → About**: version, components, release notes, report a problem, copy details.
- Command palette: **New host**, **Import hosts** and **Quick connect**.

### Fixed

- Kubernetes: live tables no longer freeze after the API server or network was unreachable for a
  while — the watch keeps retrying and reloads the list once it is back.
- Docker: the container list keeps updating after the Docker daemon restarts or the connection
  drops; live CPU / memory no longer keeps polling after quickly switching tabs.
- Kubernetes and Docker tabs in the background no longer poll metrics, refresh the cluster
  overview or redraw tables; changes are applied when you come back to the tab.
- The whole tab area could shift up by a few pixels after resizing the window.
- A setting changed right while the app was starting could be shown with its old value.
- A module suggestion ("Docker detected…") could be marked as shown without ever appearing, which
  hid it for 30 days.

## [1.2.0-beta.2] - 2026-09-30

### Performance

- **S3 and SFTP work in parallel** instead of one request at a time:
  - S3 size / object counts scan many folders at once (up to 8 requests per bucket, 3 buckets at
    a time for **Calculate all sizes**), running in the background with live progress.
  - Listing a whole S3 folder tree (download, delete, copy, move) is parallel too, and deletes
    send several 1,000-object batches at once.
  - SFTP folder download / upload / recursive delete read and create directories in parallel
    (up to 8 requests at once on the same connection).
  - More files transfer at the same time: 6 for S3 (large files are still split into parallel
    parts), 4 for SFTP (each with pipelined reads and writes).
  - All of this is adjustable in **Settings → Files → Transfers & performance** (S3 requests 4–64,
    default 16; SFTP requests 2–16, default 8; files at once for each). S3 backs off automatically
    when a server answers "SlowDown" / 503.
- **Sort menu** (⇅ button) in the S3 browser and in both SFTP panes: name, size, or modified
  date / created date, ascending or descending — the SFTP local pane can now be sorted too, and the
  remote pane can finally reverse the order. The choice is remembered.

### Added

- **S3 statistics**: object count and total size per bucket, right in the bucket list
  (**Calculate**, or **Calculate all sizes**), and for any folder (right-click → **Size & object
  count**, or **Folder size…** in the status bar). Folder totals are split by storage class; counts
  update live and can be stopped at any time.
- **S3 rename, copy and move** of objects and whole folders, within a bucket or to another
  bucket. Copying happens on the server (nothing is downloaded), objects over 5 GB included.
  Existing objects are never replaced unless you tick **Replace objects that already exist**.
- **Edit S3 objects in your local editor**: saving uploads the file back, keeping its content
  type. If someone else changed the object in the meantime, it is not overwritten.
- S3 right-click menu, **F2** to rename, **Del** to delete, **Ctrl+A** to select all.

### Changed

- **New S3 layout** (like the AWS Console and Cyberduck): opening an account shows its buckets as
  a full-width table (Region, Created, Objects, Size), and the narrow bucket column is gone. Inside
  a bucket, the path bar reads `account › bucket ▾ › folder`: click the account to go back to the
  bucket list, or **▾** to jump to another bucket (type to filter). The tab title follows the
  current location, and duplicated tabs / saved workspaces reopen at the same place.
- **Pin to sidebar**: pin a bucket or folder (right-click, or the pin button in the path bar) and it
  appears under its account in the sidebar — one click opens a tab right there.
- The S3 browser adapts to narrow windows and split panes: toolbar buttons shrink to icons,
  the Modified / Class columns hide, and the bucket list gets narrower — nothing is cut off.
- S3 columns can be sorted (Name, Size, Modified; folders stay first), with natural number order.
  Shift-click selects a range; arrow keys, **Enter** and **Backspace** navigate the list.
- The S3 transfer list is compact and collapsible: a summary line (active / done / failed), a thin
  progress bar only for running items, and the full source → destination on hover.
- Clearer empty states (no bucket selected, empty folder, no filter matches), a drop overlay
  when dragging files in, a dismissible error bar, a **Copied** confirmation for share links, and
  the list of items in the delete confirmation.

### Fixed

- Shrinking the window while another tab was hidden could make the whole app scroll sideways.

## [1.2.0-beta.1] - 2026-09-30

### Changed

- **Open SFTP** no longer opens a shell on the server: the connection only authenticates and
  opens SFTP (no login shell, no `.bashrc` / motd, no extra "last login"). The shell is opened
  the first time you click **Show terminal**.

### Added

- **S3 manager** (like S3 Browser) for AWS S3 and S3-compatible storage (MinIO, Wasabi,
  Cloudflare R2, Ceph): add an account under "S3 storage" in the sidebar, then browse buckets and
  folders, upload and download files or whole folders (drag and drop works; large files use
  multipart upload), create folders and buckets, delete (including whole folders), and create
  time-limited share links. The secret key is stored encrypted in the vault and never reaches
  the window; transfers run in the session host.
- Hide the **Favorites** / **Recent** shortcuts at the top of the sidebar: right-click the
  section title → Hide, or Settings → Appearance → Sidebar. The hosts stay in their groups.
- **Telnet** hosts for network devices without SSH: choose Telnet in the host form. Window
  size and terminal type are negotiated; the tab is marked "not encrypted".
- **Serial (COM)** hosts for device consoles: pick the port (detected list or type it), speed,
  data bits, parity, stop bits and flow control (9600 8N1 by default). A disconnected USB-serial
  cable is reported and the tab reconnects when it is plugged back in.
- **Macros**: a snippet can run line by line, waiting for the prompt before each next line
  (`# wait 5` pauses, `# expect Password:` waits for text). With MultiExec the macro runs in
  every selected terminal, each at its own pace. Ctrl+C in a terminal stops it there.
- **Command suggestions**: while you type, the last matching command you ran on the same host
  appears in faint text after the cursor; press → to accept (like fish). History is kept per
  host. Commands starting with a space and anything not shown on screen (passwords) are never
  saved. Turn off or clear it in Settings → Terminal.

### Fixed

- A damaged data file could make the app fail to start instead of offering to restore the
  latest backup (the error happened while opening the file, before the damage check).
- **Ctrl+Shift+V / Shift+Insert pasted twice** in the terminal (since the menu bar was removed
  in 1.1.0-beta.3). The app handles these keys itself and no longer lets Chromium paste again.
- Command suggestions work for long command lines that wrap onto several lines (long prompts,
  narrow windows), and when the cursor sits at the right edge the suggestion continues on the
  next line.

## [1.1.0-beta.3] - 2026-09-30

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

- Uploads could finish one chunk early and fail with "Size mismatch" (or the server file
  was missing its last part) when the server acknowledged writes faster than the local disk
  read the final chunk.
- With a narrow window (split screen) the tab bar overflowed and pushed the Lock / Settings
  buttons off-screen; it now shrinks, and less-used buttons move to the command palette.
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
