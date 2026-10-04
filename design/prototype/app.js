/* ==========================================================================
   Shellhouse — clickable prototype (vanilla JS, không build step)
   Cấu trúc: 1) tiện ích  2) i18n  3) state  4) mock data  5) shell
             6) màn hình  7) overlay (menu, dialog, palette, toast, tooltip)
             8) bàn phím  9) router
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 1. Utils */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, s, x) => window.icon(n, s, x);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl';

  /** "mod+k" → <kbd>Ctrl</kbd><kbd>K</kbd>; "g h" → G then H */
  function kbd(spec) {
    if (!spec) return '';
    const seq = spec.split(' ');
    const part = (p) =>
      p.split('+').map((k) => {
        const map = { mod: MOD, ctrl: 'Ctrl', shift: '⇧', alt: isMac ? '⌥' : 'Alt', enter: '↵', esc: 'Esc', up: '↑', down: '↓', backspace: '⌫', del: 'Del', tab: 'Tab', space: 'Space' };
        const label = map[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : k);
        return `<kbd class="kbd">${esc(label)}</kbd>`;
      }).join('');
    return `<span class="kbd-group">${seq.map(part).join('<span class="kbd-then">then</span>')}</span>`;
  }
  function tip(label, k) { return ` data-tip="${esc(label)}"${k ? ` data-kbd="${esc(k)}"` : ''}`; }
  function btn({ label = '', icon, variant = '', size = '', k, tipText, action, attrs = '', iconOnly = false, data = '', cls: extra = '' }) {
    const cls = ['btn', variant && `btn--${variant}`, size && `btn--${size}`, iconOnly && 'btn--icon', extra].filter(Boolean).join(' ');
    const t = iconOnly ? tip(tipText || label, k) : tipText ? tip(tipText, k) : '';
    const aria = iconOnly ? ` aria-label="${esc(label)}"` : '';
    return `<button type="button" class="${cls}"${aria}${t}${action ? ` data-action="${action}"` : ''}${data} ${attrs}>${icon ? ic(icon, size === 'sm' ? 14 : 16) : ''}${iconOnly ? '' : `<span>${label}</span>`}${!iconOnly && k && !tipText ? kbd(k) : ''}</button>`;
  }
  function statusHtml(kind, text) { return `<span class="status status--${kind}"><span class="status__dot" aria-hidden="true"></span><span class="ellipsis">${esc(text)}</span></span>`; }
  const ENV_NAME = { prod: 'Production', staging: 'Staging', dev: 'Development', test: 'Test' };
  const ENV_SHORT = { prod: 'Prod', staging: 'Stg', dev: 'Dev', test: 'Test' };
  /* Env: nhãn môi trường chỉ ở cấp NHÓM (group / cluster / endpoint / account); host kế thừa, không lặp lại.
     Chip nhỏ tô màu theo môi trường: PROD đỏ · STG vàng · DEV xanh dương · TEST tím. */
  function envTag(env) { return env ? `<span class="env env--${env}" title="Environment: ${ENV_NAME[env]}">${ENV_SHORT[env]}</span>` : ''; }
  /** Trong list host (Home…): chỉ chấm đỏ cho PROD — môi trường khác đã có ở dòng phụ, chấm màu dễ bị đọc nhầm thành trạng thái. */
  function envDot(env) { return env === 'prod' ? `<span class="env env--${env} env--dot" role="img" aria-label="${ENV_NAME[env]}" title="${ENV_NAME[env]}"></span>` : ''; }
  /** Nhãn duy nhất trong breadcrumb header (cùng màu với chip ở hàng nhóm). */
  function envBadge(env) {
    if (!env) return '';
    return `<span class="env-badge${env === 'prod' ? '' : ' env-badge--' + env}" role="note" aria-label="Environment ${ENV_NAME[env]}">${env === 'prod' ? 'Prod' : ENV_SHORT[env]}</span>`;
  }
  /** Chip trạng thái (nền nhạt + chữ màu) — dùng ở header Inspector; trong bảng dùng statusHtml (chấm + chữ). */
  function chipHtml(kind, text) { return `<span class="badge${kind && kind !== 'neutral' ? ' badge--' + kind : ''}">${esc(text)}</span>`; }
  function meter(pct, label) {
    const cls = pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : '';
    return `<span class="meter"><span class="meter__track" aria-hidden="true"><span class="meter__fill ${cls ? 'meter__fill--' + cls : ''}" style="width:${Math.min(100, pct)}%"></span></span><span class="meter__value">${esc(label)}</span></span>`;
  }
  function spark(values, color = 'var(--chart-1)', h = 40) {
    const w = 300, max = Math.max(...values) * 1.15, min = 0;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - ((v - min) / (max - min)) * (h - 4) - 2]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="var(--chart-grid)" stroke-dasharray="2 3"/>
      <path d="${d} L${w} ${h} L0 ${h} Z" fill="${color}" opacity=".08"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
  }

  /* ---------------------------------------------------------------- 2. i18n
     Chỉ nhãn khung (shell) được dịch. Thuật ngữ kỹ thuật (Pod, Deployment, Namespace,
     Bucket, Container, Compose…) giữ tiếng Anh theo glossary. */
  const STR = {
    en: {
      home: 'Home', hosts: 'Hosts', files: 'Files', kubernetes: 'Kubernetes', docker: 'Docker', storage: 'Storage', transfers: 'Transfers', settings: 'Settings',
      search: 'Search', filter: 'Filter…', new: 'New', connected: 'Connected', vaultUnlocked: 'Vault unlocked', notifications: 'Notifications',
      lockVault: 'Lock vault', selected: 'selected', clear: 'Clear', restart: 'Restart', delete: 'Delete', copyNames: 'Copy names', cancel: 'Cancel',
      goodAfternoon: 'Good afternoon, Hiếu', homeSub: 'Saturday, 4 October · 3 sessions open · 2 items need attention',
      quickConnect: 'Quick connect', connect: 'Connect', recent: 'Recent', favorites: 'Favorites', needsAttention: 'Needs attention', getStarted: 'Get started',
      searchHosts: 'Search hosts', searchResources: 'Search resources', searchEndpoints: 'Search endpoints', searchBuckets: 'Search buckets', searchSettings: 'Search settings',
      inspector: 'Inspector', overview: 'Overview', events: 'Events', logs: 'Logs', yaml: 'YAML', metrics: 'Metrics', related: 'Related',
      sessions: 'sessions', tasks: 'transfers', language: 'Language', theme: 'Theme', explorer: 'Explorer', pinned: 'Pinned',
      groups: 'Groups', clusters: 'Clusters', endpoints: 'Endpoints', accounts: 'Accounts', active: 'Active', completed: 'Completed', failed: 'Failed'
    },
    vi: {
      home: 'Trang chủ', hosts: 'Máy chủ', files: 'Tệp', kubernetes: 'Kubernetes', docker: 'Docker', storage: 'Lưu trữ', transfers: 'Truyền tệp', settings: 'Cài đặt',
      search: 'Tìm kiếm', filter: 'Lọc…', new: 'Thêm mới', connected: 'Đã kết nối', vaultUnlocked: 'Kho khóa đang mở', notifications: 'Thông báo',
      lockVault: 'Khóa kho', selected: 'đã chọn', clear: 'Bỏ chọn', restart: 'Khởi động lại', delete: 'Xóa', copyNames: 'Sao chép tên', cancel: 'Hủy',
      goodAfternoon: 'Chào buổi chiều, Hiếu', homeSub: 'Thứ Bảy, 4 tháng 10 · 3 phiên đang mở · 2 mục cần chú ý',
      quickConnect: 'Kết nối nhanh', connect: 'Kết nối', recent: 'Gần đây', favorites: 'Yêu thích', needsAttention: 'Cần chú ý', getStarted: 'Bắt đầu',
      searchHosts: 'Tìm máy chủ', searchResources: 'Tìm tài nguyên', searchEndpoints: 'Tìm endpoint', searchBuckets: 'Tìm bucket', searchSettings: 'Tìm cài đặt',
      inspector: 'Chi tiết', overview: 'Tổng quan', events: 'Events', logs: 'Logs', yaml: 'YAML', metrics: 'Số liệu', related: 'Liên quan',
      sessions: 'phiên', tasks: 'tệp đang truyền', language: 'Ngôn ngữ', theme: 'Giao diện', explorer: 'Explorer', pinned: 'Đã ghim',
      groups: 'Nhóm', clusters: 'Cluster', endpoints: 'Endpoint', accounts: 'Tài khoản', active: 'Đang chạy', completed: 'Hoàn tất', failed: 'Lỗi'
    }
  };
  const t = (k) => (STR[state.lang] && STR[state.lang][k]) || STR.en[k] || k;

  /* ---------------------------------------------------------------- 3. State */
  const saved = (() => { try { return JSON.parse(localStorage.getItem('sh-proto') || '{}'); } catch { return {}; } })();
  const state = {
    route: 'home',
    lang: saved.lang || 'en',
    theme: saved.theme || 'dark',
    density: saved.density || 'comfortable',
    os: 'win',            // win | mac — chỉ ảnh hưởng nút cửa sổ trên title bar (frameless)
    explorer: true,
    inspector: true,
    inspectorTab: { pod: 'overview', container: 'overview', object: 'overview', account: 'overview', deploy: 'overview', helm: 'revisions', snippet: 'edit', image: 'overview' },
    panel: 'sftp',        // side panel của phiên terminal: sftp | forwards | none
    multi: false,         // MultiExec
    multiOn: new Set(['prod-web-01', 'prod-web-02', 'stg-web-01']),
    snippetActive: 'tail-log',
    imageActive: 'registry.shop.vn/api:5.2.0',
    helmActive: 'ingress-nginx',
    settingsSection: 'terminal',
    podSel: new Set(),
    podSort: { key: 'status', dir: 'asc' },
    podFilter: '',
    podFailing: false,
    podActive: 'web-7d9f8c6b5-h8sdl',
    podFocus: -1,
    podCols: { namespace: true, ready: true, status: true, restarts: true, cpu: true, mem: true, node: true, age: true },
    logQuery: 'heap',
    dockerView: 'containers',
    containerActive: 'shop-stack-api-1',
    containerSel: new Set(),
    envReveal: new Set(),
    objActive: 'hero-autumn.jpg',
    accountActive: 'deploy',
    hostTab: 'term',
    split: false,
    sftp: true,
    zoom: 1,
    graphHover: null,
    graphSelected: 'deploy/web',
    problemsOpen: true,
    transfers: [
      { name: 'hero-autumn@2x.jpg', dir: 'up', to: 's3://shop-media-assets/images/2026/', pct: 62, size: '6.1 MB' },
      { name: 'db-backup-2026-10-04.sql.gz', dir: 'down', to: 'prod-db-01:/var/backups', pct: 28, size: '1.84 GB' }
    ],
    notifications: 3
  };
  function persist() { try { localStorage.setItem('sh-proto', JSON.stringify({ lang: state.lang, theme: state.theme, density: state.density })); } catch (e) { /* file:// có thể chặn storage — bỏ qua */ } }

  /* ---------------------------------------------------------------- 4. Mock data */
  const HOST_GROUPS = [
    { id: 'prod', name: 'Production', env: 'prod', open: true, defaults: { account: 'deploy', jump: 'bastion-01', port: 22 }, hosts: [
      { id: 'prod-web-01', os: 'ubuntu', addr: '10.10.1.11', user: 'deploy', st: 'success', proto: 'ssh', fav: true, last: '2m ago', acct: 'deploy' },
      { id: 'prod-web-02', os: 'ubuntu', addr: '10.10.1.12', user: 'deploy', st: 'success', proto: 'ssh', last: '1h ago', acct: 'deploy' },
      { id: 'prod-db-01', os: 'debian', addr: '10.10.1.21', user: 'dba', st: 'success', proto: 'ssh', fav: true, last: '3h ago' },
      { id: 'prod-lb-01', os: 'alpine', addr: '10.10.1.5', user: 'root', st: 'success', proto: 'ssh', last: 'Yesterday' },
      { id: 'prod-ad-01', os: 'windows', addr: '10.10.1.40', user: 'administrator', st: 'success', proto: 'rdp', fav: true, last: '25m ago' }
    ] },
    { id: 'stg', name: 'Staging', env: 'staging', open: true, defaults: { account: 'deploy', jump: 'bastion-01', port: 22 }, hosts: [
      { id: 'stg-web-01', os: 'ubuntu', addr: '10.20.1.11', user: 'deploy', st: 'success', proto: 'ssh', last: 'Yesterday', acct: 'deploy' },
      { id: 'stg-db-01', os: 'rhel', addr: '10.20.1.21', user: 'dba', st: 'warning', proto: 'ssh', last: '2d ago', note: 'High load' }
    ] },
    { id: 'dev', name: 'Development', env: 'dev', open: true, defaults: { account: 'ci-runner', port: 22 }, hosts: [
      { id: 'dev-box', os: 'ubuntu', addr: '192.168.1.20', user: 'hieu', st: 'success', proto: 'ssh', fav: true, last: '5h ago' },
      { id: 'build-runner-01', os: 'debian', addr: '10.30.0.8', user: 'ci', st: 'off', proto: 'ssh', last: '6d ago', acct: 'ci-runner' },
      { id: 'mac-mini-ci', os: 'macos', addr: '10.30.0.12', user: 'ci', st: 'success', proto: 'ssh', last: '3d ago', acct: 'ci-runner' }
    ] },
    { id: 'net', name: 'Network gear', env: 'prod', open: false, hosts: [
      { id: 'core-sw-01', os: 'linux', addr: '10.10.0.2', user: 'admin', st: 'success', proto: 'telnet', last: '2w ago' },
      { id: 'ups-console', os: 'linux', addr: 'COM3 · 9600 8N1', user: '', st: 'off', proto: 'serial', last: '1mo ago' }
    ] },
    { id: 'lab', name: 'Lab', env: 'test', open: false, hosts: [
      { id: 'lab-k3s-01', os: 'alpine', addr: '172.16.0.4', user: 'root', st: 'success', proto: 'ssh', last: '2w ago' },
      { id: 'win-test-02', os: 'windows', addr: '172.16.0.9', user: 'administrator', st: 'off', proto: 'rdp', last: '1mo ago' }
    ] }
  ];
  const ALL_HOSTS = HOST_GROUPS.flatMap((g) => g.hosts.map((h) => ({ ...h, env: g.env, group: g.name })));
  const hostById = (id) => ALL_HOSTS.find((h) => h.id === id);

  const CLUSTERS = [
    { id: 'prod-cluster', env: 'prod', st: 'success', ver: 'v1.30.4', open: true, namespaces: [
      { id: 'shop', open: true, kinds: [['Pods', 14, 2], ['Deployments', 6, 1], ['StatefulSets', 1], ['Services', 7], ['Ingresses', 2], ['ConfigMaps', 9], ['Secrets', 7]] },
      { id: 'payments', kinds: [['Pods', 4, 1]] },
      { id: 'monitoring', kinds: [['Pods', 11]] },
      { id: 'kube-system', kinds: [['Pods', 18]] }
    ] },
    { id: 'staging-cluster', env: 'staging', st: 'success', ver: 'v1.31.1', namespaces: [] },
    { id: 'dev-k3s', env: 'dev', st: 'off', ver: 'v1.31.0+k3s1', namespaces: [] }
  ];

  // Pods — [name, ns, ready, status, restarts, cpu%, cpuLabel, mem%, memLabel, node, age, kind]
  const PODS = [
    ['web-7d9f8c6b5-h8sdl', 'shop', '0/1', 'CrashLoopBackOff', 23, 4, '12m', 98, '251Mi', 'pool-a-7xk2', '3h12m'],
    ['payments-worker-6f4d9-kq2m', 'payments', '0/1', 'ImagePullBackOff', 0, 0, '0m', 0, '0Mi', 'pool-b-1qz9', '18m'],
    ['search-5b8c7d9f4-p9wx2', 'shop', '0/1', 'Pending', 0, 0, '—', 0, '—', '—', '41m'],
    ['web-7d9f8c6b5-2xkqp', 'shop', '1/1', 'Running', 0, 38, '190m', 61, '156Mi', 'pool-a-7xk2', '3h12m'],
    ['web-7d9f8c6b5-mm7rt', 'shop', '1/1', 'Running', 1, 42, '210m', 66, '169Mi', 'pool-a-3jd8', '3h12m'],
    ['checkout-5c7b9d4f8-qw8e1', 'shop', '1/1', 'Running', 0, 24, '120m', 44, '225Mi', 'pool-a-3jd8', '2d4h'],
    ['checkout-5c7b9d4f8-zz91l', 'shop', '1/1', 'Running', 2, 27, '135m', 47, '240Mi', 'pool-b-1qz9', '2d4h'],
    ['cart-6b8f7d5c9-4lkd0', 'shop', '1/1', 'Running', 0, 12, '60m', 31, '80Mi', 'pool-a-7xk2', '6d'],
    ['catalog-7f9c8b6d5-a1b2c', 'shop', '1/1', 'Running', 0, 81, '405m', 72, '370Mi', 'pool-b-1qz9', '6d'],
    ['catalog-7f9c8b6d5-x9y8z', 'shop', '1/1', 'Running', 0, 76, '380m', 70, '360Mi', 'pool-a-3jd8', '6d'],
    ['redis-0', 'shop', '1/1', 'Running', 0, 6, '30m', 52, '532Mi', 'pool-b-1qz9', '14d'],
    ['redis-1', 'shop', '1/1', 'Running', 0, 5, '25m', 49, '501Mi', 'pool-a-7xk2', '14d'],
    ['payments-api-84c6d7b9f-vn3s', 'payments', '2/2', 'Running', 0, 33, '165m', 58, '298Mi', 'pool-b-1qz9', '1d2h'],
    ['payments-api-84c6d7b9f-7tgh', 'payments', '2/2', 'Running', 0, 31, '155m', 55, '281Mi', 'pool-a-3jd8', '1d2h'],
    ['mailer-cron-28795540-j2k4f', 'shop', '0/1', 'Completed', 0, 0, '0m', 0, '0Mi', 'pool-a-7xk2', '12m'],
    ['nginx-exporter-5d6c7-wq2pl', 'shop', '1/1', 'Running', 0, 2, '8m', 12, '24Mi', 'pool-a-3jd8', '9d']
  ].map((r) => ({ name: r[0], ns: r[1], ready: r[2], status: r[3], restarts: r[4], cpu: r[5], cpuL: r[6], mem: r[7], memL: r[8], node: r[9], age: r[10] }));
  const POD_STATUS_KIND = { Running: 'success', CrashLoopBackOff: 'danger', ImagePullBackOff: 'danger', Error: 'danger', Pending: 'warning', Completed: 'neutral', Terminating: 'neutral' };
  const POD_STATUS_RANK = { CrashLoopBackOff: 0, ImagePullBackOff: 0, Error: 0, Pending: 1, Running: 2, Completed: 3 };
  const isFailing = (p) => POD_STATUS_KIND[p.status] === 'danger' || p.status === 'Pending';

  const POD_EVENTS = [
    { type: 'Warning', reason: 'BackOff', count: 87, age: '38s', msg: 'Back-off restarting failed container web in pod web-7d9f8c6b5-h8sdl_shop', src: 'kubelet, pool-a-7xk2' },
    { type: 'Warning', reason: 'OOMKilled', count: 23, age: '2m', msg: 'Container web exceeded its memory limit (256Mi). Exit code 137.', src: 'kubelet, pool-a-7xk2' },
    { type: 'Warning', reason: 'Unhealthy', count: 12, age: '2m', msg: 'Readiness probe failed: Get "http://10.244.3.18:8080/healthz": dial tcp 10.244.3.18:8080: connect: connection refused', src: 'kubelet, pool-a-7xk2' },
    { type: 'Normal', reason: 'Pulled', count: 24, age: '3m', msg: 'Container image "registry.shop.vn/web:2.14.1" already present on machine', src: 'kubelet, pool-a-7xk2' },
    { type: 'Normal', reason: 'Created', count: 24, age: '3m', msg: 'Created container web', src: 'kubelet, pool-a-7xk2' },
    { type: 'Normal', reason: 'Started', count: 24, age: '3m', msg: 'Started container web', src: 'kubelet, pool-a-7xk2' },
    { type: 'Normal', reason: 'Scheduled', count: 1, age: '3h12m', msg: 'Successfully assigned shop/web-7d9f8c6b5-h8sdl to pool-a-7xk2', src: 'default-scheduler' }
  ];
  const POD_LOGS = [
    ['14:02:11.204', 'inf', 'server listening on :8080 (pid 1, node v22.9.0)'],
    ['14:02:11.390', 'inf', 'connected to redis://redis.shop.svc:6379'],
    ['14:02:12.017', 'inf', 'warming product cache: 48,210 items'],
    ['14:02:14.552', 'dbg', 'cache shard 1/8 loaded in 612ms'],
    ['14:02:17.880', 'wrn', 'GC pause 412ms (heap used 228MB / limit 256MB)'],
    ['14:02:19.101', 'wrn', 'cache shard 4/8 loaded in 1.9s — memory pressure'],
    ['14:02:20.613', 'err', '<--- Last few GCs ---> [1:0x5f3a] 9201 ms: Mark-Compact 249.8 (258.1) -> 247.9 (258.9) MB'],
    ['14:02:20.614', 'err', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    ['14:02:20.618', 'err', ' 1: 0xb8d0a0 node::Abort() [node]'],
    ['14:02:20.702', 'inf', 'container exited with code 137 (OOMKilled)']
  ];

  /* Topology (namespace shop) */
  const TOPO = {
    lanes: [
      { id: 'entry', label: 'Entry', kind: 'Ingress' },
      { id: 'svc', label: 'Services', kind: 'Service' },
      { id: 'wl', label: 'Workloads', kind: 'Deployment · StatefulSet' },
      { id: 'pod', label: 'Pods', kind: 'Pod' }
    ],
    nodes: [
      { id: 'ing/shop', lane: 'entry', icon: 'ingress', name: 'shop.vn', meta: 'Ingress · nginx · TLS' },
      { id: 'ing/api', lane: 'entry', icon: 'ingress', name: 'api.shop.vn', meta: 'Ingress · nginx · TLS' },
      { id: 'svc/web', lane: 'svc', icon: 'service', name: 'web', meta: 'ClusterIP · :80 → 8080' },
      { id: 'svc/catalog', lane: 'svc', icon: 'service', name: 'catalog', meta: 'ClusterIP · :80' },
      { id: 'svc/cart', lane: 'svc', icon: 'service', name: 'cart', meta: 'ClusterIP · :80' },
      { id: 'svc/checkout', lane: 'svc', icon: 'service', name: 'checkout', meta: 'ClusterIP · :8080' },
      { id: 'svc/search', lane: 'svc', icon: 'service', name: 'search', meta: 'ClusterIP · 0 endpoints', problem: 'No endpoints', sev: 'danger' },
      { id: 'svc/redis', lane: 'svc', icon: 'service', name: 'redis', meta: 'Headless · :6379' },
      { id: 'deploy/web', lane: 'wl', icon: 'workload', name: 'web', meta: 'Deployment · 2/3', problem: 'Degraded', sev: 'warning', pods: ['ok', 'ok', 'bad'] },
      { id: 'deploy/catalog', lane: 'wl', icon: 'workload', name: 'catalog', meta: 'Deployment · 2/2', pods: ['ok', 'ok'] },
      { id: 'deploy/cart', lane: 'wl', icon: 'workload', name: 'cart', meta: 'Deployment · 1/1', pods: ['ok'] },
      { id: 'deploy/checkout', lane: 'wl', icon: 'workload', name: 'checkout', meta: 'Deployment · 2/2', pods: ['ok', 'ok'] },
      { id: 'deploy/search', lane: 'wl', icon: 'workload', name: 'search', meta: 'Deployment · 0/1', problem: 'Unschedulable', sev: 'danger', pods: ['pend'] },
      { id: 'sts/redis', lane: 'wl', icon: 'layers', name: 'redis', meta: 'StatefulSet · 2/2', pods: ['ok', 'ok'] },
      { id: 'pod/web-2xkqp', lane: 'pod', icon: 'pod', name: 'web-7d9f8c6b5-2xkqp', meta: 'Running · pool-a-7xk2', st: 'success' },
      { id: 'pod/web-mm7rt', lane: 'pod', icon: 'pod', name: 'web-7d9f8c6b5-mm7rt', meta: 'Running · pool-a-3jd8', st: 'success' },
      { id: 'pod/web-h8sdl', lane: 'pod', icon: 'pod', name: 'web-7d9f8c6b5-h8sdl', meta: '23 restarts · OOMKilled', st: 'danger', problem: 'CrashLoop', sev: 'danger' },
      { id: 'pod/catalog-a1b2c', lane: 'pod', icon: 'pod', name: 'catalog-7f9c8b6d5-a1b2c', meta: 'Running · CPU 81%', st: 'success' },
      { id: 'pod/catalog-x9y8z', lane: 'pod', icon: 'pod', name: 'catalog-7f9c8b6d5-x9y8z', meta: 'Running · CPU 76%', st: 'success' },
      { id: 'pod/cart-4lkd0', lane: 'pod', icon: 'pod', name: 'cart-6b8f7d5c9-4lkd0', meta: 'Running · pool-a-7xk2', st: 'success' },
      { id: 'pod/checkout-qw8e1', lane: 'pod', icon: 'pod', name: 'checkout-5c7b9d4f8-qw8e1', meta: 'Running · pool-a-3jd8', st: 'success' },
      { id: 'pod/checkout-zz91l', lane: 'pod', icon: 'pod', name: 'checkout-5c7b9d4f8-zz91l', meta: 'Running · 2 restarts', st: 'success' },
      { id: 'pod/search-p9wx2', lane: 'pod', icon: 'pod', name: 'search-5b8c7d9f4-p9wx2', meta: 'Pending · 41m', st: 'warning', problem: 'Pending', sev: 'warning' },
      { id: 'pod/redis-0', lane: 'pod', icon: 'pod', name: 'redis-0', meta: 'Running · pool-b-1qz9', st: 'success' },
      { id: 'pod/redis-1', lane: 'pod', icon: 'pod', name: 'redis-1', meta: 'Running · pool-a-7xk2', st: 'success' }
    ],
    edges: [
      ['ing/shop', 'svc/web'], ['ing/shop', 'svc/catalog'], ['ing/shop', 'svc/cart'],
      ['ing/api', 'svc/checkout'], ['ing/api', 'svc/search', 'problem'],
      ['svc/web', 'deploy/web'], ['svc/catalog', 'deploy/catalog'], ['svc/cart', 'deploy/cart'], ['svc/checkout', 'deploy/checkout'], ['svc/search', 'deploy/search', 'problem'], ['svc/redis', 'sts/redis'],
      ['deploy/web', 'pod/web-2xkqp'], ['deploy/web', 'pod/web-mm7rt'], ['deploy/web', 'pod/web-h8sdl', 'problem'],
      ['deploy/catalog', 'pod/catalog-a1b2c'], ['deploy/catalog', 'pod/catalog-x9y8z'], ['deploy/cart', 'pod/cart-4lkd0'],
      ['deploy/checkout', 'pod/checkout-qw8e1'], ['deploy/checkout', 'pod/checkout-zz91l'], ['deploy/search', 'pod/search-p9wx2', 'problem'],
      ['sts/redis', 'pod/redis-0'], ['sts/redis', 'pod/redis-1']
    ],
    problems: [
      { sev: 'danger', node: 'pod/web-h8sdl', title: 'web-7d9f8c6b5-h8sdl is crash-looping', desc: 'Killed for exceeding its 256Mi memory limit 23 times. Peak usage before kill: ~310Mi.' },
      { sev: 'danger', node: 'deploy/search', title: 'search cannot be scheduled', desc: 'Requests 2 CPU; the largest free slot is 1.2 CPU on pool-b. Ingress api.shop.vn/search returns 503.' },
      { sev: 'warning', node: 'deploy/web', title: 'web is running degraded (2 of 3)', desc: 'Traffic is served by 2 healthy Pods. Capacity is reduced by 33%.' }
    ]
  };

  const DOCKER_ENDPOINTS = [
    { id: 'local', name: 'Local', meta: 'unix:///var/run/docker.sock', st: 'success', count: 4 },
    { id: 'build-server', name: 'build-server', meta: 'ssh://deploy@10.20.2.5', st: 'success', env: 'staging', count: 13, open: true },
    { id: 'edge-01', name: 'edge-01', meta: 'tcp://edge-01:2376 · TLS', st: 'warning', env: 'prod', count: 6 },
    { id: 'old-ci', name: 'old-ci', meta: 'ssh://ci@10.30.0.3', st: 'off', count: 0 }
  ];
  // [name, project, service, image, state, health, cpu, mem, memL, ports, uptime]
  const CONTAINERS = [
    ['shop-stack-web-1', 'shop-stack', 'web', 'registry.shop.vn/web:2.14.1', 'running', 'healthy', 3.2, 18, '182 MiB', ['8080→80'], 'Up 2 days'],
    ['shop-stack-api-1', 'shop-stack', 'api', 'registry.shop.vn/api:5.2.0', 'running', 'unhealthy', 47.8, 71, '1.39 GiB', ['3000→3000'], 'Up 2 days'],
    ['shop-stack-worker-1', 'shop-stack', 'worker', 'registry.shop.vn/worker:5.2.0', 'running', 'healthy', 12.4, 33, '640 MiB', [], 'Up 2 days'],
    ['shop-stack-worker-2', 'shop-stack', 'worker', 'registry.shop.vn/worker:5.2.0', 'running', 'healthy', 11.9, 31, '612 MiB', [], 'Up 2 days'],
    ['shop-stack-postgres-1', 'shop-stack', 'postgres', 'postgres:16.4-alpine', 'running', 'healthy', 6.1, 42, '820 MiB', ['5432→5432'], 'Up 9 days'],
    ['shop-stack-redis-1', 'shop-stack', 'redis', 'redis:7.4-alpine', 'running', 'healthy', 0.8, 6, '118 MiB', [], 'Up 9 days'],
    ['monitoring-grafana-1', 'monitoring', 'grafana', 'grafana/grafana:11.2.0', 'running', 'healthy', 1.1, 9, '176 MiB', ['3001→3000'], 'Up 14 days'],
    ['monitoring-prometheus-1', 'monitoring', 'prometheus', 'prom/prometheus:v2.54.1', 'running', 'starting', 8.4, 28, '548 MiB', ['9090→9090'], 'Up 12 seconds'],
    ['monitoring-node-exporter-1', 'monitoring', 'node-exporter', 'prom/node-exporter:v1.8.2', 'running', '', 0.3, 1, '21 MiB', ['9100→9100'], 'Up 14 days'],
    ['legacy-crm-app-1', 'legacy-crm', 'app', 'crm/app:1.9.3', 'exited', '', 0, 0, '—', [], 'Exited (1) 3 hours ago'],
    ['legacy-crm-db-1', 'legacy-crm', 'db', 'mysql:5.7', 'exited', '', 0, 0, '—', [], 'Exited (0) 3 hours ago'],
    ['traefik', '', '', 'traefik:v3.1', 'running', 'healthy', 0.9, 3, '64 MiB', ['80→80', '443→443'], 'Up 21 days'],
    ['watchtower', '', '', 'containrrr/watchtower:1.7.1', 'paused', '', 0, 1, '12 MiB', [], 'Paused']
  ].map((r) => ({ name: r[0], project: r[1], service: r[2], image: r[3], state: r[4], health: r[5], cpu: r[6], mem: r[7], memL: r[8], ports: r[9], uptime: r[10] }));
  const COMPOSE = [
    { name: 'shop-stack', file: '/srv/shop/compose.yaml', open: true },
    { name: 'monitoring', file: '/srv/monitoring/compose.yaml', open: true },
    { name: 'legacy-crm', file: '/opt/crm/docker-compose.yml', open: true }
  ];

  const S3_ACCOUNTS = [
    { id: 'aws-media', name: 'aws-media', prov: 'aws', meta: 'AWS · ap-southeast-1', open: true, buckets: ['shop-media-assets', 'shop-backups', 'shop-logs-archive', 'terraform-state'] },
    { id: 'minio-lab', name: 'minio-lab', prov: 'minio', meta: 'MinIO · minio.lab.local', env: 'dev', open: true, buckets: ['ci-artifacts', 'test-uploads'] }
  ];
  const BUCKETS = [
    { name: 'shop-media-assets', region: 'ap-southeast-1', objects: '48,210', size: '182.4 GB', versioning: true, access: 'public-read', created: '2023-04-12' },
    { name: 'shop-backups', region: 'ap-southeast-1', objects: '1,204', size: '2.31 TB', versioning: true, access: 'private', created: '2022-11-02' },
    { name: 'shop-logs-archive', region: 'ap-southeast-1', objects: '913,557', size: '640.9 GB', versioning: false, access: 'private', created: '2022-11-02' },
    { name: 'terraform-state', region: 'ap-southeast-1', objects: '37', size: '4.2 MB', versioning: true, access: 'private', created: '2022-08-19' }
  ];
  const OBJECTS = [
    { name: 'banners/', folder: true, modified: '—', count: '128 objects' },
    { name: 'products/', folder: true, modified: '—', count: '4,812 objects' },
    { name: 'thumbnails/', folder: true, modified: '—', count: '4,812 objects' },
    { name: 'hero-autumn.jpg', type: 'image', size: '2.4 MB', modified: 'Oct 3, 2026 16:42', cls: 'STANDARD' },
    { name: 'hero-autumn@2x.jpg', type: 'image', size: '6.1 MB', modified: 'Uploading…', cls: 'STANDARD', uploading: true },
    { name: 'sale-1010.webp', type: 'image', size: '812 KB', modified: 'Oct 1, 2026 09:15', cls: 'STANDARD' },
    { name: 'logo.svg', type: 'code', size: '6.3 KB', modified: 'Sep 12, 2026 11:03', cls: 'STANDARD' },
    { name: 'catalog-q4.pdf', type: 'text', size: '18.2 MB', modified: 'Sep 28, 2026 14:20', cls: 'STANDARD_IA' },
    { name: 'promo-video.mp4', type: 'film', size: '148.7 MB', modified: 'Sep 30, 2026 10:00', cls: 'STANDARD' },
    { name: 'manifest.json', type: 'code', size: '1.2 KB', modified: 'Oct 3, 2026 16:44', cls: 'STANDARD' },
    { name: 'hero-summer-2025.jpg', type: 'image', size: '2.2 MB', modified: 'Jun 1, 2025 08:00', cls: 'GLACIER_IR' }
  ];

  const ACCOUNTS = [
    { id: 'deploy', user: 'deploy', auth: ['key', 'passphrase'], keyType: 'ED25519', fp: 'SHA256:q8V…w3Ks', hosts: ['prod-web-01', 'prod-web-02', 'stg-web-01', 'prod-lb-01', 'dev-box', 'lab-k3s-01', 'stg-db-01'], last: '2m ago', updated: 'Aug 14, 2026', desc: 'Web tier deploy user' },
    { id: 'administrator', user: 'administrator', auth: ['password'], hosts: ['prod-ad-01', 'win-test-02'], last: '25m ago', updated: 'Mar 3, 2026', desc: 'Windows local admin (RDP)', warn: 'Password is 215 days old' },
    { id: 'ci-runner', user: 'ci', auth: ['key'], keyType: 'RSA 4096', fp: 'SHA256:7nB…pQ0e', hosts: ['build-runner-01', 'mac-mini-ci', 'dev-box'], last: '3d ago', updated: 'Jan 20, 2026', desc: 'CI/CD agents' },
    { id: 'dba', user: 'dba', auth: ['key', 'password'], keyType: 'ED25519', fp: 'SHA256:Lm2…Xa91', hosts: ['prod-db-01', 'stg-db-01'], last: '3h ago', updated: 'Jul 2, 2026', desc: 'Database operators (key + sudo password)' },
    { id: 'readonly-audit', user: 'audit', auth: ['key', 'passphrase'], keyType: 'ECDSA P-256', fp: 'SHA256:c0F…tt7Y', hosts: [], last: 'Never', updated: 'Sep 30, 2026', desc: 'Read-only auditor access' }
  ];

  const SNIPPETS = [
    { id: 'tail-log', name: 'Tail a log file', cmd: 'tail -n {{lines:100}} -f {{file}}', tags: ['logs'], scope: 'All hosts', used: '2h ago', runs: 48 },
    { id: 'disk', name: 'Disk usage by folder', cmd: 'sudo du -h --max-depth=1 {{path:/var}} | sort -h | tail -n 20', tags: ['disk'], scope: 'All hosts', used: 'Yesterday', runs: 21 },
    { id: 'restart-svc', name: 'Restart a systemd service', cmd: 'sudo systemctl restart {{service}} && systemctl status {{service}} --no-pager', tags: ['systemd'], scope: 'Production, Staging', used: '3d ago', runs: 12 },
    { id: 'deploy', name: 'Deploy release', cmd: 'cd /srv/shop\n./deploy.sh {{version}}\ndocker compose ps', tags: ['deploy'], scope: 'Production', used: '5d ago', runs: 9, macro: true },
    { id: 'pg-conn', name: 'Postgres connections', cmd: "psql -U {{user:postgres}} -c \"select state, count(*) from pg_stat_activity group by 1\"", tags: ['db'], scope: 'prod-db-01', used: '1w ago', runs: 6 },
    { id: 'ports', name: 'Listening ports', cmd: 'sudo ss -tulpn', tags: ['network'], scope: 'All hosts', used: '2w ago', runs: 30 }
  ];
  const FORWARDS = [
    { kind: 'L', bind: '127.0.0.1:5433', dest: 'prod-db-01.internal:5432', st: 'running', auto: true, saved: true, traffic: '↑ 1.2 MB  ↓ 18.4 MB', note: 'Postgres (read replica)' },
    { kind: 'L', bind: '127.0.0.1:9091', dest: 'localhost:9090', st: 'running', auto: false, saved: true, traffic: '↑ 84 KB  ↓ 2.1 MB', note: 'Prometheus UI' },
    { kind: 'D', bind: '127.0.0.1:1080', dest: 'SOCKS5', st: 'stopped', auto: false, saved: true, traffic: '', note: 'Browse the private network' },
    { kind: 'R', bind: 'server :8022', dest: 'localhost:22', st: 'failed', auto: false, saved: false, traffic: '', note: 'Port 8022 already in use on the server' }
  ];
  const IMAGES = [
    { repo: 'registry.shop.vn/api', tag: '5.2.0', id: 'b41e9c07aa21', size: '412 MB', created: '2 days ago', used: 1 },
    { repo: 'registry.shop.vn/web', tag: '2.14.1', id: '9f2d71c3e0b8', size: '188 MB', created: '2 days ago', used: 1 },
    { repo: 'registry.shop.vn/worker', tag: '5.2.0', id: '33c0a8f61d92', size: '398 MB', created: '2 days ago', used: 2 },
    { repo: 'postgres', tag: '16.4-alpine', id: '6c1d0f3b9e44', size: '243 MB', created: '5 weeks ago', used: 1 },
    { repo: 'redis', tag: '7.4-alpine', id: 'e0b9f7d2c1a8', size: '41 MB', created: '6 weeks ago', used: 1 },
    { repo: 'grafana/grafana', tag: '11.2.0', id: '1a8c3e5f7b90', size: '465 MB', created: '2 months ago', used: 1 },
    { repo: 'prom/prometheus', tag: 'v2.54.1', id: '7d2f9a1c0e3b', size: '292 MB', created: '2 months ago', used: 1 },
    { repo: 'registry.shop.vn/api', tag: '5.1.4', id: '0e7c2a9d4f15', size: '409 MB', created: '3 weeks ago', used: 0 },
    { repo: 'registry.shop.vn/web', tag: '2.13.0', id: '5b3d8e0a2c71', size: '186 MB', created: '1 month ago', used: 0 },
    { repo: '<none>', tag: '<none>', id: 'c9a07e3f1b2d', size: '1.12 GB', created: '1 month ago', used: 0, dangling: true },
    { repo: 'mysql', tag: '5.7', id: 'f3e1b8c0d927', size: '501 MB', created: '1 year ago', used: 1 }
  ];
  const VOLUMES = [
    { name: 'shop-stack_pgdata', driver: 'local', size: '6.8 GB', used: ['shop-stack-postgres-1'], created: '9 days ago' },
    { name: 'shop-stack_cache', driver: 'local', size: '312 MB', used: ['shop-stack-api-1'], created: '9 days ago' },
    { name: 'monitoring_prometheus', driver: 'local', size: '14.2 GB', used: ['monitoring-prometheus-1'], created: '3 months ago' },
    { name: 'monitoring_grafana', driver: 'local', size: '88 MB', used: ['monitoring-grafana-1'], created: '3 months ago' },
    { name: 'legacy-crm_mysql', driver: 'local', size: '2.1 GB', used: ['legacy-crm-db-1'], created: '1 year ago' },
    { name: 'backups-nfs', driver: 'local · nfs', size: '—', used: [], created: '6 months ago' },
    { name: '3f9c0e…a71b', driver: 'local', size: '640 MB', used: [], created: '2 months ago', anon: true }
  ];
  const NETWORKS = [
    { name: 'shop-stack_default', driver: 'bridge', subnet: '172.19.0.0/16', containers: 6, scope: 'local' },
    { name: 'monitoring_default', driver: 'bridge', subnet: '172.20.0.0/16', containers: 3, scope: 'local' },
    { name: 'proxy', driver: 'bridge', subnet: '172.28.0.0/16', containers: 4, scope: 'local', attachable: true },
    { name: 'bridge', driver: 'bridge', subnet: '172.17.0.0/16', containers: 1, scope: 'local', builtin: true },
    { name: 'host', driver: 'host', subnet: '—', containers: 0, scope: 'local', builtin: true },
    { name: 'none', driver: 'null', subnet: '—', containers: 0, scope: 'local', builtin: true }
  ];
  const DEPLOYMENTS = [
    { name: 'web', ready: '2/3', upToDate: 3, avail: 2, image: 'registry.shop.vn/web:2.14.1', rev: 14, age: '41d', st: 'warning', strategy: 'RollingUpdate 25% / 25%' },
    { name: 'search', ready: '0/1', upToDate: 1, avail: 0, image: 'registry.shop.vn/search:1.8.0', rev: 6, age: '41m', st: 'danger', strategy: 'RollingUpdate 25% / 25%' },
    { name: 'catalog', ready: '2/2', upToDate: 2, avail: 2, image: 'registry.shop.vn/catalog:3.4.2', rev: 22, age: '62d', st: 'success', strategy: 'RollingUpdate 25% / 25%' },
    { name: 'checkout', ready: '2/2', upToDate: 2, avail: 2, image: 'registry.shop.vn/checkout:4.0.7', rev: 31, age: '62d', st: 'success', strategy: 'RollingUpdate 1 / 0' },
    { name: 'cart', ready: '1/1', upToDate: 1, avail: 1, image: 'registry.shop.vn/cart:1.12.0', rev: 9, age: '62d', st: 'success', strategy: 'Recreate' },
    { name: 'nginx-exporter', ready: '1/1', upToDate: 1, avail: 1, image: 'nginx/nginx-prometheus-exporter:1.3', rev: 2, age: '9d', st: 'success', strategy: 'RollingUpdate 25% / 25%' }
  ];
  const HELM = [
    { name: 'ingress-nginx', ns: 'ingress-nginx', chart: 'ingress-nginx-4.11.2', app: '1.11.2', rev: 7, st: 'deployed', updated: '3 days ago' },
    { name: 'cert-manager', ns: 'cert-manager', chart: 'cert-manager-v1.15.3', app: 'v1.15.3', rev: 4, st: 'deployed', updated: '3 weeks ago' },
    { name: 'kube-prometheus-stack', ns: 'monitoring', chart: 'kube-prometheus-stack-62.7.0', app: 'v0.76.1', rev: 12, st: 'deployed', updated: '6 days ago' },
    { name: 'shop', ns: 'shop', chart: 'shop-2.14.1', app: '2.14.1', rev: 58, st: 'failed', updated: '3 hours ago', note: 'post-upgrade hook "db-migrate" failed: BackoffLimitExceeded' },
    { name: 'redis', ns: 'shop', chart: 'redis-20.1.3', app: '7.4.0', rev: 3, st: 'deployed', updated: '2 months ago' },
    { name: 'loki', ns: 'monitoring', chart: 'loki-6.12.0', app: '3.1.1', rev: 2, st: 'pending-upgrade', updated: '1 minute ago' }
  ];
  const KNOWN_HOSTS = [
    ['prod-web-01.shop.vn', 'ED25519', 'SHA256:q2Fv…9wLk', 'Aug 14, 2026', ''],
    ['10.10.1.21', 'ED25519', 'SHA256:Tz8K…pa0E', 'Jul 2, 2026', ''],
    ['bastion-01.shop.vn', 'ECDSA', 'SHA256:mN3c…Qe7d', 'Jan 9, 2026', ''],
    ['stg-db-01', 'RSA 3072', 'SHA256:4hJx…Lr2s', 'Oct 4, 2026', 'changed'],
    ['github.com', 'ED25519', 'SHA256:+DiY…5PdQ', 'Mar 1, 2025', '']
  ];
  const SSH_KEYS = [
    ['laptop-2026', 'ED25519', '256', 'deploy, dba', 'Aug 14, 2026', true],
    ['ci-runner', 'RSA', '4096', 'ci-runner', 'Jan 20, 2026', false],
    ['audit-readonly', 'ECDSA', '256', 'readonly-audit', 'Sep 30, 2026', true],
    ['old-mac', 'RSA', '2048', '—', 'Feb 2, 2023', false]
  ];
  const XFERS = [
    { id: 1, name: 'hero-autumn@2x.jpg', dir: 'up', src: '~/Pictures/campaign/', dst: 's3://shop-media-assets/images/2026/', pct: 62, size: '6.1 MB', speed: '3.4 MB/s', eta: '1s', st: 'active', via: 'S3' },
    { id: 2, name: 'db-backup-2026-10-04.sql.gz', dir: 'down', src: 'prod-db-01:/var/backups/', dst: '~/Downloads/', pct: 28, size: '1.84 GB', speed: '11.8 MB/s', eta: '1m 52s', st: 'active', via: 'SFTP' },
    { id: 3, name: 'release-2.15.0.tar.gz', dir: 'up', src: '~/build/', dst: 'prod-web-01:/srv/shop/releases/', pct: 0, size: '84.6 MB', st: 'queued', via: 'SFTP' },
    { id: 4, name: 'grafana-dashboards/ (42 files)', dir: 'down', src: 'monitoring-grafana-1:/var/lib/grafana/', dst: '~/Downloads/', pct: 0, size: '3.2 MB', st: 'queued', via: 'Docker' },
    { id: 5, name: 'access-2026-10.log', dir: 'down', src: 'prod-lb-01:/var/log/nginx/', dst: '~/logs/', pct: 41, size: '612 MB', st: 'failed', err: 'Connection reset by peer at 41% (251 MB)', via: 'SFTP' },
    { id: 6, name: 'catalog-q4.pdf', dir: 'up', src: '~/Documents/', dst: 's3://shop-media-assets/images/2026/', pct: 100, size: '18.2 MB', st: 'done', when: '12m ago', via: 'S3' },
    { id: 7, name: 'nginx.conf', dir: 'up', src: 'editor', dst: 'prod-lb-01:/etc/nginx/', pct: 100, size: '4.1 KB', st: 'done', when: '1h ago', via: 'SFTP', note: 'Saved to server' },
    { id: 8, name: 'release-2.14.1.tar.gz', dir: 'up', src: '~/build/', dst: 'prod-web-01:/srv/shop/releases/', pct: 100, size: '84.0 MB', st: 'done', when: '3h ago', via: 'SFTP', note: '(resumed)' }
  ];
  const LOCAL_FILES = [['..', 1], ['build', 1, '', 'Oct 4 11:02'], ['campaign', 1, '', 'Oct 3 16:40'], ['notes', 1, '', 'Sep 28 09:12'], ['release-2.15.0.tar.gz', 0, '84.6 MB', 'Oct 4 13:51'], ['shop.env.example', 0, '1.1 KB', 'Sep 12 10:03'], ['nginx.conf', 0, '4.1 KB', 'Oct 4 12:58'], ['db-schema.sql', 0, '38 KB', 'Aug 30 17:20'], ['README.md', 0, '2.3 KB', 'Jul 1 08:44']];
  const REMOTE_FILES = [['..', 1, '', '', 'drwxr-xr-x'], ['config', 1, '', 'Sep 30 08:15', 'drwxr-xr-x'], ['logs', 1, '', 'Oct 4 13:59', 'drwxr-xr-x'], ['releases', 1, '', 'Oct 4 11:20', 'drwxr-xr-x'], ['.env.production', 0, '612 B', 'Oct 4 11:18', '-rw-------'], ['compose.yaml', 0, '1.8 KB', 'Oct 3 17:41', '-rw-r--r--'], ['deploy.sh', 0, '942 B', 'Sep 12 10:03', '-rwxr-xr-x'], ['healthcheck.sh', 0, '220 B', 'Sep 12 10:03', '-rwxr-xr-x'], ['VERSION', 0, '7 B', 'Oct 4 11:20', '-rw-r--r--']];

  /* ---------------------------------------------------------------- 5. Shell */
  const ACTIVITIES = [
    { id: 'home', route: 'home', icon: 'home', k: 'g h' },
    { id: 'hosts', route: 'hosts', icon: 'server', k: 'g s' },
    { id: 'files', route: 'files', icon: 'folder', k: 'g f' },
    { id: 'k8s', route: 'k8s/pods', icon: 'k8s', k: 'g k', label: 'kubernetes', badge: true },
    { id: 'docker', route: 'docker', icon: 'container', k: 'g d' },
    { id: 'storage', route: 's3/objects', icon: 'bucket', k: 'g b' },
    { id: 'transfers', route: 'transfers', icon: 'transfers', k: 'g t', count: () => state.transfers.length }
  ];

  function renderActivityBar(act) {
    const item = (a) => {
      const label = t(a.label || a.id);
      const cnt = a.count ? a.count() : 0;
      return `<a href="#/${a.route}" class="ab-item" aria-label="${esc(label)}"${act === a.id ? ' aria-current="page"' : ''}${tip(label, a.k)} data-tip-side="right">
        ${ic(a.icon, 18)}${a.badge ? '<span class="ab-badge" aria-label="Has problems"></span>' : ''}${cnt ? `<span class="ab-count">${cnt}</span>` : ''}</a>`;
    };
    $('#activitybar').innerHTML = `
      ${ACTIVITIES.slice(0, 1).map(item).join('')}
      <div class="ab-sep" role="separator"></div>
      ${ACTIVITIES.slice(1).map(item).join('')}
      <div class="ab-spacer"></div>
      <a href="#/settings/terminal" class="ab-item" aria-label="${t('settings')}"${act === 'settings' ? ' aria-current="page"' : ''}${tip(t('settings'), 'mod+,')} data-tip-side="right">${ic('settings', 18)}</a>
      <button type="button" class="ab-avatar" data-action="vault-menu" aria-label="Account and vault"${tip(t('vaultUnlocked') + ' · ' + t('lockVault'), 'mod+shift+L')} data-tip-side="right">
        <span class="avatar">HN</span><span class="lock">${ic('unlock', 10)}</span></button>`;
  }

  /* Title bar tự vẽ — Electron frameless:
     • Windows/Linux: nút −/□/× bên phải (titleBarOverlay hoặc nút tự vẽ, 46×38px như Win11).
     • macOS: đèn giao thông inset bên trái (trafficLightPosition {x:14, y:13}).
     Toàn bộ thanh là vùng kéo (app-region: drag); mọi nút là no-drag. */
  function renderTitlebar() {
    const mac = state.os === 'mac';
    $('#titlebar').innerHTML = `
      ${mac ? '<span class="tb-traffic" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}
      <span class="tb-brand"><span class="ab-logo" aria-hidden="true">${ic('terminal', 12)}</span>${mac ? '' : 'Shellhouse'}</span>
      <span class="tb-nav no-drag">
        ${btn({ label: 'Back', icon: 'arrow-left', variant: 'ghost', iconOnly: true, k: 'alt+left', action: 'nav-back', size: 'sm' })}
        ${btn({ label: 'Forward', icon: 'arrow-right', variant: 'ghost', iconOnly: true, k: 'alt+right', action: 'nav-fwd', size: 'sm' })}
      </span>
      <div class="tb-center no-drag"><button type="button" class="tb-search" data-action="cmdk" aria-label="Search or run a command"${tip('Command palette', 'mod+K')}>${ic('search', 14)}<span>Search hosts, resources, commands…</span>${kbd('mod+K')}</button></div>
      <div class="tb-right">
        <span class="tb-ws no-drag"${tip('Workspace: saved layout of tabs and splits')}>${ic('grid', 12)}Prod web + DB</span>
        ${mac ? '' : `<div class="tb-winctl" role="group" aria-label="Window controls">
          <button type="button" aria-label="Minimize"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor"/></svg></button>
          <button type="button" aria-label="Maximize"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg></button>
          <button type="button" class="close" aria-label="Close"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0 0 10" stroke="currentColor"/></svg></button></div>`}
      </div>`;
  }

  function treeItem(o) {
    const indent = (o.level || 0) * 14;
    const chev = o.expanded === undefined ? (o.level ? '<span class="tree__chev-spacer"></span>' : '') : `<span class="tree__chev">${ic('chevron-down', 12)}</span>`;
    const tag = o.href ? 'a' : 'button';
    const attrs = [
      o.href ? `href="${o.href}"` : 'type="button"',
      `role="treeitem"`,
      o.expanded !== undefined ? `aria-expanded="${o.expanded}"` : '',
      o.selected ? 'aria-selected="true"' : 'aria-selected="false"',
      o.action ? `data-action="${o.action}"` : '',
      o.data || '',
      `style="--indent:${indent}px"`,
      `aria-level="${(o.level || 0) + 1}"`
    ].join(' ');
    return `<${tag} class="tree__item" ${attrs}>${chev}${o.iconHtml || (o.icon ? ic(o.icon, 16) : '')}<span class="tree__label">${o.label}</span>${o.right || ''}${o.meta !== undefined ? `<span class="tree__meta${o.metaCls ? ' tree__meta--' + o.metaCls : ''}">${o.meta}</span>` : ''}</${tag}>`;
  }
  const groupLabel = (label, actions = '') => `<div class="tree__group-label" role="presentation"><span>${label}</span><span class="spacer"></span>${actions}</div>`;

  function renderExplorer(ex) {
    $('#explorer-head').innerHTML = `
      <div class="explorer__title">${ex.title}</div>
      ${ex.newAction ? btn({ label: ex.newLabel || t('new'), icon: 'plus', variant: 'ghost', iconOnly: true, k: 'n', action: ex.newAction }) : ''}
      ${btn({ label: 'Collapse explorer', icon: 'panel-left', variant: 'ghost', iconOnly: true, k: '[', action: 'toggle-explorer' })}`;
    $('#explorer-search').innerHTML = ex.search === false ? '' : `
      <label class="input input--sm" style="height:28px">${ic('search', 14)}<input type="text" placeholder="${esc(ex.search)}" aria-label="${esc(ex.search)}" data-role="explorer-filter"/></label>`;
    $('#explorer-body').innerHTML = `<div class="tree" role="tree" aria-label="${esc(ex.title)}">${ex.body}</div>`;
    // Roving tabindex: cả tree chỉ là 1 điểm dừng Tab; ↑/↓ di chuyển trong tree.
    const items = $$('#explorer-body .tree__item');
    const cur = items.find((x) => x.getAttribute('aria-selected') === 'true') || items[0];
    items.forEach((x) => x.setAttribute('tabindex', x === cur ? '0' : '-1'));
  }

  /* Explorer content per activity */
  function exHome() {
    const favs = ALL_HOSTS.filter((h) => h.fav);
    return {
      title: t('home'), search: t('search') + '…', newAction: 'new-host',
      body: groupLabel(t('pinned')) +
        favs.map((h) => treeItem({ label: h.id, iconHtml: ic(h.os, 16), href: '#/hosts' })).join('') +
        groupLabel(t('recent')) +
        treeItem({ label: 'web-7d9f8c6b5-h8sdl', icon: 'pod', href: '#/k8s/pods', meta: 'Pod' }) +
        treeItem({ label: 'shop-media-assets', icon: 'bucket', href: '#/s3/objects', meta: 'Bucket' }) +
        treeItem({ label: 'Topology · shop', icon: 'network', href: '#/k8s/topology' }) +
        treeItem({ label: 'shop-stack', icon: 'layers', href: '#/docker/compose', meta: 'Compose' })
    };
  }
  const PROTO_LABEL = { rdp: 'RDP', telnet: 'Telnet', serial: 'Serial' };
  function exHosts(active) {
    let body = '';
    HOST_GROUPS.forEach((g) => {
      // Môi trường chỉ hiện ở hàng NHÓM — host kế thừa, không lặp lại.
      body += treeItem({ label: g.name, expanded: g.open, action: 'toggle-group', data: `data-id="${g.id}" data-group="${g.id}"`, right: envTag(g.env), meta: g.hosts.length, icon: 'folder' });
      if (g.open) g.hosts.forEach((h) => {
        body += treeItem({
          label: h.id, level: 1, iconHtml: ic(h.os, 16), selected: !active && h.id === (state.hostTab === 'rdp' ? 'prod-ad-01' : 'prod-web-01'), href: '#/hosts', action: h.proto === 'rdp' ? 'open-rdp' : 'open-term',
          right: PROTO_LABEL[h.proto] ? `<span class="tree__meta">${PROTO_LABEL[h.proto]}</span>` : '',
          meta: h.st === 'off' ? '<span class="dot dot--off" aria-label="Offline"></span>' : h.st === 'warning' ? '<span class="dot dot--warning" aria-label="High load"></span>' : '<span class="dot dot--success" aria-label="Online"></span>'
        });
      });
    });
    const tools = groupLabel('Tools') +
      treeItem({ label: 'Snippets', icon: 'braces', href: '#/snippets', selected: active === 'snippets', meta: SNIPPETS.length }) +
      treeItem({ label: 'Port forwarding', icon: 'route', href: '#/hosts?panel=forwards', selected: active === 'forwards', meta: FORWARDS.filter((f) => f.st === 'running').length + ' on' }) +
      treeItem({ label: 'MultiExec', icon: 'radio', href: '#/hosts?multi=1', selected: active === 'multi' }) +
      treeItem({ label: 'Workspaces', icon: 'grid', action: 'workspaces', meta: 3 });
    return { title: t('hosts'), search: t('searchHosts'), newAction: 'new-host', newLabel: 'New host', body: groupLabel(t('groups'), btn({ label: 'New group', icon: 'plus', variant: 'ghost', size: 'sm', iconOnly: true, action: 'group-dialog' })) + body + tools };
  }
  function exFiles() {
    return {
      title: 'Files', search: 'Search bookmarks…',
      body: groupLabel('This computer') +
        treeItem({ label: 'Home', icon: 'home', selected: true, href: '#/files' }) +
        treeItem({ label: 'Downloads', icon: 'download', href: '#/files' }) +
        treeItem({ label: 'build', icon: 'folder', href: '#/files' }) +
        groupLabel('Remote (SFTP)') +
        ['prod-web-01', 'prod-db-01', 'stg-web-01', 'dev-box'].map((id) => { const h = hostById(id); return treeItem({ label: h.id, iconHtml: ic(h.os, 16), href: '#/files', selected: id === 'prod-web-01', meta: id === 'prod-web-01' ? '/srv/shop' : '' }); }).join('') +
        groupLabel('Containers') +
        treeItem({ label: 'shop-stack-api-1', icon: 'container', href: '#/docker?itab=files', meta: '/app' })
    };
  }
  function exK8s(active) {
    let body = groupLabel(t('clusters'), btn({ label: 'Add cluster', icon: 'plus', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toast-demo' }));
    const KIND_ICON = { Pods: 'pod', Deployments: 'workload', StatefulSets: 'layers', Services: 'service', Ingresses: 'ingress', ConfigMaps: 'file-text', Secrets: 'key' };
    const KIND_HREF = { Pods: '#/k8s/pods', Deployments: '#/k8s/deployments' };
    CLUSTERS.forEach((c) => {
      body += treeItem({ label: c.id, icon: 'k8s', expanded: !!c.open, right: envTag(c.env), meta: c.st === 'off' ? '<span class="dot dot--off" aria-label="Disconnected"></span>' : '' });
      if (c.open) {
        body += treeItem({ label: 'Overview', level: 1, icon: 'gauge', action: 'toast-demo', meta: '' });
        body += treeItem({ label: 'Helm releases', level: 1, icon: 'helm', href: '#/k8s/helm', selected: active === 'helm', right: '<span class="tree__meta tree__meta--danger" aria-label="1 failed">1 failed</span>' });
        body += treeItem({ label: 'Nodes', level: 1, icon: 'server', action: 'toast-demo', meta: 6 });
        c.namespaces.forEach((ns) => {
          body += treeItem({ label: ns.id, level: 1, icon: 'hash', expanded: !!ns.open, meta: ns.open ? '' : ns.kinds[0][1], right: !ns.open && ns.kinds[0][2] ? `<span class="tree__meta tree__meta--danger" aria-label="${ns.kinds[0][2]} failing">${ns.kinds[0][2]} failing</span>` : '' });
          if (ns.open) {
            body += treeItem({ label: 'Topology', level: 2, icon: 'network', href: '#/k8s/topology', selected: active === 'topology' });
            ns.kinds.forEach(([k, n, bad]) => {
              body += treeItem({ label: k, level: 2, icon: KIND_ICON[k], href: KIND_HREF[k], action: KIND_HREF[k] ? '' : 'toast-demo', selected: active === k.toLowerCase(), meta: bad ? undefined : n, right: bad ? `<span class="tree__meta tree__meta--danger" aria-label="${bad} with problems">${bad} failing</span>` : '' });
            });
          }
        });
      }
    });
    return { title: t('kubernetes'), search: t('searchResources'), newAction: 'toast-demo', newLabel: 'Add cluster', body };
  }
  function exDocker(view) {
    let body = groupLabel(t('endpoints'), btn({ label: 'Add endpoint', icon: 'plus', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toast-demo' }));
    DOCKER_ENDPOINTS.forEach((e) => {
      body += treeItem({ label: e.name, iconHtml: ic('docker', 16), expanded: !!e.open, right: envTag(e.env), meta: e.st === 'off' ? '<span class="dot dot--off" aria-label="Offline"></span>' : e.st === 'warning' ? '<span class="dot dot--warning" aria-label="Degraded"></span>' : e.count });
      if (e.open) {
        body += treeItem({ label: 'Overview', level: 1, icon: 'gauge', href: '#/docker/overview', selected: view === 'overview' });
        body += treeItem({ label: 'Containers', level: 1, icon: 'container', href: '#/docker', selected: view === 'containers', right: '<span class="tree__meta tree__meta--danger" aria-label="1 unhealthy">1 unhealthy</span>' });
        body += treeItem({ label: 'Compose', level: 1, icon: 'layers', href: '#/docker/compose', selected: view === 'compose', meta: 3 });
        body += treeItem({ label: 'Images', level: 1, icon: 'archive', href: '#/docker/images', selected: view === 'images', meta: IMAGES.length });
        body += treeItem({ label: 'Volumes', level: 1, icon: 'hard-drive', href: '#/docker/volumes', selected: view === 'volumes', meta: VOLUMES.length });
        body += treeItem({ label: 'Networks', level: 1, icon: 'network', href: '#/docker/networks', selected: view === 'networks', meta: NETWORKS.length });
        body += treeItem({ label: 'Registries', level: 1, icon: 'globe', action: 'toast-demo', meta: 2 });
      }
    });
    return { title: t('docker'), search: t('searchEndpoints'), newAction: 'toast-demo', newLabel: 'Add endpoint', body };
  }
  function exStorage(activeBucket) {
    let body = groupLabel(t('accounts'), btn({ label: 'Add account', icon: 'plus', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toast-demo' }));
    S3_ACCOUNTS.forEach((a) => {
      body += treeItem({ label: a.name, iconHtml: ic(a.prov, 16), expanded: a.open, right: envTag(a.env), href: a.id === 'aws-media' ? '#/s3' : undefined, selected: a.id === 'aws-media' && !activeBucket, meta: a.buckets.length });
      if (a.open) a.buckets.forEach((b) => {
        body += treeItem({ label: b, level: 1, icon: 'bucket', href: b === 'shop-media-assets' ? '#/s3/objects' : '#/s3', selected: activeBucket === b });
      });
    });
    return { title: t('storage'), search: t('searchBuckets'), newAction: 'toast-demo', newLabel: 'Add S3 account', body };
  }
  const SETTINGS_SECTIONS = [
    ['general', 'General', 'sliders'], ['appearance', 'Appearance', 'sun'], ['terminal', 'Terminal', 'terminal-square'], ['shortcuts', 'Keyboard shortcuts', 'keyboard'], ['files', 'Files & transfers', 'folder'],
    ['accounts', 'Accounts', 'users'], ['keys', 'SSH keys', 'key'], ['known-hosts', 'Known hosts', 'fingerprint'],
    ['modules', 'Modules', 'grid'], ['security', 'Security & vault', 'shield'], ['updates', 'Updates', 'download'], ['diagnostics', 'Diagnostics', 'bug']
  ];
  function exSettings(active) {
    return {
      title: t('settings'), search: t('searchSettings'),
      body: '<div style="height:4px"></div>' + SETTINGS_SECTIONS.map(([id, label, icn], i) => (i === 5 ? groupLabel('Credentials') : i === 8 ? groupLabel('App') : '') + treeItem({ label, icon: icn, href: '#/settings/' + id, selected: active === id, meta: id === 'accounts' ? ACCOUNTS.length : id === 'keys' ? SSH_KEYS.length : id === 'updates' ? '' : undefined, right: id === 'known-hosts' ? '<span class="tree__meta tree__meta--danger" aria-label="1 changed key">1 changed</span>' : '' })).join('')
    };
  }
  function exTransfers() {
    const n = (st) => XFERS.filter((x) => x.st === st).length;
    return {
      title: t('transfers'), search: t('search') + '…',
      body: '<div style="height:4px"></div>' +
        treeItem({ label: 'All', icon: 'transfers', selected: true, meta: XFERS.length, href: '#/transfers' }) +
        treeItem({ label: t('active'), icon: 'activity', meta: n('active'), href: '#/transfers' }) +
        treeItem({ label: 'Queued', icon: 'clock', meta: n('queued'), href: '#/transfers' }) +
        treeItem({ label: t('failed'), icon: 'x-circle', meta: n('failed'), metaCls: 'danger', href: '#/transfers' }) +
        treeItem({ label: t('completed'), icon: 'check-circle', meta: n('done'), href: '#/transfers' }) +
        groupLabel('By source') +
        treeItem({ label: 'SFTP', icon: 'server', meta: 4, href: '#/transfers' }) + treeItem({ label: 'S3', icon: 'bucket', meta: 2, href: '#/transfers' }) + treeItem({ label: 'Docker', icon: 'container', meta: 1, href: '#/transfers' })
    };
  }

  /* Header */
  function crumbs(list) {
    return `<nav class="crumbs" aria-label="Breadcrumb">${list.map((c, i) => {
      const last = i === list.length - 1;
      const inner = `${c.iconHtml || (c.icon ? ic(c.icon, 14) : '')}<span class="ellipsis">${esc(c.label)}</span>${c.switch ? ic('chevrons-up-down', 12) : ''}`;
      const el = c.switch
        ? `<button type="button" class="crumb crumb--switch" data-action="${c.switch}" aria-haspopup="menu" aria-expanded="false"${tip(c.tip || 'Switch', c.k)}>${inner}</button>`
        : `<a class="crumb" href="${c.href || '#'}"${last ? ' aria-current="page"' : ''}>${inner}</a>`;
      return el + (last ? '' : '<span class="crumb-sep" aria-hidden="true">/</span>');
    }).join('')}</nav>`;
  }
  function headerActions(extra = '') {
    return `<div class="header-actions">${extra}
      ${btn({ label: 'Toggle inspector', icon: 'panel-right', variant: 'ghost', iconOnly: true, k: ']', action: 'toggle-inspector', attrs: `aria-pressed="${state.inspector}"` })}
    </div>`;
  }

  /* Status bar */
  function renderStatusBar(scr) {
    const total = state.transfers.length;
    const pct = total ? Math.round(state.transfers.reduce((a, b) => a + b.pct, 0) / total) : 0;
    const conn = scr.conn || { text: '3 ' + t('sessions'), kind: 'success' };
    $('#statusbar').innerHTML = `
      <span class="sb-item sb-item--ok"><span class="dot dot--${conn.kind}" aria-hidden="true"></span>${esc(conn.text)}</span>
      <span class="sb-sep" aria-hidden="true"></span>
      <button type="button" class="sb-item" data-action="vault-menu"${tip(t('lockVault'), 'mod+shift+L')}>${ic('unlock', 12)}${t('vaultUnlocked')}</button>
      ${total ? `<span class="sb-sep" aria-hidden="true"></span><a class="sb-item" href="#/transfers"${tip('Show transfers', 'g t')}>${ic('transfers', 12)}<span class="num">${total} ${t('tasks')} · ${pct}%</span><span class="progress" aria-hidden="true"><span class="progress__bar" style="width:${pct}%;display:block"></span></span></a>` : ''}
      <span class="spacer"></span>
      <button type="button" class="sb-item" data-action="toggle-lang" aria-label="${t('language')}: ${state.lang.toUpperCase()}"${tip(t('language'))}>${ic('languages', 12)}${state.lang.toUpperCase()}</button>
      <button type="button" class="sb-item" data-action="toggle-theme" aria-label="${t('theme')}"${tip('Toggle theme', 'alt+T')}>${ic(state.theme === 'dark' ? 'moon' : 'sun', 12)}</button>
      <button type="button" class="sb-item" data-action="notifications" aria-label="${t('notifications')} (${state.notifications})"${tip(t('notifications'))}>${ic('bell', 12)}${state.notifications ? `<span class="num">${state.notifications}</span>` : ''}</button>`;
  }

  /* ---------------------------------------------------------------- 6. Screens */

  /* 6.1 Home — không card lồng nhau, danh sách phẳng, màu theo ngữ nghĩa */
  function ctHome() {
    const recent = ['prod-web-01', 'prod-ad-01', 'prod-db-01', 'dev-box', 'stg-web-01', 'mac-mini-ci'].map(hostById);
    const favs = ALL_HOSTS.filter((h) => h.fav);
    const attn = [
      { sev: 'danger', title: 'web-7d9f8c6b5-h8sdl', badge: 'CrashLoopBackOff', desc: 'OOMKilled 23× — memory limit 256Mi reached', src: ['k8s', 'prod-cluster / shop'], href: '#/k8s/pods' },
      { sev: 'danger', title: 'payments-worker-6f4d9-kq2m', badge: 'ImagePullBackOff', desc: 'registry.shop.vn/worker:5.3.0 not found', src: ['k8s', 'prod-cluster / payments'], href: '#/k8s/pods' },
      { sev: 'warning', title: 'shop-stack-api-1', badge: 'Unhealthy', desc: 'Health check failed 5× — GET /health timed out after 5s', src: ['container', 'build-server'], href: '#/docker' },
      { sev: 'warning', title: 'shop.vn TLS certificate', badge: 'Expires in 9 days', desc: 'cert-manager renewal failed: ACME DNS-01 challenge timeout', src: ['k8s', 'prod-cluster / shop'], href: '#/k8s/topology' },
      { sev: 'info', title: 'administrator password', badge: '', desc: '215 days old · used by 2 RDP hosts — consider rotating', src: ['users', 'Accounts'], href: '#/settings/accounts' }
    ];
    const groupOf = (h) => HOST_GROUPS.find((g) => g.hosts.some((x) => x.id === h.id)).name;
    return `<div class="page"><div class="page__inner">
      <div class="home-hero">
        <div><h1 class="page__title">${t('goodAfternoon')}</h1><p class="page__desc">${t('homeSub')}</p></div>
        <span class="spacer"></span>
        ${btn({ label: 'Import', icon: 'import', action: 'toast-demo' })}
        ${btn({ label: 'New host', icon: 'plus', variant: 'primary', k: 'n', action: 'new-host' })}
      </div>
      <form class="quick-connect" data-action-submit="quick-connect" aria-label="${t('quickConnect')}">
        <label class="input input--lg"><button type="button" class="proto" data-action="menu-proto" aria-haspopup="menu"${tip('Protocol')}>${ic('terminal-square', 14)}SSH${ic('chevron-down', 12)}</button>
          <input type="text" placeholder="user@host:port — e.g. deploy@10.10.1.11:22" aria-label="${t('quickConnect')}" autocomplete="off" spellcheck="false"/>
          ${kbd('enter')}</label>
        <button type="submit" class="btn btn--lg">${t('connect')}</button>
      </form>

      <div class="h-section">${t('favorites')} <span class="count">${favs.length}</span></div>
      <div class="fav-grid plain">${favs.map((h) => `
        <a class="fav plain" href="#/hosts">${ic(h.os, 18)}
          <span style="min-width:0;flex:1"><span class="fav__name" style="display:flex;align-items:center;gap:6px">${h.id}${envDot(h.env)}</span><span class="fav__sub" style="display:block">${h.user}@${h.addr} · ${groupOf(h)}</span></span></a>`).join('')}</div>

      <div class="home-grid">
        <section aria-labelledby="h-recent">
          <div class="h-section" id="h-recent">${t('recent')} <span class="count">${recent.length}</span><span class="spacer"></span><a class="btn btn--ghost btn--sm" href="#/hosts">View all ${ic('arrow-right', 14)}</a></div>
          <div class="plain-list" role="list">${recent.map((h) => `
            <div class="list-row" role="listitem" tabindex="0">
              ${ic(h.os, 18)}
              <div class="list-row__main"><div class="list-row__title"><span>${h.id}</span>${envDot(h.env)}</div><div class="list-row__sub">${h.user}@${h.addr} · ${h.proto.toUpperCase()} · ${groupOf(h)}</div></div>
              <div class="row-actions">${btn({ label: 'Open SFTP', icon: 'folder', variant: 'ghost', size: 'sm', iconOnly: true })}${btn({ label: 'Edit host', icon: 'sliders', variant: 'ghost', size: 'sm', iconOnly: true })}</div>
              <span class="list-row__meta">${h.last}</span>
              <a class="btn btn--sm btn--ghost" href="#/hosts">${t('connect')}</a>
            </div>`).join('')}</div>
        </section>
        <section aria-labelledby="h-attn">
          <div class="h-section" id="h-attn">${t('needsAttention')} <span class="count">${attn.length}</span></div>
          <div class="plain-list" role="list">${attn.map((a) => `
            <a class="attn-row plain" role="listitem" href="${a.href}">
              <span class="sev-ic sev-ic--${a.sev}">${ic(a.sev === 'danger' ? 'alert-circle' : a.sev === 'warning' ? 'alert' : 'info', 14)}</span>
              <span style="min-width:0;flex:1">
                <span class="attn-row__title"><span class="ellipsis">${a.title}</span>${a.badge ? `<span class="badge badge--${a.sev}" style="height:18px;flex:none">${a.badge}</span>` : ''}</span>
                <span class="attn-row__desc ellipsis" style="display:block">${a.desc}</span>
                <span class="attn-row__src">${a.src[1]}</span>
              </span></a>`).join('')}</div>
        </section>
      </div>

      <div class="h-section" style="margin-top:40px">${t('getStarted')}</div>
      <div class="start-links">
        ${[['server', 'Add a host', 'SSH, Telnet, Serial or RDP — with jump hosts and shared accounts.', 'new-host'],
           ['import', 'Import hosts', '14 hosts found in ~/.ssh/config. Also MobaXterm, Termius, CSV.', 'toast-demo'],
           ['k8s', 'Connect Kubernetes', 'Pick contexts from kubeconfig. Read-only by default.', 'toast-demo'],
           ['bucket', 'Add S3 storage', 'AWS, MinIO, Cloudflare R2 or any S3-compatible API.', 'toast-demo']]
          .map(([i, ti, d, a]) => `<button type="button" class="start-link" data-action="${a}"><b>${ic(i, 14, 'subtle')}${ti}</b><span>${d}</span></button>`).join('')}
      </div>
    </div></div>`;
  }

  /* 6.2 Hosts + terminal session */
  const TERM_OUT = `<span class="t-dim">Last login: Sat Oct  4 13:58:02 2026 from 10.8.0.14</span>
<span class="t-bold">Welcome to Ubuntu 24.04.1 LTS</span> (GNU/Linux 6.8.0-45-generic x86_64)

  System load:  0.42               Processes:             187
  Usage of /:   61.3% of 77.35GB   Users logged in:       2
  Memory usage: 48%                IPv4 address for eth0: 10.10.1.11

<span class="t-green">deploy@prod-web-01</span>:<span class="t-blue">~</span>$ cd /srv/shop && ls -la
total 56
drwxr-xr-x  7 deploy deploy 4096 Oct  4 11:20 <span class="t-dir">.</span>
drwxr-xr-x  5 root   root   4096 Aug 14 09:02 <span class="t-dir">..</span>
-rw-r--r--  1 deploy deploy  612 Oct  4 11:18 .env.production
drwxr-xr-x  8 deploy deploy 4096 Oct  4 11:20 <span class="t-dir">.git</span>
-rw-r--r--  1 deploy deploy 1873 Oct  3 17:41 compose.yaml
drwxr-xr-x  2 deploy deploy 4096 Sep 30 08:15 <span class="t-dir">config</span>
-rwxr-xr-x  1 deploy deploy  942 Sep 12 10:03 <span class="t-green">deploy.sh</span>
drwxr-xr-x  4 deploy deploy 4096 Oct  4 11:20 <span class="t-dir">releases</span>
drwxr-xr-x  2 deploy deploy 4096 Oct  4 13:59 <span class="t-dir">logs</span>
<span class="t-green">deploy@prod-web-01</span>:<span class="t-blue">/srv/shop</span>$ systemctl status shop-web --no-pager
<span class="t-green">●</span> shop-web.service - Shop web frontend
     Loaded: loaded (/etc/systemd/system/shop-web.service; <span class="t-green">enabled</span>)
     Active: <span class="t-green t-bold">active (running)</span> since Sat 2026-10-04 11:20:44 +07; 2h 38min ago
   Main PID: 48211 (node)
      Tasks: 11 (limit: 9387)
     Memory: 182.4M (peak: 214.0M)
        CPU: 6min 12.884s
<span class="t-dim">Oct 04 13:57:12 prod-web-01 node[48211]: GET /api/products 200 38ms</span>
<span class="t-dim">Oct 04 13:57:13 prod-web-01 node[48211]: GET /checkout 200 112ms</span>
<span class="t-yellow">Oct 04 13:58:40 prod-web-01 node[48211]: WARN slow query catalog.search 1.9s</span>
<span class="t-green">deploy@prod-web-01</span>:<span class="t-blue">/srv/shop</span>$ <span class="t-cursor"></span>`;
  const TERM_OUT_2 = `<span class="t-green">deploy@prod-web-02</span>:<span class="t-blue">~</span>$ tail -f /srv/shop/logs/access.log
10.10.1.5 - - [04/Oct/2026:13:59:01 +0700] "GET / HTTP/1.1" <span class="t-green">200</span> 18233
10.10.1.5 - - [04/Oct/2026:13:59:01 +0700] "GET /static/app.4f2a.js HTTP/1.1" <span class="t-green">200</span> 912881
10.10.1.5 - - [04/Oct/2026:13:59:02 +0700] "POST /api/cart HTTP/1.1" <span class="t-green">201</span> 412
10.10.1.5 - - [04/Oct/2026:13:59:04 +0700] "GET /api/search?q=ao+khoac HTTP/1.1" <span class="t-yellow">499</span> 0
10.10.1.5 - - [04/Oct/2026:13:59:05 +0700] "GET /products/ao-khoac-gio HTTP/1.1" <span class="t-green">200</span> 22140
10.10.1.5 - - [04/Oct/2026:13:59:07 +0700] "GET /api/recommendations HTTP/1.1" <span class="t-red">502</span> 166
<span class="t-cursor"></span>`;

  const TERM_OUT_3 = `<span class="t-green">deploy@stg-web-01</span>:<span class="t-blue">~</span>$ sudo apt list --upgradable 2>/dev/null | wc -l
<span class="t-bold">14</span>
<span class="t-green">deploy@stg-web-01</span>:<span class="t-blue">~</span>$ <span class="t-cursor"></span>`;
  const TERM_OUT_4 = `<span class="t-green">dba@prod-db-01</span>:<span class="t-blue">~</span>$ uptime
 14:03:12 up 41 days,  3:12,  1 user,  load average: 0.88, 0.71, 0.64
<span class="t-green">dba@prod-db-01</span>:<span class="t-blue">~</span>$ <span class="t-cursor"></span>`;

  function sessionTabs() {
    const tabs = [
      { id: 'term', icon: 'terminal-square', label: 'prod-web-01', env: 'prod' },
      { id: 'rdp', iconHtml: ic('windows', 14), label: 'prod-ad-01', env: 'prod', sub: 'RDP' },
      { id: 'logs', icon: 'file-code', label: 'nginx.conf', sub: 'prod-lb-01', env: 'prod' }
    ];
    return `<div class="wtabs" role="tablist" aria-label="Sessions">${tabs.map((x, i) => `
      <div class="wtab" role="tab" tabindex="${!state.multi && state.hostTab === x.id ? 0 : -1}" aria-selected="${!state.multi && state.hostTab === x.id}" data-action="host-tab" data-id="${x.id}"${tip(x.label + (x.sub ? ' · ' + x.sub : ''), 'alt+' + (i + 1))}>
        ${x.iconHtml || ic(x.icon, 14)}<span class="wtab__label">${x.label}</span>${x.env ? '<span class="env-dot" aria-label="Production"></span>' : ''}
        <span class="wtab__close" role="button" aria-label="Close tab" data-action="toast-demo">${ic('x', 12)}</span></div>`).join('')}
      ${state.multi ? `<div class="wtab" role="tab" aria-selected="true" tabindex="0">${ic('radio', 14)}<span class="wtab__label">MultiExec · 4</span><span class="wtab__close" role="button" aria-label="Exit MultiExec" data-action="multi-exit">${ic('x', 12)}</span></div>` : ''}
      ${btn({ label: 'New tab', icon: 'plus', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+T', action: 'cmdk' })}
      <span class="spacer"></span>
      ${btn({ label: 'Split right', icon: 'split', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+\\', action: 'toggle-split', attrs: `aria-pressed="${state.split}"` })}
      ${btn({ label: 'MultiExec — type into several terminals', icon: 'radio', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+shift+M', action: 'multi-toggle', attrs: `aria-pressed="${state.multi}"` })}
    </div>`;
  }
  function statsBar(host) {
    return `<div class="statsbar" aria-label="Server statistics for ${host}">
      <span${tip('CPU, 5s average')}>CPU <span class="meter__track" aria-hidden="true"><span class="meter__fill" style="width:12%"></span></span><b>12%</b></span>
      <span>Mem <span class="meter__track" aria-hidden="true"><span class="meter__fill" style="width:48%"></span></span><b>48%</b> <span>3.8 / 7.8 GB</span></span>
      <span>Disk / <span class="meter__track" aria-hidden="true"><span class="meter__fill" style="width:61%"></span></span><b>61%</b></span>
      <span>Load <b>0.42</b></span><span>Net <b>↓ 1.2 MB/s ↑ 220 KB/s</b></span><span>Up <b>12d 4h</b></span>
      <span class="spacer"></span>
      <span${tip('Session log: ~/Shellhouse/logs/prod-web-01/2026-10-04.log')}>${ic('record', 12)}Logging</span>
      <span${tip('tmux session “main” — reattached automatically on reconnect')}>${ic('panel-bottom', 12)}tmux: main</span>
    </div>`;
  }
  function sftpPanel() {
    return `<aside class="sidepanel" aria-label="SFTP">
      <div class="sidepanel__head">SFTP<span class="subtle" style="font-weight:400;font-size:12px;margin-left:4px">prod-web-01</span><span class="spacer"></span>
        ${btn({ label: 'Upload', icon: 'upload', variant: 'ghost', size: 'sm', iconOnly: true, action: 'upload' })}${btn({ label: 'New folder', icon: 'folderplus', variant: 'ghost', size: 'sm', iconOnly: true })}${btn({ label: 'Open full file manager', icon: 'columns', variant: 'ghost', size: 'sm', iconOnly: true, action: 'go-files' })}${btn({ label: 'Close panel', icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true, action: 'panel-none' })}</div>
      <div class="sidepanel__path">${ic('folder-open', 14)}/srv/shop<span class="spacer"></span><button type="button" class="chip chip--static" style="height:20px;font-family:var(--font-sans)" aria-pressed="true"${tip('Follow the terminal’s working directory')}>${ic('link', 12)}Follow cwd</button></div>
      <div style="flex:1;overflow:auto;padding:4px 0">
        ${[['..', 1, ''], ['config', 1, ''], ['logs', 1, ''], ['releases', 1, ''], ['.env.production', 0, '612 B'], ['compose.yaml', 0, '1.8 KB'], ['deploy.sh', 0, '942 B']]
          .map(([n, d, sz]) => `<div class="file-row" tabindex="-1">${ic(d ? 'folder' : 'file', 14, d ? 'is-folder' : '')}<span class="ellipsis">${n}</span><span class="file-row__size">${sz}</span></div>`).join('')}
      </div>
      <div class="drop-hint">Drop files to upload to /srv/shop</div>
    </aside>`;
  }
  function forwardsPanel() {
    const stText = { running: 'Running', stopped: 'Stopped', failed: 'Failed' };
    return `<aside class="sidepanel sidepanel--wide" aria-label="Port forwarding">
      <div class="sidepanel__head">Port forwarding<span class="subtle" style="font-weight:400;font-size:12px;margin-left:4px">prod-web-01</span><span class="spacer"></span>
        ${btn({ label: 'Close panel', icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true, action: 'panel-none' })}</div>
      <div style="flex:1;overflow:auto">
        ${FORWARDS.map((f, i) => `<div class="fwd-row">
          <span class="fwd-kind"${tip({ L: 'Local forward (-L)', R: 'Remote forward (-R)', D: 'Dynamic SOCKS proxy (-D)' }[f.kind])}>-${f.kind}</span>
          <div class="fwd-main"><div class="fwd-route">${esc(f.bind)} → ${esc(f.dest)}</div>
            <div class="fwd-meta">${statusHtml(f.st === 'running' ? 'success' : f.st === 'failed' ? 'danger' : 'neutral', stText[f.st]).replace('status--neutral', 'status--neutral status--muted')}${f.auto ? '<span>· auto-start</span>' : ''}${f.saved ? '' : '<span>· this session only</span>'}${f.traffic ? `<span>· ${f.traffic}</span>` : ''}</div>
            <div class="fwd-meta" style="${f.st === 'failed' ? 'color:var(--danger)' : ''}">${esc(f.note)}</div></div>
          <div class="fwd-actions">${f.st === 'running' ? btn({ label: 'Stop', icon: 'stop', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toast-demo' }) + btn({ label: 'Copy address', icon: 'copy', variant: 'ghost', size: 'sm', iconOnly: true, action: 'copy' }) : f.st === 'failed' ? btn({ label: 'Retry', variant: 'ghost', size: 'sm', action: 'toast-demo' }) : btn({ label: 'Start', icon: 'play', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toast-demo' })}${btn({ label: 'More', icon: 'more', variant: 'ghost', size: 'sm', iconOnly: true })}</div>
        </div>`).join('')}
        <div class="sidepanel__section">
          <div class="sidepanel__title">New forward</div>
          <div class="segmented seg-full" role="radiogroup" aria-label="Forward type">${[['L', 'Local -L'], ['R', 'Remote -R'], ['D', 'SOCKS -D']].map(([v, l]) => `<button type="button" class="segmented__item" role="radio" aria-checked="${v === 'L'}" data-action="seg">${l}</button>`).join('')}</div>
          <div class="field__hint" style="margin-top:-4px">A port on this machine → through SSH → the destination (as seen from the server).</div>
          <div class="form-grid">
            <label class="field"><span class="field__label">Bind address</span><span class="input"><input value="127.0.0.1" aria-label="Bind address"/></span></label>
            <label class="field"><span class="field__label">Bind port</span><span class="input"><input placeholder="auto" aria-label="Bind port"/></span></label>
            <label class="field"><span class="field__label">Destination host</span><span class="input"><input value="redis.internal" aria-label="Destination host"/></span></label>
            <label class="field"><span class="field__label">Destination port</span><span class="input"><input value="6379" aria-label="Destination port"/></span></label>
          </div>
          <label class="check-row"><input type="checkbox" class="checkbox" checked/>Save for this host</label>
          <label class="check-row"><input type="checkbox" class="checkbox"/>Start on connect</label>
          <div class="row" style="justify-content:flex-end">${btn({ label: 'Add', variant: 'ghost', size: 'sm', action: 'toast-demo' })}${btn({ label: 'Add and start', variant: 'primary', size: 'sm', action: 'toast-demo' })}</div>
        </div>
      </div>
    </aside>`;
  }

  function ctMulti() {
    const panes = [['prod-web-01', TERM_OUT_2.replace(/prod-web-02/g, 'prod-web-01'), 'prod'], ['prod-web-02', TERM_OUT_2, 'prod'], ['stg-web-01', TERM_OUT_3, 'staging'], ['prod-db-01', TERM_OUT_4, 'prod']];
    const on = panes.filter((p) => state.multiOn.has(p[0]));
    const prodOn = on.filter((p) => p[2] === 'prod').length;
    return sessionTabs() + `
      <div class="mx-bar" role="toolbar" aria-label="MultiExec">
        <span class="mx-bar__title">${ic('radio', 14)}MultiExec</span>
        <span class="mx-bar__desc">Typing goes to <b style="color:var(--text-primary);font-weight:500">${on.length} of ${panes.length}</b> terminals${prodOn ? ` · <span style="color:var(--danger)">${prodOn} production</span>` : ''}</span>
        <label class="input" style="margin-left:8px">${ic('chevron-right', 14)}<input placeholder="Type a command for all selected terminals…" aria-label="Send input to selected terminals" value="sudo systemctl reload nginx"/>${kbd('enter')}</label>
        <span class="spacer"></span>
        ${btn({ label: 'Select all', variant: 'ghost', size: 'sm', action: 'multi-all' })}${btn({ label: 'Select none', variant: 'ghost', size: 'sm', action: 'multi-none' })}
        ${btn({ label: 'Exit MultiExec', size: 'sm', k: 'mod+shift+M', tipText: 'Exit MultiExec', action: 'multi-exit' })}
      </div>
      <div class="mx-grid">${panes.map(([h, out, env]) => { const sel = state.multiOn.has(h); return `<div class="pane${sel ? '' : ' is-muted'}">
        <div class="pane__label"><input type="checkbox" class="checkbox" ${sel ? 'checked' : ''} data-action="multi-pick" data-host="${h}" aria-label="${h} receives typed input"/><span style="color:var(--text-primary)">${h}</span>${envDot(env)}<span class="subtle">${sel ? 'receives input' : 'typing here stays in this terminal'}</span><span class="spacer"></span>${btn({ label: 'Open as a tab', icon: 'external', variant: 'ghost', size: 'sm', iconOnly: true })}</div>
        <div class="terminal" role="log" aria-label="Terminal ${h}" tabindex="0">${out}</div></div>`; }).join('')}</div>`;
  }

  function ctHosts() {
    if (state.multi) return ctMulti();
    const tabsHtml = sessionTabs();
    if (state.hostTab === 'rdp') {
      return tabsHtml + `
        <div class="session-head">${statusHtml('success', t('connected'))}<span class="sep">·</span><span class="mono">administrator@10.10.1.40</span><span class="sep">·</span><span>1920 × 1080 · 32-bit · NLA</span><span class="sep">·</span><span class="num">24 ms</span>
          <span class="spacer"></span>
          ${btn({ label: 'Fit', icon: 'maximize', variant: 'ghost', size: 'sm' })}
          ${btn({ label: 'Clipboard sync', icon: 'clipboard', variant: 'ghost', size: 'sm', iconOnly: true, attrs: 'aria-pressed="true"' })}
          ${btn({ label: 'Send Ctrl+Alt+Del', icon: 'keyboard', variant: 'ghost', size: 'sm', iconOnly: true })}
          ${btn({ label: 'Open in external client', icon: 'external', variant: 'ghost', size: 'sm', iconOnly: true, tipText: 'Open in mstsc / Remmina' })}
          ${btn({ label: 'Disconnect', icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+W' })}</div>
        <div class="rdp-stage"><div class="rdp-screen" role="img" aria-label="Remote desktop of prod-ad-01 (preview)">
          <div class="rdp-icons"><div class="rdp-icon"><i class="bin"></i>Recycle Bin</div><div class="rdp-icon"><i class="srv"></i>Server Manager</div><div class="rdp-icon"><i></i>Scripts</div></div>
          <div class="rdp-window"><div class="rdp-window__bar">Server Manager · Dashboard<span class="ctl"><span>—</span><span>☐</span><span>✕</span></span></div>
            <div class="rdp-window__body"><div class="rdp-window__nav"><div class="on">Dashboard</div><div>Local Server</div><div>All Servers</div><div>AD DS</div><div>DNS</div><div>File and Storage</div></div>
              <div class="rdp-window__main"><h4>WELCOME TO SERVER MANAGER</h4><div class="rdp-tiles"><div>AD DS<br/>1 server</div><div>DNS<br/>Manageability</div><div class="bad">File and Storage<br/>1 event</div><div>Local Server<br/>Events</div><div>All Servers<br/>Services</div><div>Performance</div></div></div></div></div>
          <div class="rdp-taskbar"><span class="win"></span><span></span><span class="on"></span><span></span><span></span><div class="clock">2:04 PM<br/>10/4/2026</div></div>
        </div></div>`;
    }
    if (state.hostTab === 'logs') return tabsHtml + ctEditor();
    const pane = (label, out, focused) => `<div class="pane${focused ? ' is-focused' : ''}">${state.split ? `<div class="pane__label">${label}</div>` : ''}<div class="terminal" role="log" aria-label="Terminal ${label}" tabindex="0">${out}</div></div>`;
    const panelBtn = (id, label, icon, k) => btn({ label, icon, variant: 'ghost', size: 'sm', k, tipText: 'Toggle ' + label, action: 'panel-' + id, attrs: `aria-pressed="${state.panel === id}"` });
    return tabsHtml + `
      <div class="session-head">${statusHtml('success', t('connected'))}<span class="sep">·</span><span class="mono">deploy@prod-web-01.shop.vn:22</span><span class="sep">·</span><span class="num"${tip('Round-trip latency')}>18 ms</span><span class="sep">·</span><span${tip('Jump host (inherited from group Production)')}>via bastion-01</span><span class="sep">·</span><span${tip('Account (shared credentials)')}>${ic('user', 12, 'subtle')}</span><span>deploy</span>
        <span class="spacer"></span>
        ${panelBtn('sftp', 'SFTP', 'folder', 'mod+shift+F')}
        ${panelBtn('forwards', 'Forwards', 'route', '')}
        ${btn({ label: 'Snippets', icon: 'braces', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+shift+S', action: 'snippet-palette' })}
        ${btn({ label: 'Find in terminal', icon: 'search', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+shift+F' })}
        ${btn({ label: 'Reconnect', icon: 'refresh', variant: 'ghost', size: 'sm', iconOnly: true, k: 'mod+shift+R' })}
        ${btn({ label: 'More', icon: 'more', variant: 'ghost', size: 'sm', iconOnly: true, action: 'term-menu' })}</div>
      ${statsBar('prod-web-01')}
      <div class="session-body">
        <div class="panes">${pane('prod-web-01', TERM_OUT, true)}${state.split ? pane('prod-web-02', TERM_OUT_2, false) : ''}</div>
        ${state.panel === 'sftp' ? sftpPanel() : state.panel === 'forwards' ? forwardsPanel() : ''}
      </div>`;
  }
  /* Editor tab (CodeMirror trong app thật) — cùng pattern: tab · session header · body */
  function ctEditor() {
    const lines = ['user  nginx;', 'worker_processes  auto;', '', 'events { worker_connections  4096; }', '', 'http {', '    include       /etc/nginx/mime.types;', '    sendfile      on;', '    keepalive_timeout  65;', '', '    upstream shop_web {', '        server 10.10.1.11:8080 max_fails=3;', '        server 10.10.1.12:8080 max_fails=3;', '    }', '', '    server {', '        listen 443 ssl http2;', '        server_name shop.vn;', '        location / { proxy_pass http://shop_web; }', '    }', '}'];
    return `<div class="session-head">${ic('file-code', 14, 'subtle')}<span class="mono">prod-lb-01:/etc/nginx/nginx.conf</span><span class="sep">·</span><span>Modified</span><span class="sep">·</span><span>nginx · UTF-8 · LF</span>
        <span class="spacer"></span>
        ${btn({ label: 'Compare with server', icon: 'diff', variant: 'ghost', size: 'sm', iconOnly: true, action: 'diff-demo' })}
        ${btn({ label: 'Save to server', icon: 'upload', size: 'sm', k: 'mod+S', tipText: 'Save to server', action: 'toast-demo' })}</div>
      <div class="terminal" style="font-size:12.5px;line-height:20px;padding:8px 0" role="textbox" aria-multiline="true" aria-label="Editor nginx.conf">${lines.map((l, i) => `<div style="display:flex"><span style="width:44px;text-align:right;padding-right:14px;color:var(--text-disabled);flex:none">${i + 1}</span><span>${esc(l) || ' '}</span></div>`).join('')}</div>`;
  }

  /* 6.3 Kubernetes — Pods */
  const POD_COLS = [
    { key: 'name', label: 'Name', w: 'auto', fixed: true },
    { key: 'namespace', label: 'Namespace', w: '108px', cls: 'col-opt-2' },
    { key: 'ready', label: 'Ready', w: '64px' },
    { key: 'status', label: 'Status', w: '168px' },
    { key: 'restarts', label: 'Restarts', w: '84px', num: true },
    { key: 'cpu', label: 'CPU', w: '104px' },
    { key: 'mem', label: 'Memory', w: '112px' },
    { key: 'node', label: 'Node', w: '120px', cls: 'col-opt-1' },
    { key: 'age', label: 'Age', w: '72px', num: true }
  ];
  function visiblePods() {
    let rows = PODS.slice();
    if (state.podFailing) rows = rows.filter(isFailing);
    const q = state.podFilter.trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.name.includes(q) || p.ns.includes(q) || p.status.toLowerCase().includes(q) || p.node.includes(q));
    const { key, dir } = state.podSort;
    const val = (p) => key === 'status' ? POD_STATUS_RANK[p.status] * 100 - p.restarts / 100 : key === 'namespace' ? p.ns : key === 'cpu' ? p.cpu : key === 'mem' ? p.mem : key === 'restarts' ? p.restarts : key === 'age' ? ageMin(p.age) : p[key];
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'asc' ? 1 : -1); });
    return rows;
  }
  function ageMin(s) { let m = 0; s.replace(/(\d+)(d|h|m)/g, (_, n, u) => { m += +n * (u === 'd' ? 1440 : u === 'h' ? 60 : 1); }); return m; }

  function k8sHeader(leaf) {
    return crumbs([
      { icon: 'k8s', label: 'Kubernetes', href: '#/k8s/pods' },
      { label: 'prod-cluster', switch: 'menu-context', tip: 'Switch context', k: 'mod+shift+K' },
      { label: 'shop', href: '#/k8s/pods' },
      { label: leaf, href: '#/k8s/' + leaf.toLowerCase() }
    ]) + `<button type="button" class="chip chip--static" data-action="menu-ns" aria-haspopup="menu"${tip('Namespace scope', 'shift+N')}>${ic('hash', 12)}Namespaces: <b>shop, payments</b>${ic('chevron-down', 12)}</button>`;
  }

  function ctPods() {
    const rows = visiblePods();
    const sel = state.podSel;
    const cols = POD_COLS.filter((c) => c.fixed || state.podCols[c.key]);
    const allChecked = rows.length && rows.every((r) => sel.has(r.name));
    const someChecked = rows.some((r) => sel.has(r.name));
    const failingCount = PODS.filter(isFailing).length;
    const bar = sel.size ? `
      <div class="bulkbar" role="toolbar" aria-label="Bulk actions">
        <span class="bulkbar__count">${sel.size} ${t('selected')}<button type="button" class="chip__x" data-action="clear-sel" aria-label="${t('clear')}"${tip(t('clear'), 'esc')}>${ic('x', 12)}</button></span>
        <span class="header-sep" aria-hidden="true"></span>
        ${btn({ label: t('restart'), icon: 'restart', variant: 'ghost', size: 'sm', k: 'shift+R', tipText: 'Restart selected Pods', action: 'bulk-restart' })}
        ${btn({ label: 'Logs', icon: 'logs', variant: 'ghost', size: 'sm', k: 'L', tipText: 'Stream logs from all selected', action: 'toast-demo' })}
        ${btn({ label: t('copyNames'), icon: 'copy', variant: 'ghost', size: 'sm', k: 'C', tipText: 'Copy names', action: 'bulk-copy' })}
        ${btn({ label: 'Port-forward', icon: 'route', variant: 'ghost', size: 'sm', attrs: 'aria-disabled="true" disabled' })}
        <span class="spacer"></span>
        ${btn({ label: t('delete') + '…', icon: 'trash', variant: 'ghost', size: 'sm', k: 'mod+backspace', tipText: 'Delete selected Pods', action: 'bulk-delete', attrs: 'style="color:var(--danger)"' })}
      </div>` : `
      <div class="toolbar" role="toolbar" aria-label="Pods toolbar">
        <label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="${t('filter')}" aria-label="Filter Pods" data-role="table-filter" value="${esc(state.podFilter)}"/>${kbd('/')}</label>
        <div class="chips">
          <button type="button" class="chip ${state.podFailing ? 'chip--active' : ''}" data-action="toggle-failing" aria-pressed="${state.podFailing}">${ic('alert-circle', 12)}Status: <b>${state.podFailing ? 'Failing' : 'Any'}</b>${state.podFailing ? `<span class="chip__x" aria-hidden="true">${ic('x', 12)}</span>` : `<span style="color:var(--danger);margin-left:2px;font-weight:500">${failingCount}</span>`}</button>
          <button type="button" class="chip">Node: <b>Any</b></button>
          <button type="button" class="chip chip--add" data-action="toast-demo">${ic('plus', 12)}Filter</button>
        </div>
        <span class="spacer"></span>
        <span class="toolbar-count">${rows.length} of ${PODS.length}</span>
        <span class="status status--success" style="font-size:12px;color:var(--text-secondary)"${tip('Watching for changes')}><span class="status__dot"></span>Live</span>
        <div class="segmented segmented--icon" role="radiogroup" aria-label="View">
          <a class="segmented__item" role="radio" aria-checked="true" href="#/k8s/pods" aria-label="Table"${tip('Table view', 'v t')}>${ic('list', 14)}</a>
          <a class="segmented__item" role="radio" aria-checked="false" href="#/k8s/topology" aria-label="Topology"${tip('Topology view', 'v g')}>${ic('network', 14)}</a>
        </div>
        ${btn({ label: 'Columns', icon: 'columns', variant: 'ghost', iconOnly: true, action: 'menu-columns', attrs: 'aria-haspopup="menu"' })}
        ${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', iconOnly: true, k: 'shift+R' })}
      </div>`;
    const body = rows.length ? rows.map((p, i) => {
      const kind = POD_STATUS_KIND[p.status];
      const rc = p.restarts === 0 ? 'restarts-0' : p.restarts > 5 ? 'restarts-danger' : 'restarts-warn';
      const active = state.inspector && state.podActive === p.name;
      const cell = (c) => {
        switch (c.key) {
          case 'name': return `<td class="cell-primary"><span class="cell-name">${ic('pod', 14, '')}<span>${p.name}</span></span></td>`;
          case 'namespace': return `<td class="${c.cls}">${p.ns}</td>`;
          case 'ready': return `<td class="num">${p.ready}</td>`;
          case 'status': return `<td>${statusHtml(kind === 'neutral' ? 'neutral' : kind, p.status).replace('status--neutral', 'status--neutral status--muted')}</td>`;
          case 'restarts': return `<td class="is-num num ${rc}">${p.restarts}</td>`;
          case 'cpu': return `<td>${p.cpuL === '—' ? '<span class="subtle">—</span>' : meter(p.cpu, p.cpuL)}</td>`;
          case 'mem': return `<td>${p.memL === '—' ? '<span class="subtle">—</span>' : meter(p.mem, p.memL)}</td>`;
          case 'node': return `<td class="${c.cls}">${p.node}</td>`;
          case 'age': return `<td class="is-num num">${p.age}</td>`;
        }
        return '<td></td>';
      };
      return `<tr data-row="${p.name}" data-idx="${i}" aria-selected="${sel.has(p.name)}" class="${active ? 'is-active' : ''}${state.podFocus === i ? ' is-focused' : ''}${isFailing(p) ? ' is-problem' : ''}" tabindex="${state.podFocus === i || (state.podFocus < 0 && i === 0) ? 0 : -1}">
        <td class="col-check"><input type="checkbox" class="checkbox" aria-label="Select ${p.name}" data-action="row-check" ${sel.has(p.name) ? 'checked' : ''} tabindex="-1"/></td>
        ${cols.map(cell).join('')}
        <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions for ${p.name}" data-action="row-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`;
    }).join('') : `<tr><td colspan="${cols.length + 2}" style="height:auto;border:0"><div class="empty"><div class="empty__art">${ic('search', 20)}</div><div class="empty__title">No Pods match “${esc(state.podFilter)}”</div><div class="empty__desc">Try a different name, or clear filters to see all ${PODS.length} Pods in shop, payments.</div><div class="empty__actions">${btn({ label: 'Clear filters', action: 'clear-filters' })}</div></div></td></tr>`;
    const sortTh = (c) => {
      const s = state.podSort.key === c.key ? (state.podSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th scope="col" class="is-sortable ${c.num ? 'is-num' : ''} ${c.cls || ''}" aria-sort="${s}" data-action="sort" data-key="${c.key}" tabindex="-1"><span class="th-inner">${c.label}${ic(s === 'descending' ? 'arrow-down' : 'arrow-up', 12, 'sort-ic')}</span></th>`;
    };
    return bar + `<div class="table-wrap" data-role="table-wrap">
      <table class="dtable dtable--pods ${sel.size ? 'has-selection' : ''}" role="grid" aria-label="Pods" aria-rowcount="${rows.length}" aria-multiselectable="true">
        <colgroup><col class="c-check"/>${cols.map((c) => `<col class="c-${c.key} ${c.cls || ''}"/>`).join('')}<col class="c-actions"/></colgroup>
        <thead><tr><th class="col-check" scope="col"><input type="checkbox" class="checkbox" aria-label="Select all" data-action="check-all" ${allChecked ? 'checked' : ''} ${!allChecked && someChecked ? 'data-indeterminate="1"' : ''} tabindex="-1"/></th>${cols.map(sortTh).join('')}<th class="col-actions" scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
  }

  function inspectorHead({ iconTile, name, badge, meta, actions, closeAction = 'toggle-inspector' }) {
    return `<div class="inspector__head">
      <div class="inspector__top">${iconTile}
        <div class="inspector__titles"><div class="inspector__name"><span>${name}</span></div><div class="inspector__meta">${meta}</div></div>
        ${btn({ label: 'More actions', icon: 'more', variant: 'ghost', size: 'sm', iconOnly: true, action: 'inspector-menu' })}
        ${btn({ label: 'Close inspector', icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true, k: 'esc', action: closeAction, cls: 'inspector__close' })}
      </div>
      ${badge ? `<div style="margin-top:8px">${badge}</div>` : ''}
      <div class="inspector__actions">${actions}</div></div>`;
  }
  function subTabs(kind, list) {
    const cur = state.inspectorTab[kind];
    return `<div class="tabs" role="tablist" aria-label="Inspector sections">${list.map(([id, label, count, cc]) => `<button type="button" class="tab" role="tab" aria-selected="${cur === id}" tabindex="${cur === id ? 0 : -1}" data-action="itab" data-kind="${kind}" data-id="${id}">${label}${count ? `<span class="tab__count${cc ? ' tab__count--' + cc : ''}">${count}</span>` : ''}</button>`).join('')}</div>`;
  }

  function inPod() {
    const p = PODS.find((x) => x.name === state.podActive) || PODS[0];
    const crash = p.status === 'CrashLoopBackOff';
    const kind = POD_STATUS_KIND[p.status];
    const tab = state.inspectorTab.pod;
    let body = '';
    if (tab === 'overview') {
      body = `${crash ? `<div class="section"><div class="callout callout--danger" role="alert">${ic('alert-circle', 16)}<div><div class="callout__title">Container <b>web</b> keeps getting OOMKilled</div><div class="callout__desc">Exit code 137 · 23 restarts in 3h. Usage peaks at ~310Mi but the limit is 256Mi.</div>
          <div class="row" style="margin-top:8px">${btn({ label: 'View logs', icon: 'logs', size: 'sm', action: 'itab-logs' })}${btn({ label: 'Raise memory limit…', size: 'sm', action: 'toast-demo' })}</div></div></div></div>` : ''}
        <div class="section"><dl class="props">
          <dt>Controlled by</dt><dd><a class="crumb" style="height:22px;margin-left:-6px" href="#/k8s/topology">${ic('workload', 14)}<span>Deployment/web</span></a></dd>
          <dt>Node</dt><dd><span class="ellipsis">${p.node}</span></dd>
          <dt>Pod IP</dt><dd><span class="mono ellipsis">10.244.3.18</span><button class="btn btn--ghost btn--sm btn--icon copy-btn" aria-label="Copy Pod IP" data-action="copy">${ic('copy', 12)}</button></dd>
          <dt>QoS class</dt><dd>Burstable</dd>
          <dt>Service account</dt><dd>web</dd>
          <dt>Created</dt><dd>10:52 today <span class="subtle">· ${p.age} ago</span></dd>
        </dl></div>
        <div class="section"><div class="section__head"><span class="section__title">Containers</span><span class="section__count">2</span></div>
          <div class="container-card" style="padding:4px 0 10px"><div class="container-card__head"><span>web</span><span class="spacer"></span>${crash ? statusHtml('danger', 'Waiting · CrashLoopBackOff') : statusHtml('success', 'Running')}</div>
            <div class="mono subtle ellipsis" style="font-size:11.5px">registry.shop.vn/web:2.14.1</div>
            <div class="container-card__meta"><span>Restarts 23</span><span>CPU 12m / 500m</span><span>Mem 251Mi / <b style="color:var(--text-primary);font-weight:500">256Mi</b></span></div>
            <div class="progress" style="margin-top:2px" role="meter" aria-valuenow="98" aria-valuemin="0" aria-valuemax="100" aria-label="Memory 98% of limit"><span class="progress__bar" style="width:98%;display:block;background:var(--danger)"></span></div></div>
          <div class="container-card" style="padding:10px 0 0;border-top:1px solid var(--border-subtle)"><div class="container-card__head"><span>log-shipper</span><span class="spacer"></span>${statusHtml('success', 'Running')}</div>
            <div class="mono subtle ellipsis" style="font-size:11.5px">fluent/fluent-bit:3.1.7</div>
            <div class="container-card__meta"><span>Restarts 0</span><span>CPU 3m / 100m</span><span>Mem 18Mi / 64Mi</span></div></div>
        </div>
        <div class="section"><div class="section__head"><span class="section__title">Conditions</span></div>
          ${[['Initialized', 1], ['PodScheduled', 1], ['ContainersReady', 0, 'containers with unready status: [web]'], ['Ready', 0, '2m ago']].map(([n, ok, why]) => `<div class="cond-row">${ic(ok ? 'check-circle' : 'x-circle', 14, ok ? 'ok' : 'bad')}<span>${n}</span><span class="subtle ellipsis" style="max-width:55%">${why || '3h ago'}</span></div>`).join('')}
        </div>
        <div class="section"><div class="section__head"><span class="section__title">Labels</span><span class="section__count">4</span></div>
          <div class="row" style="flex-wrap:wrap;gap:6px">${['app=web', 'tier=frontend', 'pod-template-hash=7d9f8c6b5', 'version=2.14.1'].map((l) => { const [k, v] = l.split('='); return `<span class="tag">${k}=<b>${v}</b></span>`; }).join('')}</div></div>`;
    } else if (tab === 'events') {
      body = `<div role="list">${POD_EVENTS.map((e) => `<div class="event${e.type === 'Warning' ? ' event--warning' : ''}" role="listitem">${ic(e.type === 'Warning' ? 'alert' : 'info', 14)}<div style="min-width:0;flex:1">
          <div class="event__head"><span class="event__reason">${e.reason}</span><span class="event__count">×${e.count}</span><span class="event__age">${e.age}</span></div>
          <div class="event__msg">${esc(e.msg)}</div><div class="event__src">${e.src}</div></div></div>`).join('')}</div>`;
    } else if (tab === 'logs') {
      const q = state.logQuery;
      const hl = (s) => q ? esc(s).replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>') : esc(s);
      const matches = POD_LOGS.filter((l) => q && l[2].toLowerCase().includes(q.toLowerCase())).length;
      body = `<div class="logs">
        <div class="logs__bar"><label class="input">${ic('search', 14)}<input type="text" value="${esc(q)}" aria-label="Search logs" data-role="log-search"/><span class="subtle num" style="font-size:11px">${matches ? '1/' + matches : '0'}</span></label>
          ${btn({ label: 'Previous match', icon: 'chevron-up', variant: 'ghost', size: 'sm', iconOnly: true, k: 'shift+enter' })}${btn({ label: 'Next match', icon: 'chevron-down', variant: 'ghost', size: 'sm', iconOnly: true, k: 'enter' })}
          <button type="button" class="btn btn--sm select" style="min-width:0">web${ic('chevron-down', 12)}</button>
          ${btn({ label: 'Wrap lines', icon: 'wrap', variant: 'ghost', size: 'sm', iconOnly: true, k: 'alt+Z' })}</div>
        <div class="logs__body" role="log" aria-label="Logs for container web">${POD_LOGS.map((l) => `<div class="log-line${l[1] === 'err' ? ' is-err' : ''}"><span class="ts">${l[0]}</span><span class="lv ${l[1]}">${l[1].toUpperCase()}</span><span>${hl(l[2])}</span></div>`).join('')}
          <div class="log-line" style="margin-top:6px"><span class="ts">──────</span><span class="subtle">container restarted · previous logs above · following…</span></div></div>
        <div class="logs__foot">${statusHtml('success', 'Following')}<span>· 10 lines · since 3h</span><span class="spacer"></span>${btn({ label: 'Previous container', variant: 'ghost', size: 'sm' })}${btn({ label: 'Open in tab', icon: 'external', variant: 'ghost', size: 'sm', iconOnly: true })}</div></div>`;
    } else if (tab === 'yaml') {
      body = `<pre class="yaml"><span class="k">apiVersion</span>: <span class="s">v1</span>
<span class="k">kind</span>: <span class="s">Pod</span>
<span class="k">metadata</span>:
  <span class="k">name</span>: <span class="s">web-7d9f8c6b5-h8sdl</span>
  <span class="k">namespace</span>: <span class="s">shop</span>
  <span class="k">labels</span>:
    <span class="k">app</span>: <span class="s">web</span>
    <span class="k">tier</span>: <span class="s">frontend</span>
  <span class="k">ownerReferences</span>:
  - <span class="k">kind</span>: <span class="s">ReplicaSet</span>
    <span class="k">name</span>: <span class="s">web-7d9f8c6b5</span>
<span class="k">spec</span>:
  <span class="k">containers</span>:
  - <span class="k">name</span>: <span class="s">web</span>
    <span class="k">image</span>: <span class="s">registry.shop.vn/web:2.14.1</span>
    <span class="k">resources</span>:
      <span class="k">limits</span>:
        <span class="k">cpu</span>: <span class="s">500m</span>
        <span class="k">memory</span>: <span class="s">256Mi</span>   <span class="c"># ← OOMKilled</span>
      <span class="k">requests</span>:
        <span class="k">cpu</span>: <span class="s">100m</span>
        <span class="k">memory</span>: <span class="s">128Mi</span>
    <span class="k">ports</span>:
    - <span class="k">containerPort</span>: <span class="n">8080</span></pre>`;
    } else if (tab === 'metrics') {
      body = `<div class="section stack" style="gap:8px">
        <div class="spark-card"><div class="spark-card__head"><span class="spark-card__label">Memory · over 90% of limit</span><span class="spark-card__value" style="color:var(--danger)">251<small> / 256 Mi</small></span></div>${spark([120, 150, 170, 200, 232, 250, 40, 110, 160, 210, 248, 251, 60, 130, 190, 240, 251], 'var(--danger)')}</div>
        <div class="spark-card"><div class="spark-card__head"><span class="spark-card__label">CPU</span><span class="spark-card__value">12<small> m</small></span></div>${spark([80, 120, 140, 160, 90, 60, 20, 90, 140, 130, 100, 60, 10, 80, 120, 40, 12])}</div>
        <div class="callout callout--info">${ic('info', 14)}<div class="callout__desc" style="margin:0">From metrics-server · 30s resolution · last 1h</div></div></div>`;
    } else {
      body = `<div class="section">${[['workload', 'Deployment', 'web', '2/3 ready', 'warning'], ['layers', 'ReplicaSet', 'web-7d9f8c6b5', '3 desired', ''], ['service', 'Service', 'web', 'ClusterIP 10.96.14.2', ''], ['ingress', 'Ingress', 'shop.vn', 'nginx · TLS', ''], ['file-text', 'ConfigMap', 'web-config', '12 keys', ''], ['server', 'Node', 'pool-a-7xk2', 'Ready · 71% mem', '']]
        .map(([i, k, n, m, s]) => `<a class="list-row" href="${k === 'Deployment' ? '#/k8s/deployments' : '#/k8s/topology'}" style="padding:0 4px;height:40px"><span class="itile${s ? ' itile--' + s : ''}">${ic(i, 14)}</span><span class="list-row__main"><span class="list-row__title"><span>${n}</span></span><span class="list-row__sub">${k} · ${m}</span></span>${ic('chevron-right', 14, 'subtle')}</a>`).join('')}</div>`;
    }
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('pod', 16)}</span>`,
      name: p.name,
      meta: `<span>Pod</span><span class="sep">·</span><span>${p.ns}</span><span class="sep">·</span><span>${p.age}</span>`,
      badge: `${chipHtml(kind, p.status)}<span class="subtle" style="font-size:12px;margin-left:8px">${p.ready} ready · ${p.restarts} restarts</span>`,
      actions: btn({ label: 'Logs', icon: 'logs', size: 'sm', k: 'L', tipText: 'Logs', action: 'itab-logs' }) + btn({ label: 'Shell', icon: 'terminal-square', size: 'sm', k: 'S', tipText: 'Open shell', action: 'toast-demo' }) + btn({ label: 'Port-forward', icon: 'route', size: 'sm', iconOnly: true, k: 'F' }) + btn({ label: 'Edit YAML', icon: 'code', size: 'sm', iconOnly: true, k: 'E' }) + '<span class="spacer"></span>' + btn({ label: 'Delete Pod', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, k: 'mod+backspace', action: 'delete-pod', cls: 'is-danger' })
    }) + subTabs('pod', [['overview', t('overview')], ['events', t('events'), '7', crash ? 'warning' : ''], ['logs', t('logs')], ['yaml', 'YAML'], ['metrics', t('metrics')], ['related', t('related')]]) + `<div class="inspector__body" style="${tab === 'logs' ? 'display:flex;flex-direction:column;overflow:hidden' : ''}">${body}</div>`;
  }

  /* 6.4 Kubernetes — Topology */
  const G = { cardW: 184, cardH: 48, laneW: 212, laneGap: 44, pad: 16, top: 48, pitch: 58, groupGap: 14 };
  function layoutTopo() {
    const laneX = {};
    TOPO.lanes.forEach((l, i) => { laneX[l.id] = G.pad + i * (G.laneW + G.laneGap); });
    const pos = {};
    const byId = Object.fromEntries(TOPO.nodes.map((n) => [n.id, n]));
    const children = (id) => TOPO.edges.filter((e) => e[0] === id).map((e) => e[1]);
    const workloads = TOPO.nodes.filter((n) => n.lane === 'wl');
    let y = G.top + 8;
    workloads.forEach((w) => {
      const pods = children(w.id);
      const ys = pods.map((p) => { const yy = y; pos[p] = { x: laneX.pod + (G.laneW - G.cardW) / 2, y: yy }; y += G.pitch; return yy; });
      pos[w.id] = { x: laneX.wl + (G.laneW - G.cardW) / 2, y: (ys[0] + ys[ys.length - 1]) / 2 };
      y += G.groupGap;
    });
    TOPO.nodes.filter((n) => n.lane === 'svc').forEach((s) => {
      const w = children(s.id)[0];
      pos[s.id] = { x: laneX.svc + (G.laneW - G.cardW) / 2, y: pos[w].y };
    });
    TOPO.nodes.filter((n) => n.lane === 'entry').forEach((n) => {
      const ys = children(n.id).map((c) => pos[c].y);
      pos[n.id] = { x: laneX.entry + (G.laneW - G.cardW) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    });
    const h = y - G.groupGap + 16;
    const w = G.pad * 2 + TOPO.lanes.length * G.laneW + (TOPO.lanes.length - 1) * G.laneGap;
    return { pos, laneX, w, h, byId };
  }
  function edgePath(a, b) {
    const x1 = a.x + G.cardW, y1 = a.y + G.cardH / 2, x2 = b.x, y2 = b.y + G.cardH / 2;
    const mx = Math.round(x1 + (x2 - x1) / 2), r = 6;
    if (Math.abs(y2 - y1) < 1) return `M${x1} ${y1} H${x2}`;
    const s = y2 > y1 ? 1 : -1, rr = Math.min(r, Math.abs(y2 - y1) / 2);
    return `M${x1} ${y1} H${mx - rr} Q${mx} ${y1} ${mx} ${y1 + s * rr} V${y2 - s * rr} Q${mx} ${y2} ${mx + rr} ${y2} H${x2}`;
  }
  function shortName(n) {
    if (n.lane !== 'pod' || n.name.length < 20) return esc(n.name);
    const parts = n.name.split('-');
    return `${esc(parts[0])}<span class="subtle">-…-</span>${esc(parts[parts.length - 1])}`;
  }
  function ctTopology() {
    const L = layoutTopo();
    const lanes = TOPO.lanes.map((l) => {
      const n = TOPO.nodes.filter((x) => x.lane === l.id).length;
      return `<div class="lane" style="left:${L.laneX[l.id]}px;width:${G.laneW}px;height:${L.h}px"><div class="lane__label"><b>${l.label}</b><span>${n}</span></div></div>`;
    }).join('');
    const edges = TOPO.edges.map(([a, b, kind], i) => `<path class="edge${kind ? ' edge--problem' : ''}" data-edge="${i}" data-from="${a}" data-to="${b}" d="${edgePath(L.pos[a], L.pos[b])}"/>`).join('');
    const dots = TOPO.edges.map(([a, b], i) => `<circle class="edge-dot" data-edge="${i}" cx="${L.pos[b].x}" cy="${L.pos[b].y + G.cardH / 2}" r="2.5"/>`).join('');
    const nodes = TOPO.nodes.map((n) => {
      const p = L.pos[n.id];
      const tile = n.lane === 'pod' ? (n.st === 'danger' ? 'itile--danger' : n.st === 'warning' ? 'itile--warning' : '') : n.sev === 'danger' ? 'itile--danger' : n.sev === 'warning' ? 'itile--warning' : '';
      return `<div class="gnode${n.problem && n.sev === 'danger' ? ' gnode--problem' : ''}${state.graphSelected === n.id ? ' is-selected' : ''}" style="left:${p.x}px;top:${p.y}px;width:${G.cardW}px;height:${G.cardH}px" data-node="${n.id}" tabindex="0" role="button" aria-label="${esc(n.meta.split(' · ')[0])} ${esc(n.name)}${n.problem ? ', problem: ' + esc(n.problem) : ''}" title="${esc(n.name)}">
        <span class="itile ${tile}">${ic(n.icon, 14)}</span>
        <span class="gnode__body"><span class="gnode__name" style="display:block">${shortName(n)}</span><span class="gnode__meta">${n.lane === 'pod' && n.st !== 'success' ? `<span class="dot dot--${n.st}"></span>` : ''}${esc(n.meta)}</span></span>
        ${n.pods ? `<span class="gnode__pods" aria-hidden="true">${n.pods.map((s) => `<i class="${s === 'bad' ? 'bad' : s === 'pend' ? 'pend' : ''}"></i>`).join('')}</span>` : ''}
        ${n.problem ? `<span class="gnode__problem${n.sev === 'warning' ? ' gnode__problem--warning' : ''}">${ic(n.sev === 'warning' ? 'alert' : 'alert-circle', 10)}${esc(n.problem)}</span>` : ''}
      </div>`;
    }).join('');
    return `<div class="toolbar" role="toolbar" aria-label="Topology toolbar">
        <label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="Find in graph…" aria-label="Find in graph" data-role="graph-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip" data-action="toast-demo">Kinds: <b>All</b></button><button type="button" class="chip chip--add" data-action="toast-demo">${ic('plus', 12)}Filter</button></div>
        <span class="spacer"></span>
        <span class="toolbar-count">${TOPO.nodes.length} nodes · ${TOPO.edges.length} links</span>
        <div class="segmented segmented--icon" role="radiogroup" aria-label="View">
          <a class="segmented__item" role="radio" aria-checked="false" href="#/k8s/pods" aria-label="Table"${tip('Table view', 'v t')}>${ic('list', 14)}</a>
          <a class="segmented__item" role="radio" aria-checked="true" href="#/k8s/topology" aria-label="Topology"${tip('Topology view', 'v g')}>${ic('network', 14)}</a>
        </div>
        <button type="button" class="btn btn--ghost" data-action="menu-view" aria-haspopup="menu">${ic('sliders', 14)}<span>View</span>${ic('chevron-down', 12)}</button>
      </div>
      <div class="graph" data-role="graph" aria-label="Topology of namespace shop" role="application">
        <div class="graph__canvas" data-role="canvas" style="width:${L.w}px;height:${L.h}px">
          <div class="graph__lanes">${lanes}</div>
          <svg class="edges" width="${L.w}" height="${L.h}" aria-hidden="true">${edges}${dots}</svg>
          ${nodes}
        </div>
        <div class="graph-legend" aria-label="Legend">
          <span><span class="legend-line" aria-hidden="true"></span>Routes to</span>
          <span><span class="legend-line legend-line--problem" aria-hidden="true"></span>Broken path</span>
          <span><span class="legend-line legend-line--hl" aria-hidden="true"></span>Hovered path</span>
          <span><span class="gnode__pods" aria-hidden="true" style="margin:0"><i></i><i class="bad"></i><i class="pend"></i></span>Pod ready / failing / pending</span>
        </div>
        <div class="graph-ctl" role="toolbar" aria-label="Zoom">
          ${btn({ label: 'Zoom out', icon: 'zoom-out', variant: 'ghost', size: 'sm', iconOnly: true, k: '-', action: 'zoom-out' })}
          <span class="zoom-val" data-role="zoom-val">100%</span>
          ${btn({ label: 'Zoom in', icon: 'zoom-in', variant: 'ghost', size: 'sm', iconOnly: true, k: '+', action: 'zoom-in' })}
          <span class="header-sep" aria-hidden="true" style="margin:0 2px"></span>
          ${btn({ label: 'Fit to screen', icon: 'maximize', variant: 'ghost', size: 'sm', iconOnly: true, k: 'shift+1', action: 'zoom-fit' })}
        </div>
        ${problemsPanel()}
      </div>`;
  }
  function problemsPanel() {
    if (!state.problemsOpen) {
      return `<button type="button" class="btn graph-problems" style="width:auto;padding:0 10px;height:30px;display:inline-flex" data-action="toggle-problems">${ic('alert-circle', 14, '')}<span style="color:var(--danger)">${TOPO.problems.length} problems</span>${ic('chevron-down', 12)}</button>`;
    }
    return `<section class="graph-problems" aria-label="Problems">
      <div class="graph-problems__head">${ic('alert-circle', 14)}<span>${TOPO.problems.length} problems in shop</span><span class="spacer"></span>${btn({ label: 'Collapse problems', icon: 'chevron-up', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toggle-problems' })}</div>
      ${TOPO.problems.map((p) => `<div class="problem" data-problem-node="${p.node}" tabindex="0" role="button">${ic(p.sev === 'danger' ? 'alert-circle' : 'alert', 14, '')}<div style="min-width:0"><div class="problem__title">${p.title}</div><div class="problem__desc">${p.desc}</div></div></div>`).join('')}
    </section>`;
  }
  function connected(id) {
    const set = new Set([id]);
    const walk = (cur, dir) => TOPO.edges.forEach(([a, b]) => {
      const [from, to] = dir ? [a, b] : [b, a];
      if (from === cur && !set.has(to)) { set.add(to); walk(to, dir); }
    });
    walk(id, true); walk(id, false);
    return set;
  }
  function highlightGraph(id) {
    const g = $('[data-role="graph"]'); if (!g) return;
    const set = id ? connected(id) : null;
    $$('.gnode', g).forEach((n) => { n.classList.toggle('is-dim', !!set && !set.has(n.dataset.node)); n.classList.toggle('is-hl', !!set && set.has(n.dataset.node) && n.dataset.node !== id); });
    $$('.edge, .edge-dot', g).forEach((e) => {
      const [a, b] = TOPO.edges[+e.dataset.edge];
      const on = set && set.has(a) && set.has(b);
      e.classList.toggle('is-hl', !!on); e.classList.toggle('is-dim', !!set && !on);
    });
  }
  const graphView = { x: 0, y: 0, z: 1 };
  function applyGraphTransform() {
    const c = $('[data-role="canvas"]'); if (!c) return;
    c.style.transform = `translate(${graphView.x}px, ${graphView.y}px) scale(${graphView.z})`;
    const v = $('[data-role="zoom-val"]'); if (v) v.textContent = Math.round(graphView.z * 100) + '%';
  }
  function fitGraph(animate) {
    const g = $('[data-role="graph"]'), c = $('[data-role="canvas"]'); if (!g || !c) return;
    const L = layoutTopo();
    const gw = g.clientWidth, gh = g.clientHeight;
    // Problems panel chỉ mở mặc định khi còn đủ chỗ — không bao giờ che node.
    const reserveR = state.problemsOpen ? 324 : 0;
    const availW = gw - 32 - reserveR, availH = gh - 24 - 52;
    const z = Math.max(0.5, Math.min(1, availW / L.w, availH / L.h));
    graphView.z = Math.round(z * 100) / 100;
    graphView.x = Math.max(16, Math.round((gw - reserveR - L.w * graphView.z) / 2));
    graphView.y = 12;
    if (!animate) c.style.transition = 'none';
    applyGraphTransform();
    if (!animate) requestAnimationFrame(() => { c.style.transition = ''; });
  }
  function setupGraph() {
    const g = $('[data-role="graph"]'); if (!g) return;
    const L = layoutTopo();
    if (state.problemsAuto !== false) state.problemsOpen = g.clientWidth - 32 - 324 >= L.w * 0.86;
    // render lại panel theo trạng thái tự động
    const old = $('.graph-problems', g); if (old) old.outerHTML = problemsPanel();
    fitGraph(false);
    g.addEventListener('mouseover', (e) => { const n = e.target.closest('.gnode, .problem'); if (n) highlightGraph(n.dataset.node || n.dataset.problemNode); });
    g.addEventListener('mouseout', (e) => { const n = e.target.closest('.gnode, .problem'); if (n && !n.contains(e.relatedTarget)) highlightGraph(null); });
    g.addEventListener('focusin', (e) => { const n = e.target.closest('.gnode'); if (n) highlightGraph(n.dataset.node); });
    g.addEventListener('focusout', () => highlightGraph(null));
    g.addEventListener('click', (e) => {
      const n = e.target.closest('.gnode, .problem'); if (!n) return;
      const id = n.dataset.node || n.dataset.problemNode;
      if (id === 'pod/web-h8sdl') { state.podActive = 'web-7d9f8c6b5-h8sdl'; state.inspector = true; location.hash = '#/k8s/pods'; return; }
      state.graphSelected = id;
      $$('.gnode', g).forEach((x) => x.classList.toggle('is-selected', x.dataset.node === id));
    });
    g.addEventListener('contextmenu', (e) => {
      const n = e.target.closest('.gnode'); if (!n) return;
      e.preventDefault();
      const node = TOPO.nodes.find((x) => x.id === n.dataset.node);
      openMenu(e.clientX, e.clientY, resourceMenu(node.meta.split(' · ')[0], node.name));
    });
    let drag = null;
    g.addEventListener('mousedown', (e) => { if (e.target.closest('.gnode, .graph-ctl, .graph-legend, .graph-problems, button')) return; drag = { x: e.clientX - graphView.x, y: e.clientY - graphView.y }; $('[data-role="canvas"]').style.transition = 'none'; });
    window.addEventListener('mousemove', (e) => { if (!drag) return; graphView.x = e.clientX - drag.x; graphView.y = e.clientY - drag.y; applyGraphTransform(); });
    window.addEventListener('mouseup', () => { if (drag) { drag = null; const c = $('[data-role="canvas"]'); if (c) c.style.transition = ''; } });
    g.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 0.1 : -0.1); }, { passive: false });
  }
  function zoomBy(d) { graphView.z = Math.max(0.4, Math.min(2, Math.round((graphView.z + d) * 10) / 10)); applyGraphTransform(); }

  /* 6.5 Docker — Containers + Compose */
  const C_STATE = { running: 'success', exited: 'neutral', paused: 'neutral', restarting: 'warning' };
  const C_HEALTH = { healthy: ['success', 'Healthy'], unhealthy: ['danger', 'Unhealthy'], starting: ['warning', 'Starting'] };
  function containerRow(c, indent) {
    const active = state.inspector && state.containerActive === c.name;
    const h = C_HEALTH[c.health];
    return `<tr data-crow="${c.name}" class="${active ? 'is-active' : ''}" aria-selected="${state.containerSel.has(c.name)}" tabindex="-1">
      <td class="col-check"><input type="checkbox" class="checkbox" aria-label="Select ${c.name}" data-action="crow-check" ${state.containerSel.has(c.name) ? 'checked' : ''} tabindex="-1"/></td>
      <td class="cell-primary${indent ? ' indent-1' : ''}"><span class="cell-name">${ic('container', 14)}<span>${indent ? c.service + (c.name.endsWith('-2') ? ' <span class="cell-sub">#2</span>' : '') : c.name}</span></span></td>
      <td class="col-opt-2"><span class="mono ellipsis" style="font-size:11.5px;display:block">${c.image}</span></td>
      <td>${statusHtml(C_STATE[c.state] || 'neutral', c.state[0].toUpperCase() + c.state.slice(1))}</td>
      <td>${h ? `<span class="${h[0] === 'success' ? 'muted' : 't-' + h[0]}">${h[1]}</span>` : '<span class="subtle">—</span>'}</td>
      <td>${c.state === 'running' ? meter(Math.min(100, c.cpu * 1.6), c.cpu.toFixed(1) + '%') : '<span class="subtle">—</span>'}</td>
      <td>${c.memL !== '—' ? meter(c.mem, c.memL) : '<span class="subtle">—</span>'}</td>
      <td class="col-opt-1">${c.ports.length ? c.ports.map((p) => `<span class="tag">${p}</span>`).join(' ') : '<span class="subtle">—</span>'}</td>
      <td class="col-opt-1">${c.uptime}</td>
      <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions for ${c.name}" data-action="row-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`;
  }
  function ctDocker() {
    const compose = state.dockerView === 'compose';
    const head = `<colgroup><col style="width:36px"/><col/><col class="col-opt-2" style="width:22%"/><col style="width:104px"/><col style="width:116px"/><col style="width:104px"/><col style="width:120px"/><col class="col-opt-1" style="width:150px"/><col class="col-opt-1" style="width:120px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"><input type="checkbox" class="checkbox" aria-label="Select all" tabindex="-1"/></th><th aria-sort="none">Name</th><th class="col-opt-2">Image</th><th aria-sort="ascending" class="is-sortable">State</th><th>Health</th><th>CPU</th><th>Memory</th><th class="col-opt-1">Ports</th><th class="col-opt-1">Uptime</th><th class="col-actions"><span class="sr-only">Actions</span></th></tr></thead>`;
    let body = '';
    if (compose) {
      COMPOSE.forEach((p) => {
        const cs = CONTAINERS.filter((c) => c.project === p.name);
        const run = cs.filter((c) => c.state === 'running').length;
        const bad = cs.some((c) => c.health === 'unhealthy');
        const kind = run === 0 ? 'neutral' : bad ? 'warning' : 'success';
        body += `<tr class="group-row"><td class="col-check"><input type="checkbox" class="checkbox" aria-label="Select project ${p.name}" tabindex="-1"/></td>
          <td colspan="9"><span class="row" style="gap:8px">${ic('chevron-down', 14, 'subtle')}${ic('layers', 14)}<span>${p.name}</span>
            ${statusHtml(kind, run === 0 ? 'Stopped' : `${run}/${cs.length} running${bad ? ' · 1 unhealthy' : ''}`).replace('class="status', 'style="font-weight:400;font-size:12px" class="status')}
            <span class="mono subtle" style="font-size:11px;font-weight:400">${p.file}</span>
            <span class="group-actions">
              ${run === 0 ? btn({ label: 'Up', icon: 'play', variant: 'ghost', size: 'sm', tipText: 'docker compose up -d', action: 'toast-demo' }) : btn({ label: 'Stop', icon: 'stop', variant: 'ghost', size: 'sm', tipText: 'docker compose stop', action: 'toast-demo' })}
              ${btn({ label: 'Restart', icon: 'restart', variant: 'ghost', size: 'sm', iconOnly: true, tipText: 'docker compose restart', action: 'toast-demo' })}
              ${btn({ label: 'Logs', icon: 'logs', variant: 'ghost', size: 'sm', iconOnly: true, tipText: 'Aggregated logs' })}
              ${btn({ label: 'Edit compose file', icon: 'file-code', variant: 'ghost', size: 'sm', iconOnly: true })}
              ${btn({ label: 'Project actions', icon: 'more', variant: 'ghost', size: 'sm', iconOnly: true, action: 'compose-menu', data: ` data-project="${p.name}"` })}
            </span></span></td></tr>`;
        body += cs.map((c) => containerRow(c, true)).join('');
      });
      body += `<tr class="group-row"><td class="col-check"></td><td colspan="9"><span class="row" style="gap:8px">${ic('chevron-down', 14, 'subtle')}${ic('container', 14)}<span>Standalone</span><span class="subtle" style="font-weight:400;font-size:12px">2 containers</span></span></td></tr>`;
      body += CONTAINERS.filter((c) => !c.project).map((c) => containerRow(c, false)).join('');
    } else {
      body = CONTAINERS.map((c) => containerRow(c, false)).join('');
    }
    return `<div class="toolbar" role="toolbar" aria-label="Containers toolbar">
        <label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="${t('filter')}" aria-label="Filter containers" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">State: <b>Any</b></button><button type="button" class="chip">Health: <b>Any</b></button><button type="button" class="chip chip--add" data-action="toast-demo">${ic('plus', 12)}Filter</button></div>
        <span class="spacer"></span>
        <span class="toolbar-count">${CONTAINERS.length} containers · 10 running</span>
        <div class="segmented" role="radiogroup" aria-label="Group by">
          <a class="segmented__item" role="radio" aria-checked="${!compose}" href="#/docker">${ic('list', 14)}Containers</a>
          <a class="segmented__item" role="radio" aria-checked="${compose}" href="#/docker/compose">${ic('layers', 14)}Compose</a>
        </div>
        ${btn({ label: 'Columns', icon: 'columns', variant: 'ghost', iconOnly: true })}
        ${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', iconOnly: true, k: 'shift+R' })}
      </div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Containers">${head}<tbody>${body}</tbody></table></div>`;
  }
  function inContainer() {
    const c = CONTAINERS.find((x) => x.name === state.containerActive) || CONTAINERS[1];
    const tab = state.inspectorTab.container;
    const h = C_HEALTH[c.health];
    let body = '';
    if (tab === 'overview') {
      body = `${c.health === 'unhealthy' ? `<div class="section"><div class="callout callout--warning" role="alert">${ic('alert', 16)}<div><div style="min-width:0"><div class="callout__title">Health check failing for 4m</div><div class="callout__desc">Timed out after 5s · 5 consecutive failures</div><div class="mono ellipsis" style="margin-top:6px;font-size:11.5px;color:var(--text-secondary)">$ curl -f http://localhost:3000/health</div></div></div></div></div>` : ''}
        <div class="section"><dl class="props">
          <dt>State</dt><dd>${statusHtml(C_STATE[c.state], c.uptime)}</dd>
          <dt>Image</dt><dd><span class="mono ellipsis">${c.image}</span><button class="btn btn--ghost btn--sm btn--icon copy-btn" aria-label="Copy image" data-action="copy">${ic('copy', 12)}</button></dd>
          <dt>Container ID</dt><dd><span class="mono ellipsis">4f9a1c2e7b3d</span><button class="btn btn--ghost btn--sm btn--icon copy-btn" aria-label="Copy ID" data-action="copy">${ic('copy', 12)}</button></dd>
          <dt>Compose</dt><dd>${ic('layers', 14, 'subtle')}<span>${c.project || '—'} · ${c.service || ''}</span></dd>
          <dt>Ports</dt><dd>${c.ports.map((p) => `<span class="tag">${p}/tcp</span>`).join(' ') || '—'}</dd>
          <dt>Restart policy</dt><dd>unless-stopped</dd>
          <dt>Network</dt><dd>shop-stack_default · 172.19.0.4</dd>
        </dl></div>
        <div class="section"><div class="section__head"><span class="section__title">Resources</span><span class="spacer"></span><span class="subtle" style="font-size:12px">live · 2s</span></div>
          <div class="stack" style="gap:0">
            <div class="spark-card"><div class="spark-card__head"><span class="spark-card__label">CPU</span><span class="spark-card__value">${c.cpu}<small>%</small></span></div>${spark([12, 18, 22, 30, 28, 35, 41, 39, 44, 52, 47, 49, 46, 48])}</div>
            <div class="spark-card"><div class="spark-card__head"><span class="spark-card__label">Memory</span><span class="spark-card__value">1.39<small> / 2 GiB</small></span></div>${spark([0.9, 0.95, 1.0, 1.05, 1.1, 1.12, 1.2, 1.24, 1.3, 1.31, 1.35, 1.37, 1.38, 1.39], 'var(--chart-2)')}</div>
          </div></div>
        <div class="section"><div class="section__head"><span class="section__title">Mounts</span><span class="section__count">2</span></div>
          ${[['/srv/shop/uploads', '/app/uploads', 'rw'], ['shop-stack_cache', '/app/.cache', 'volume']].map(([a, b, m]) => `<div class="cond-row">${ic(m === 'volume' ? 'bucket' : 'folder', 14, 'subtle')}<span class="mono ellipsis" style="font-size:12px">${a} → ${b}</span><span class="subtle">${m}</span></div>`).join('')}</div>`;
    } else if (tab === 'stats') {
      body = `<div class="section stack" style="gap:0">
        ${[['CPU', c.cpu + '<small>%</small>', [12, 18, 22, 30, 28, 35, 41, 39, 44, 52, 47, 49, 46, 48], 'var(--chart-1)'], ['Memory', '1.39<small> GiB</small>', [0.9, 0.95, 1, 1.05, 1.1, 1.12, 1.2, 1.24, 1.3, 1.31, 1.35, 1.37, 1.38, 1.39], 'var(--chart-1)'], ['Network I/O', '2.4<small> MB/s</small>', [1, 2, 1.5, 3, 2.2, 2.8, 2, 3.4, 2.4, 2.1, 2.9, 2.4, 2.2, 2.4], 'var(--chart-1)'], ['Block I/O', '120<small> KB/s</small>', [5, 3, 9, 4, 12, 8, 6, 14, 7, 9, 11, 10, 12, 12], 'var(--chart-1)']]
          .map(([l, v, d, col]) => `<div class="spark-card"><div class="spark-card__head"><span class="spark-card__label">${l}</span><span class="spark-card__value">${v}</span></div>${spark(d, col)}</div>`).join('')}</div>`;
    } else if (tab === 'env') {
      const env = [['NODE_ENV', 'production', 0], ['PORT', '3000', 0], ['DATABASE_URL', 'postgres://shop:S3cr3t-pg@postgres:5432/shop', 1], ['REDIS_URL', 'redis://redis:6379/0', 0], ['JWT_SECRET', 'f0a9c2d1e8b7…', 1], ['STRIPE_API_KEY', 'sk_live_51Hx…', 1], ['LOG_LEVEL', 'info', 0], ['TZ', 'Asia/Ho_Chi_Minh', 0]];
      body = `<div class="section"><div class="callout callout--info" style="margin-bottom:8px">${ic('eye-off', 14)}<div class="callout__desc" style="margin:0">Values that look like secrets are masked. Revealing is logged in the audit trail.</div></div>
        ${env.map(([k, v, s]) => { const show = !s || state.envReveal.has(k); return `<div class="env-row"><span class="env-row__k">${k}</span><span class="env-row__v${show ? '' : ' masked'}">${show ? esc(v) : '••••••••••••'}</span>${s ? `<button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="${show ? 'Hide' : 'Reveal'} ${k}" data-action="reveal-env" data-key="${k}">${ic(show ? 'eye-off' : 'eye', 12)}</button>` : ''}<button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Copy ${k}" data-action="copy">${ic('copy', 12)}</button></div>`; }).join('')}</div>`;
    } else {
      body = `<div class="sidepanel__path" style="border-top:0">${ic('folder-open', 14)}/app<span class="spacer"></span>${btn({ label: 'Upload into container', icon: 'upload', variant: 'ghost', size: 'sm', iconOnly: true })}</div>
        ${[['dist', 1, ''], ['node_modules', 1, ''], ['uploads', 1, ''], ['.cache', 1, ''], ['package.json', 0, '2.1 KB'], ['server.js', 0, '418 B'], ['healthcheck.sh', 0, '220 B']].map(([n, d, s]) => `<div class="file-row">${ic(d ? 'folder' : 'file', 14, d ? 'is-folder' : '')}<span class="ellipsis">${n}</span><span class="file-row__size">${s}</span></div>`).join('')}`;
    }
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('container', 16)}</span>`,
      name: c.name,
      meta: `<span>Container</span><span class="sep">·</span><span>build-server</span><span class="sep">·</span><span>${c.uptime.replace('Up ', '')}</span>`,
      badge: h && h[0] === 'danger' ? chipHtml('danger', h[1]) : chipHtml(C_STATE[c.state] || 'neutral', c.state[0].toUpperCase() + c.state.slice(1) + (h ? ' · ' + h[1] : '')),
      actions: btn({ label: 'Logs', icon: 'logs', size: 'sm', k: 'L', tipText: 'Logs' }) + btn({ label: 'Exec', icon: 'terminal-square', size: 'sm', k: 'S', tipText: 'Open shell (docker exec)' }) + btn({ label: 'Restart', icon: 'restart', size: 'sm', iconOnly: true, k: 'shift+R', action: 'toast-demo' }) + btn({ label: 'Stop', icon: 'stop', size: 'sm', iconOnly: true }) + '<span class="spacer"></span>' + btn({ label: 'Remove container', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'delete-container' })
    }) + subTabs('container', [['overview', t('overview')], ['stats', 'Stats'], ['env', 'Env', '8'], ['files', 'Files']]) + `<div class="inspector__body">${body}</div>`;
  }

  /* 6.5b Docker — Overview / Images / Volumes / Networks */
  function dockerToolbar(name, count, actions) {
    return `<div class="toolbar" role="toolbar" aria-label="${name} toolbar"><label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="${t('filter')}" aria-label="Filter ${name}" data-role="table-filter"/>${kbd('/')}</label>
      <span class="spacer"></span><span class="toolbar-count">${count}</span>${actions}${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', iconOnly: true, k: 'shift+R' })}</div>`;
  }
  function ctDockerOverview() {
    const u = [['Images', 4.9, 1.6, '4.9 GB', '1.6 GB reclaimable', 'Reclaimable = dangling and unused images.'], ['Containers', 0.4, 0.05, '412 MB', '48 MB reclaimable', 'Writable layers of stopped containers.'], ['Volumes', 24.1, 0.64, '24.1 GB', '640 MB reclaimable', 'Reclaimable = anonymous volumes no container uses.'], ['Build cache', 3.2, 3.2, '3.2 GB', '3.2 GB reclaimable', '']];
    const max = 26;
    return `<div class="page"><div class="page__inner" style="max-width:960px">
      <div class="row" style="align-items:flex-end"><div style="flex:1"><h1 class="page__title">build-server</h1><p class="page__desc">Docker Engine 27.3.1 · Ubuntu 24.04 · 8 CPU · 31.3 GB · via SSH deploy@10.20.2.5</p></div>${btn({ label: 'Clean up…', icon: 'trash', action: 'toast-demo', tipText: 'Preview and remove 5.5 GB' })}</div>
      <div class="stat-row" style="margin-top:24px">
        ${[['13', 'Containers'], ['10', 'Running', 'success'], ['2', 'Stopped'], ['1', 'Unhealthy', 'danger'], ['3', 'Compose projects'], [String(IMAGES.length), 'Images']].map(([v, l, tone]) => `<div class="stat"><span class="stat__v${tone ? ' is-' + tone : ''}">${v}</span><span class="stat__l">${l}</span></div>`).join('')}
      </div>
      <div class="h-section">Disk usage <span class="count">32.6 GB used · 5.5 GB reclaimable</span></div>
      <div class="plain-list">${u.map(([n, used, rec, uL, rL, hint]) => `<div class="usage"><span>${n}</span><span class="usage__bar" aria-hidden="true"><i style="width:${((used - rec) / max) * 100}%"></i><i class="rec" style="left:${((used - rec) / max) * 100}%;width:${(rec / max) * 100}%"></i></span><span class="num muted" style="text-align:right"${hint ? tip(hint) : ''}>${uL} <span class="subtle">· ${rL}</span></span></div>`).join('')}</div>
      <p class="subtle" style="font-size:12px;margin-top:8px">Lighter = reclaimable. Measured via docker system df · 2 min ago.</p>
      <div class="h-section" style="margin-top:32px">Needs attention <span class="count">2</span></div>
      <div class="plain-list">
        <a class="attn-row plain" href="#/docker"><span class="sev-ic sev-ic--danger">${ic('alert-circle', 14)}</span><span style="flex:1;min-width:0"><span class="attn-row__title">shop-stack-api-1<span class="badge badge--danger" style="height:18px">Unhealthy</span></span><span class="attn-row__desc" style="display:block">Health check failed 5× — GET /health timed out after 5s</span></span></a>
        <a class="attn-row plain" href="#/docker/compose"><span class="sev-ic sev-ic--info">${ic('info', 14)}</span><span style="flex:1;min-width:0"><span class="attn-row__title">legacy-crm stopped 3 hours ago</span><span class="attn-row__desc" style="display:block">app exited with code 1 · db exited with code 0</span></span></a>
      </div>
    </div></div>`;
  }
  function ctImages() {
    return dockerToolbar('images', `${IMAGES.length} images · 4.9 GB`, btn({ label: 'Build…', icon: 'code', variant: 'ghost', action: 'build-dialog' }) + btn({ label: 'Pull', icon: 'download', variant: 'primary', k: 'n', tipText: 'Pull an image', action: 'pull-dialog' })) +
      `<div class="table-wrap"><table class="dtable" role="grid" aria-label="Images"><colgroup><col style="width:36px"/><col/><col style="width:120px"/><col class="col-opt-2" style="width:130px"/><col style="width:90px"/><col class="col-opt-1" style="width:120px"/><col style="width:110px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"><input type="checkbox" class="checkbox" aria-label="Select all" tabindex="-1"/></th><th>Repository</th><th>Tag</th><th class="col-opt-2">Image ID</th><th class="is-num">Size</th><th class="col-opt-1">Created</th><th>Used by</th><th></th></tr></thead><tbody>
      ${IMAGES.map((im) => { const key = im.repo + ':' + im.tag; return `<tr data-irow="${esc(key)}" class="${state.inspector && state.imageActive === key ? 'is-active' : ''}" tabindex="-1"><td class="col-check"><input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${esc(key)}"/></td>
        <td class="cell-primary"><span class="cell-name">${ic('archive', 14, 'subtle')}<span class="${im.dangling ? 'subtle' : ''}" style="${im.dangling ? 'font-weight:400' : ''}">${esc(im.repo)}</span></span></td>
        <td><span class="mono">${esc(im.tag)}</span></td><td class="col-opt-2"><span class="mono subtle">${im.id}</span></td><td class="is-num num">${im.size}</td><td class="col-opt-1">${im.created}</td>
        <td>${im.used ? `${im.used} container${im.used > 1 ? 's' : ''}` : `<span class="subtle">${im.dangling ? 'Dangling' : 'Unused'}</span>`}</td>
        <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions" data-action="image-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function inImage() {
    const key = state.imageActive, im = IMAGES.find((x) => x.repo + ':' + x.tag === key) || IMAGES[0];
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('archive', 16)}</span>`, name: `${esc(im.repo)}:<span class="muted" style="font-weight:500">${esc(im.tag)}</span>`,
      meta: `<span>Image</span><span class="sep">·</span><span>${im.size}</span><span class="sep">·</span><span>${im.created}</span>`,
      actions: btn({ label: 'Run…', icon: 'play', size: 'sm', action: 'toast-demo' }) + btn({ label: 'Tag…', icon: 'tag', size: 'sm', action: 'toast-demo' }) + btn({ label: 'Push', icon: 'upload', size: 'sm', iconOnly: true, tipText: 'Push to registry.shop.vn', action: 'toast-demo' }) + '<span class="spacer"></span>' + btn({ label: 'Remove image', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'toast-demo' })
    }) + `<div class="inspector__body"><div class="section"><dl class="props">
        <dt>Image ID</dt><dd><span class="mono ellipsis">sha256:${im.id}e9…</span></dd><dt>Platform</dt><dd>linux/amd64</dd><dt>Registry</dt><dd>registry.shop.vn · signed in</dd>
        <dt>Entrypoint</dt><dd><span class="mono">node server.js</span></dd><dt>Exposed</dt><dd><span class="mono">3000/tcp</span></dd><dt>Used by</dt><dd>shop-stack-api-1</dd></dl></div>
      <div class="section"><div class="section__head"><span class="section__title">Layers</span><span class="section__count">9</span></div>
        ${[['FROM node:22-alpine', '132 MB'], ['RUN apk add --no-cache tini curl', '6.1 MB'], ['WORKDIR /app', '0 B'], ['COPY package*.json ./', '412 KB'], ['RUN npm ci --omit=dev', '248 MB'], ['COPY dist ./dist', '24.6 MB'], ['HEALTHCHECK CMD curl -f localhost:3000/health', '0 B'], ['EXPOSE 3000', '0 B'], ['CMD ["node","server.js"]', '0 B']].map(([c, sz]) => `<div class="kv-line"><span class="mono ellipsis" style="font-size:11.5px;color:var(--text-secondary)">${esc(c)}</span><span class="subtle num">${sz}</span></div>`).join('')}</div></div>`;
  }
  function ctVolumes() {
    return dockerToolbar('volumes', `${VOLUMES.length} volumes · 24.1 GB`, btn({ label: 'Remove unused…', variant: 'ghost', action: 'toast-demo' }) + btn({ label: 'New volume', icon: 'plus', variant: 'ghost', k: 'n', action: 'toast-demo' })) +
      `<div class="table-wrap"><table class="dtable" role="grid" aria-label="Volumes"><colgroup><col style="width:36px"/><col/><col style="width:120px"/><col style="width:100px"/><col/><col class="col-opt-1" style="width:130px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"></th><th>Name</th><th>Driver</th><th class="is-num">Size</th><th>Used by</th><th class="col-opt-1">Created</th><th></th></tr></thead><tbody>
      ${VOLUMES.map((v) => `<tr><td class="col-check"><input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${v.name}"/></td><td class="cell-primary"><span class="cell-name">${ic('hard-drive', 14, 'subtle')}<span class="${v.anon ? 'mono' : ''}">${v.name}</span>${v.anon ? '<span class="subtle" style="font-weight:400">anonymous</span>' : ''}</span></td>
        <td>${v.driver}</td><td class="is-num num">${v.size}</td><td>${v.used.length ? v.used.join(', ') : '<span class="subtle">Unused</span>'}</td><td class="col-opt-1">${v.created}</td>
        <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Browse files" tabindex="-1">${ic('folder-open', 14)}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function ctNetworks() {
    return dockerToolbar('networks', `${NETWORKS.length} networks`, btn({ label: 'New network', icon: 'plus', variant: 'ghost', k: 'n', action: 'toast-demo' })) +
      `<div class="table-wrap"><table class="dtable" role="grid" aria-label="Networks"><colgroup><col style="width:36px"/><col/><col style="width:100px"/><col style="width:150px"/><col style="width:110px"/><col class="col-opt-1" style="width:140px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"></th><th>Name</th><th>Driver</th><th>Subnet</th><th class="is-num">Containers</th><th class="col-opt-1">Options</th><th></th></tr></thead><tbody>
      ${NETWORKS.map((n) => `<tr><td class="col-check">${n.builtin ? '' : `<input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${n.name}"/>`}</td><td class="cell-primary"><span class="cell-name">${ic('network', 14, 'subtle')}<span>${n.name}</span>${n.builtin ? '<span class="subtle" style="font-weight:400">built-in</span>' : ''}</span></td>
        <td>${n.driver}</td><td><span class="mono">${n.subnet}</span></td><td class="is-num num">${n.containers}</td><td class="col-opt-1">${n.attachable ? 'Attachable' : '<span class="subtle">—</span>'}</td>
        <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Connect a container" tabindex="-1">${ic('plug', 14)}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  /* 6.4b Kubernetes — Deployments (rollout, ReplicaSets) & Helm releases */
  function ctDeployments() {
    return `<div class="toolbar" role="toolbar"><label class="input input-filter">${ic('search', 14)}<input placeholder="${t('filter')}" aria-label="Filter Deployments" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">Status: <b>Any</b></button></div><span class="spacer"></span><span class="toolbar-count">${DEPLOYMENTS.length} Deployments</span>
        ${btn({ label: 'Columns', icon: 'columns', variant: 'ghost', iconOnly: true })}${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', iconOnly: true, k: 'shift+R' })}</div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Deployments"><colgroup><col style="width:36px"/><col/><col style="width:80px"/><col style="width:110px"/><col style="width:90px"/><col class="col-opt-2" style="width:30%"/><col style="width:70px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"></th><th>Name</th><th>Ready</th><th>Status</th><th class="is-num">Revision</th><th class="col-opt-2">Image</th><th class="is-num">Age</th><th></th></tr></thead><tbody>
      ${DEPLOYMENTS.map((d) => `<tr data-drow="${d.name}" class="${state.inspector && d.name === 'web' ? 'is-active' : ''}" tabindex="-1"><td class="col-check"><input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${d.name}"/></td>
        <td class="cell-primary"><span class="cell-name">${ic('workload', 14)}<span>${d.name}</span></span></td><td class="num">${d.ready}</td>
        <td>${d.st === 'danger' ? statusHtml('danger', 'Unavailable') : d.st === 'warning' ? statusHtml('warning', 'Degraded') : statusHtml('success', 'Available')}</td>
        <td class="is-num num">${d.rev}</td><td class="col-opt-2"><span class="mono ellipsis" style="font-size:11.5px;display:block">${d.image}</span></td><td class="is-num num">${d.age}</td>
        <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions for ${d.name}" data-action="row-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function inDeploy() {
    const d = DEPLOYMENTS[0], tab = state.inspectorTab.deploy;
    let body = '';
    if (tab === 'overview') {
      body = `<div class="section"><div class="callout callout--warning">${ic('alert', 16)}<div><div class="callout__title">1 of 3 replicas is not ready</div><div class="callout__desc">Pod web-7d9f8c6b5-h8sdl is crash-looping (OOMKilled). The rollout of revision 14 finished; capacity is reduced by 33%.</div><div class="row" style="margin-top:8px">${btn({ label: 'Open Pod', size: 'sm', action: 'go-pod' })}${btn({ label: 'Edit resources…', size: 'sm', action: 'yaml-diff' })}</div></div></div></div>
        <div class="section"><div class="section__head"><span class="section__title">Rollout</span><span class="spacer"></span><span class="subtle" style="font-size:12px">revision 14 · complete</span></div>
          <div class="rollout"><div class="rollout__bar" aria-label="3 desired: 2 ready, 1 failing"><i></i><i></i><i class="bad"></i></div>
          <div class="row subtle" style="font-size:12px;gap:16px"><span>Desired 3</span><span>Updated 3</span><span>Ready 2</span><span>Available 2</span></div></div></div>
        <div class="section"><dl class="props"><dt>Strategy</dt><dd>${d.strategy}</dd><dt>Selector</dt><dd><span class="tag">app=<b>web</b></span></dd><dt>Image</dt><dd><span class="mono ellipsis">${d.image}</span></dd><dt>Min ready</dt><dd>10s</dd><dt>Created</dt><dd>Aug 24, 2026 <span class="subtle">· 41d</span></dd></dl></div>
        <div class="section"><div class="section__head"><span class="section__title">ReplicaSets</span><span class="section__count">3</span></div>
          <div class="rs-row subtle" style="height:24px;font-size:11px"><span>Name</span><span>Rev</span><span>Pods</span><span>Age</span></div>
          ${[['web-7d9f8c6b5', 14, '2/3', '3h', 1], ['web-6c8d7b4f2', 13, '0/0', '6d'], ['web-58f9c6d7b', 12, '0/0', '12d']].map(([n, r, p, a, cur]) => `<div class="rs-row"><span class="mono ellipsis" style="color:var(--text-primary)">${n}${cur ? ' <span class="cur-mark" style="font-family:var(--font-sans)">· current</span>' : ''}</span><span class="num">${r}</span><span class="num">${p}</span><span class="num subtle">${a}</span></div>`).join('')}</div>`;
    } else if (tab !== 'history') {
      body = `<div class="empty"><div class="empty__title">${tab === 'yaml' ? 'YAML editor' : 'Events'}</div><div class="empty__desc">Same pattern as Pods › ${tab === 'yaml' ? 'YAML (edit → review diff → apply)' : 'Events (live, warnings first)'}.</div>${tab === 'yaml' ? `<div class="empty__actions">${btn({ label: 'Edit and review diff…', size: 'sm', action: 'yaml-diff' })}</div>` : ''}</div>`;
    } else {
      body = `<div class="section">${[[14, 'image web:2.14.1 · memory limit 256Mi', '3h ago · hieu', 1], [13, 'image web:2.14.0', '6d ago · ci-bot'], [12, 'env FEATURE_SEARCH_V2=true', '12d ago · ci-bot'], [11, 'image web:2.13.2', '19d ago · ci-bot']].map(([n, c, w, cur]) => `<div class="rev"><span class="rev__n">#${n}</span><div class="rev__main"><div class="rev__title">${c}</div><div class="rev__sub">${w}${cur ? ' · current' : ''}</div></div>${cur ? '' : btn({ label: 'Roll back…', variant: 'ghost', size: 'sm', action: 'rollback-dialog' })}</div>`).join('')}</div>`;
    }
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('workload', 16)}</span>`, name: 'web',
      meta: '<span>Deployment</span><span class="sep">·</span><span>shop</span><span class="sep">·</span><span>41d</span>',
      badge: chipHtml('warning', 'Degraded · 2/3 ready'),
      actions: btn({ label: 'Scale…', icon: 'scale', size: 'sm', action: 'toast-demo' }) + btn({ label: 'Restart', icon: 'restart', size: 'sm', k: 'shift+R', tipText: 'Rollout restart', action: 'toast-demo' }) + btn({ label: 'Edit YAML', icon: 'code', size: 'sm', iconOnly: true, k: 'E', action: 'yaml-diff' }) + btn({ label: 'Logs (all Pods)', icon: 'logs', size: 'sm', iconOnly: true, k: 'L' }) + '<span class="spacer"></span>' + btn({ label: 'Delete Deployment', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'delete-web' })
    }) + subTabs('deploy', [['overview', t('overview')], ['history', 'History', '14'], ['events', t('events')], ['yaml', 'YAML']]) + `<div class="inspector__body">${body}</div>`;
  }
  function ctHelm() {
    return `<div class="toolbar" role="toolbar"><label class="input input-filter">${ic('search', 14)}<input placeholder="${t('filter')}" aria-label="Filter releases" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">Namespace: <b>All</b></button></div><span class="spacer"></span><span class="toolbar-count">${HELM.length} releases</span>${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', iconOnly: true })}</div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Helm releases"><colgroup><col style="width:36px"/><col/><col style="width:130px"/><col class="col-opt-2" style="width:26%"/><col style="width:70px"/><col style="width:140px"/><col class="col-opt-1" style="width:120px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"></th><th>Release</th><th>Namespace</th><th class="col-opt-2">Chart</th><th class="is-num">Rev</th><th>Status</th><th class="col-opt-1">Updated</th><th></th></tr></thead><tbody>
      ${HELM.map((h) => `<tr data-hrow="${h.name}" class="${state.inspector && state.helmActive === h.name ? 'is-active' : ''}" tabindex="-1"><td class="col-check"><input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${h.name}"/></td>
        <td class="cell-primary"><span class="cell-name">${ic('helm', 14, 'subtle')}<span>${h.name}</span></span></td><td>${h.ns}</td><td class="col-opt-2"><span class="mono ellipsis" style="font-size:11.5px;display:block">${h.chart}</span></td><td class="is-num num">${h.rev}</td>
        <td>${h.st === 'failed' ? statusHtml('danger', 'Failed') : h.st === 'pending-upgrade' ? statusHtml('warning', 'Upgrading…') : statusHtml('success', 'Deployed')}</td><td class="col-opt-1">${h.updated}</td>
        <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions for ${h.name}" data-action="helm-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function inHelm() {
    const h = HELM.find((x) => x.name === state.helmActive) || HELM[0];
    const tab = state.inspectorTab.helm;
    const bump = (c, i) => c.replace(/(\d+)\.(\d+)\.(\d+)$/, (_, a, b, cc) => i === 1 ? `${a}.${b}.${Math.max(0, cc - 1)}` : `${a}.${Math.max(0, b - 1)}.${+cc + 2}`);
    const revs = [[h.rev, h.chart, h.app, h.updated, h.st], [h.rev - 1, bump(h.chart, 1), h.app, '2 weeks ago', 'superseded'], [h.rev - 2, bump(h.chart, 2), h.app, '1 month ago', 'superseded']];
    const body = tab === 'revisions'
      ? `<div class="section">${h.note ? `<div class="callout callout--danger" role="alert" style="margin-bottom:12px">${ic('alert-circle', 16)}<div><div class="callout__title">Upgrade to revision ${h.rev} failed</div><div class="callout__desc">${esc(h.note)}</div></div></div>` : ''}
          ${revs.map(([n, c, a, w, st], i) => `<div class="rev"><span class="rev__n">#${n}</span><div class="rev__main"><div class="rev__title"><span class="mono" style="font-size:12px">${c}</span></div><div class="rev__sub">${i === 0 && st === 'failed' ? '<span style="color:var(--danger)">failed</span> · ' : ''}app ${a} · ${w}${i === 0 ? ' · current' : ''}</div></div>${i ? btn({ label: 'Roll back…', variant: 'ghost', size: 'sm', action: 'rollback-dialog', data: ` data-rev="${n}"` }) : btn({ label: 'Diff', icon: 'diff', variant: 'ghost', size: 'sm', action: 'rollback-dialog', data: ` data-rev="${n - 1}"` })}</div>`).join('')}</div>`
      : tab === 'values'
        ? `<pre class="yaml"><span class="k">replicaCount</span>: <span class="n">3</span>\n<span class="k">image</span>:\n  <span class="k">repository</span>: <span class="s">registry.shop.vn/web</span>\n  <span class="k">tag</span>: <span class="s">"2.14.1"</span>\n<span class="k">resources</span>:\n  <span class="k">limits</span>:\n    <span class="k">memory</span>: <span class="s">256Mi</span>\n<span class="k">ingress</span>:\n  <span class="k">enabled</span>: <span class="n">true</span>\n  <span class="k">host</span>: <span class="s">shop.vn</span>\n<span class="k">migrations</span>:\n  <span class="k">enabled</span>: <span class="n">true</span>   <span class="c"># post-upgrade hook</span></pre>`
        : `<div class="section">${[['Deployment', 'web', '2/3'], ['Deployment', 'catalog', '2/2'], ['Service', 'web', ''], ['Ingress', 'shop.vn', ''], ['Job', 'db-migrate', 'Failed'], ['ConfigMap', 'shop-config', '']].map(([k, n, m]) => `<div class="kv-line"><span class="subtle" style="margin:0;width:96px;font-size:12px">${k}</span><span>${n}</span><span class="subtle"${m === 'Failed' ? ' style="color:var(--danger)"' : ''}>${m}</span></div>`).join('')}</div>`;
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('helm', 16)}</span>`, name: h.name,
      meta: `<span>Helm release</span><span class="sep">·</span><span>${h.ns}</span><span class="sep">·</span><span>rev ${h.rev}</span>`,
      actions: btn({ label: 'Roll back…', icon: 'history', size: 'sm', action: 'rollback-dialog', data: ` data-rev="${h.rev - 1}"` }) + btn({ label: 'Upgrade…', size: 'sm', action: 'toast-demo' }) + btn({ label: 'Values', icon: 'code', size: 'sm', iconOnly: true }) + '<span class="spacer"></span>' + btn({ label: 'Uninstall release', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'helm-uninstall' })
    }) + subTabs('helm', [['revisions', 'Revisions', String(h.rev)], ['values', 'Values'], ['resources', 'Resources', '6']]) + `<div class="inspector__body">${body}</div>`;
  }

  /* 6.6 S3 */
  const OBJ_ICON = { image: 'image', code: 'file-code', text: 'file-text', film: 'film' };
  function s3Crumbs(extra) {
    return crumbs([{ icon: 'bucket', label: 'Storage', href: '#/s3' }, { iconHtml: ic('aws', 14), label: 'aws-media', switch: 'menu-s3acct', tip: 'Switch account' }, ...extra]);
  }
  function ctBuckets() {
    return `<div class="toolbar"><label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="${t('filter')}" aria-label="Filter buckets" data-role="table-filter"/>${kbd('/')}</label><span class="spacer"></span><span class="toolbar-count">${BUCKETS.length} buckets</span>${btn({ label: 'Create bucket', icon: 'plus', variant: 'primary', k: 'n', tipText: 'Create bucket' })}</div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Buckets"><colgroup><col style="width:36px"/><col/><col style="width:150px"/><col style="width:110px"/><col style="width:110px"/><col style="width:110px"/><col style="width:130px"/><col class="col-opt-1" style="width:120px"/><col style="width:40px"/></colgroup>
      <thead><tr><th class="col-check"></th><th>Name</th><th>Region</th><th class="is-num">Objects</th><th class="is-num">Size</th><th>Versioning</th><th>Access</th><th class="col-opt-1">Created</th><th></th></tr></thead><tbody>
      ${BUCKETS.map((b) => `<tr data-href="${b.name === 'shop-media-assets' ? '#/s3/objects' : ''}"><td class="col-check"><input type="checkbox" class="checkbox" aria-label="Select ${b.name}" tabindex="-1"/></td><td class="cell-primary"><span class="cell-name">${ic('bucket', 14)}<span>${b.name}</span></span></td><td>${b.region}</td><td class="is-num num">${b.objects}</td><td class="is-num num">${b.size}</td><td>${b.versioning ? 'Enabled' : '<span class="subtle">Off</span>'}</td><td>${b.access === 'private' ? 'Private' : `<span class="badge badge--warning">Public read</span>`}</td><td class="col-opt-1 num">${b.created}</td><td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions" data-action="row-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function ctObjects() {
    const up = state.transfers.find((x) => x.name === 'hero-autumn@2x.jpg');
    return `<div class="toolbar" role="toolbar" aria-label="Objects toolbar">
        <label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="Filter by prefix…" aria-label="Filter by prefix" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">Class: <b>Any</b></button></div>
        <span class="spacer"></span>
        <span class="toolbar-count">11 items</span>
        ${btn({ label: 'Sync…', icon: 'sync', variant: 'ghost', tipText: 'Sync / mirror a local folder with preview', action: 'sync-dialog' })}
        ${btn({ label: 'Bucket: stats, lifecycle, CORS, policy', icon: 'settings', variant: 'ghost', iconOnly: true, action: 'bucket-menu' })}
        ${btn({ label: 'New folder', icon: 'folderplus', variant: 'ghost', iconOnly: true, k: 'shift+N' })}
        ${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', iconOnly: true, k: 'shift+R' })}
        ${btn({ label: 'Upload', icon: 'upload', variant: 'primary', k: 'U', tipText: 'Upload files', action: 'upload' })}
      </div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Objects in images/2026/">
        <colgroup><col style="width:36px"/><col/><col style="width:110px"/><col style="width:170px"/><col class="col-opt-1" style="width:130px"/><col style="width:40px"/></colgroup>
        <thead><tr><th class="col-check"><input type="checkbox" class="checkbox" aria-label="Select all" tabindex="-1"/></th><th aria-sort="ascending" class="is-sortable"><span class="th-inner">Name${ic('arrow-up', 12, 'sort-ic')}</span></th><th class="is-num">Size</th><th>Last modified</th><th class="col-opt-1">Storage class</th><th></th></tr></thead>
        <tbody>
          <tr data-href="#/s3"><td class="col-check"></td><td class="cell-primary" colspan="5"><span class="cell-name">${ic('corner-down-left', 14, 'subtle')}<span class="subtle" style="font-weight:400">..</span></span></td></tr>
          ${OBJECTS.map((o) => `<tr data-orow="${o.name}" class="${state.inspector && state.objActive === o.name ? 'is-active' : ''}" tabindex="-1">
            <td class="col-check">${o.folder ? '' : `<input type="checkbox" class="checkbox" aria-label="Select ${o.name}" tabindex="-1"/>`}</td>
            <td class="cell-primary"><span class="cell-name">${o.folder ? ic('folder', 14, 'is-folder') : ic(OBJ_ICON[o.type] || 'file', 14)}<span>${o.name}</span>${o.uploading && up ? `<span class="row" style="gap:6px;margin-left:auto;flex:none"><span class="progress" style="width:72px"><span class="progress__bar" style="width:${up.pct}%;display:block"></span></span><span class="subtle num" style="font-size:12px;font-weight:400">${up.pct}%</span></span>` : ''}</span></td>
            <td class="is-num num">${o.folder ? `<span class="subtle">${o.count}</span>` : o.size}</td>
            <td class="num">${o.uploading ? '<span class="subtle">Uploading…</span>' : o.modified === '—' ? '<span class="subtle">—</span>' : o.modified}</td>
            <td class="col-opt-1">${o.cls ? `<span class="mono subtle" style="font-size:11px">${o.cls}</span>` : ''}</td>
            <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions for ${o.name}" data-action="row-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`).join('')}
        </tbody></table></div>`;
  }
  function inObject() {
    const o = OBJECTS.find((x) => x.name === state.objActive) || OBJECTS[3];
    const tab = state.inspectorTab.object;
    let body = '';
    if (tab === 'overview') {
      body = `<div class="section"><div class="object-preview" role="img" aria-label="Preview of ${o.name}"><span class="sun"></span><span class="m1"></span><span class="m2"></span><span class="meta">2400 × 1200 · JPEG</span></div></div>
        <div class="section"><dl class="props">
          <dt>Key</dt><dd><span class="mono ellipsis">images/2026/${o.name}</span><button class="btn btn--ghost btn--sm btn--icon copy-btn" aria-label="Copy key" data-action="copy">${ic('copy', 12)}</button></dd>
          <dt>Size</dt><dd>${o.size} <span class="subtle">(2,516,582 bytes)</span></dd>
          <dt>Content-Type</dt><dd><span class="mono">image/jpeg</span></dd>
          <dt>Storage class</dt><dd><span class="tag">${o.cls || 'STANDARD'}</span></dd>
          <dt>Last modified</dt><dd>${o.modified}</dd>
          <dt>ETag</dt><dd><span class="mono ellipsis">"9b2cf535f27731c974343645a3985328"</span></dd>
          <dt>Encryption</dt><dd>${ic('lock', 12, 'subtle')}SSE-S3 (AES-256)</dd>
          <dt>Cache-Control</dt><dd><span class="mono">public, max-age=31536000</span></dd>
        </dl></div>
        <div class="section"><div class="section__head"><span class="section__title">Tags</span><span class="section__count">3</span></div>
          <div class="row" style="flex-wrap:wrap;gap:6px"><span class="tag">campaign=<b>autumn-2026</b></span><span class="tag">owner=<b>marketing</b></span><span class="tag">cdn=<b>true</b></span><button type="button" class="chip chip--add" style="height:20px">${ic('plus', 12)}Add tag</button></div></div>
        <div class="section"><div class="section__head"><span class="section__title">Versions</span><span class="section__count">3</span></div>
          ${[['Current', 'Oct 3, 16:42', '2.4 MB', 'hartono'], ['3HL4kqtJ…', 'Sep 29, 10:05', '2.6 MB', 'hieu'], ['Ty9wPz0a…', 'Sep 20, 08:31', '2.9 MB', 'ci-bot']].map(([v, d, s, u], i) => `<div class="version-row">${i === 0 ? '<span class="cur-mark">Current</span>' : `<span class="mono subtle" style="font-size:11.5px">${v}</span>`}<span class="muted">${d}</span><span class="subtle">· ${u}</span><span class="spacer"></span><span class="num subtle">${s}</span>${i ? btn({ label: 'Restore this version', icon: 'history', variant: 'ghost', size: 'sm', iconOnly: true }) : ''}</div>`).join('')}</div>
        <div class="section"><div class="section__head"><span class="section__title">Share link</span></div>
          <div class="share-box" style="padding:0">
            <div class="row"><span class="muted" style="font-size:12px">Expires in</span><span class="spacer"></span>
              <div class="segmented" role="radiogroup" aria-label="Expiry" style="--ctl-h:24px">${['1h', '24h', '7d'].map((x) => `<button type="button" class="segmented__item" role="radio" aria-checked="${x === '24h'}" data-action="seg">${x}</button>`).join('')}</div></div>
            <div class="input" style="background:var(--surface-0)">${ic('link', 14)}<input type="text" readonly value="https://shop-media-assets.s3.ap-southeast-1.amazonaws.com/images/2026/hero-autumn.jpg?X-Amz-Expires=86400&X-Amz-Signature=8f2c…" aria-label="Presigned URL"/>${btn({ label: 'Copy', size: 'sm', action: 'copy-link' })}</div>
            <div class="subtle" style="font-size:12px">Anyone with the link can download until Oct 5, 14:06 (+07).</div>
          </div></div>`;
    } else if (tab === 'meta') {
      body = `<div class="section"><dl class="props">${[['x-amz-meta-author', 'marketing-team'], ['x-amz-meta-source', 'figma-export'], ['x-amz-version-id', '3HL4kqtJlcpXroDTDmJ'], ['x-amz-server-side-encryption', 'AES256']].map(([k, v]) => `<dt class="mono" style="font-size:11.5px">${k}</dt><dd><span class="mono ellipsis">${v}</span></dd>`).join('')}</dl></div>`;
    } else {
      body = `<div class="empty"><div class="empty__art">${ic('shield', 20)}</div><div class="empty__title">Inherits bucket policy</div><div class="empty__desc">This object has no ACL overrides. Bucket <b>shop-media-assets</b> allows public read.</div></div>`;
    }
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('image', 16)}</span>`,
      name: o.name,
      meta: `<span>Object</span><span class="sep">·</span><span>shop-media-assets</span><span class="sep">·</span><span>${o.size}</span>`,
      actions: btn({ label: 'Download', icon: 'download', size: 'sm', k: 'D', tipText: 'Download' }) + btn({ label: 'Share', icon: 'link', size: 'sm', tipText: 'Create presigned URL' }) + btn({ label: 'Open', icon: 'external', size: 'sm', iconOnly: true, k: 'enter' }) + btn({ label: 'Copy S3 URI', icon: 'copy', size: 'sm', iconOnly: true, k: 'C' }) + '<span class="spacer"></span>' + btn({ label: 'Delete object', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'delete-object' })
    }) + subTabs('object', [['overview', t('overview')], ['meta', 'Metadata', '4'], ['perm', 'Permissions']]) + `<div class="inspector__body">${body}</div>`;
  }

  /* 6.7 Settings — Accounts / Appearance */
  const AUTH_BADGE = { key: ['key', 'Key', ''], password: ['lock', 'Password', ''], passphrase: ['shield', 'Passphrase', ''] };
  function ctAccounts() {
    return `<div class="page" style="display:flex;flex-direction:column"><div style="padding:24px 24px 16px;flex:none">
        <div class="row" style="align-items:flex-end;gap:16px"><div style="flex:1;min-width:0"><h1 class="page__title">Accounts</h1>
        <p class="page__desc">Shared credentials reused across hosts. Rotate once — every host using the account picks it up.</p></div>
        ${btn({ label: 'Import from keychain', icon: 'import' })}${btn({ label: 'New account', icon: 'plus', variant: 'primary', k: 'n', tipText: 'New account', action: 'toast-demo' })}</div></div>
      <div class="toolbar" style="border-top:1px solid var(--border-subtle)"><label class="input input-filter">${ic('search', 14)}<input type="text" placeholder="${t('filter')}" aria-label="Filter accounts" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">Auth: <b>Any</b></button><button type="button" class="chip">Unused</button></div><span class="spacer"></span><span class="toolbar-count">${ACCOUNTS.length} accounts · vault ${ic('unlock', 12).replace('class="ic', 'style="display:inline;vertical-align:-2px" class="ic')}</span></div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Accounts">
        <colgroup><col style="width:36px"/><col/><col style="width:116px"/><col style="width:184px"/><col style="width:150px"/><col class="col-opt-1" style="width:110px"/><col style="width:40px"/></colgroup>
        <thead><tr><th class="col-check"></th><th>Name</th><th>Username</th><th>Authentication</th><th>Used by</th><th class="col-opt-1">Last used</th><th></th></tr></thead><tbody>
        ${ACCOUNTS.map((a) => `<tr data-arow="${a.id}" class="${state.inspector && state.accountActive === a.id ? 'is-active' : ''}" tabindex="-1">
          <td class="col-check"><input type="checkbox" class="checkbox" aria-label="Select ${a.id}" tabindex="-1"/></td>
          <td class="cell-primary"><span class="cell-name">${ic('user', 14, 'subtle')}<span>${a.id}</span>${a.warn ? `<span class="badge badge--warning" style="height:18px"${tip(a.warn)}>Rotate</span>` : ''}</span></td>
          <td><span class="mono">${a.user}</span></td>
          <td>${a.auth.map((x) => AUTH_BADGE[x][1]).join(' + ')}${a.keyType ? ` <span class="subtle">· ${a.keyType}</span>` : ''}</td>
          <td>${a.hosts.length ? `<span class="row" style="gap:8px"><span class="os-stack">${a.hosts.slice(0, 4).map((h) => ic(hostById(h).os, 16)).join('')}</span><span>${a.hosts.length} host${a.hosts.length > 1 ? 's' : ''}</span></span>` : '<span class="subtle">Not used</span>'}</td>
          <td class="col-opt-1">${a.last}</td>
          <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Actions for ${a.id}" data-action="row-menu" tabindex="-1">${ic('more', 14)}</button></td></tr>`).join('')}
        </tbody></table></div></div>`;
  }
  function inAccount() {
    const a = ACCOUNTS.find((x) => x.id === state.accountActive) || ACCOUNTS[0];
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('user', 16)}</span>`,
      name: a.id, meta: `<span>Account</span><span class="sep">·</span><span>${a.desc}</span>`,
      actions: btn({ label: 'Edit', icon: 'sliders', size: 'sm', k: 'E', tipText: 'Edit account' }) + btn({ label: 'Rotate key…', icon: 'restart', size: 'sm' }) + btn({ label: 'Test on all hosts', icon: 'plug', size: 'sm', iconOnly: true }) + '<span class="spacer"></span>' + btn({ label: 'Delete account', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'delete-account' })
    }) + subTabs('account', [['overview', t('overview')], ['hosts', 'Hosts', String(a.hosts.length)], ['audit', 'Audit']]) + `<div class="inspector__body">
      <div class="section"><dl class="props">
        <dt>Username</dt><dd><span class="mono">${a.user}</span></dd>
        <dt>Authentication</dt><dd>${a.auth.map((x) => AUTH_BADGE[x][1]).join(' + ')}</dd>
        ${a.keyType ? `<dt>Key type</dt><dd>${a.keyType}</dd><dt>Fingerprint</dt><dd><span class="mono ellipsis">${a.fp}</span><button class="btn btn--ghost btn--sm btn--icon copy-btn" aria-label="Copy fingerprint" data-action="copy">${ic('copy', 12)}</button></dd>` : ''}
        <dt>Stored in</dt><dd>${ic('shield', 12, 'subtle')}Vault (AES-256-GCM)</dd>
        <dt>Updated</dt><dd>${a.updated}</dd>
      </dl></div>
      <div class="section"><div class="section__head"><span class="section__title">Used by</span><span class="section__count">${a.hosts.length} hosts</span></div>
        ${a.hosts.map((h) => { const x = hostById(h); return `<a class="list-row" href="#/hosts" style="height:36px;padding:0 4px">${ic(x.os, 16)}<span class="list-row__main"><span class="list-row__title"><span>${x.id}</span>${envDot(x.env)}</span></span><span class="list-row__meta mono">${x.addr}</span></a>`; }).join('') || '<div class="subtle">No hosts use this account yet.</div>'}
      </div>
      <div class="section"><div class="callout callout--info">${ic('info', 14)}<div class="callout__desc" style="margin:0">A host can still override username or key; the override is shown in the host editor.</div></div></div>
    </div>`;
  }
  /* 6.7b Settings — mọi mục. Khung chung: tiêu đề + mô tả + nhóm hàng cài đặt (không card). */
  const seg = (name, cur, opts, action = 'set-pref') => `<div class="segmented" role="radiogroup" aria-label="${name}">${opts.map(([v, l, i]) => `<button type="button" class="segmented__item" role="radio" aria-checked="${cur === v}" data-action="${action}" data-pref="${name}" data-val="${v}">${i ? ic(i, 14) : ''}${l}</button>`).join('')}</div>`;
  const sw = (label, on) => `<button type="button" class="switch" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-action="switch"></button>`;
  const sel = (v, w) => `<button type="button" class="btn select"${w ? ` style="min-width:${w}px"` : ''}>${v}${ic('chevron-down', 14)}</button>`;
  const srow = (title, desc, control) => `<div class="setting-row"><div class="setting-row__text"><div class="setting-row__title">${title}</div>${desc ? `<div class="setting-row__desc">${desc}</div>` : ''}</div>${control}</div>`;
  const sgroup = (title, rows) => `<div class="settings-group"><div class="settings-group__title">${title}</div>${rows.join('')}</div>`;
  const spage = (title, desc, body, width = 760) => `<div class="page"><div class="page__inner" style="max-width:${width}px"><h1 class="page__title">${title}</h1><p class="page__desc">${desc}</p>${body}</div></div>`;

  function ctSettings(id) {
    switch (id) {
      case 'appearance': return spage('Appearance', 'Theme, density and language apply instantly and sync across windows.',
        sgroup('Look', [
          srow('Theme', 'Dark is the default. System follows your OS.', seg('theme', state.theme, [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System']])),
          srow('Density', 'Comfortable (default): 32px rows, 28px controls. Compact: 28px rows, 24px controls.', seg('density', state.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
          srow('Language', 'Technical terms (Pod, Bucket, Container…) stay in English.', seg('lang', state.lang, [['en', 'English'], ['vi', 'Tiếng Việt']]))]) +
        sgroup('Environments', [
          srow('Production indicator', 'A thin red line at the top of the window and a “PROD” label in the header. Set per group, cluster, endpoint or S3 account.', sw('Production indicator', true)),
          srow('Type the name to confirm', 'Only for destructive actions on production. Staging and development use a normal confirm.', sel('Production only'))]) +
        sgroup('Motion', [srow('Reduce motion', 'Follows the OS setting by default.', sw('Reduce motion', false))]));
      case 'terminal': return spage('Terminal', 'Font, colors and behavior for SSH, Telnet, serial and local terminals.',
        `<div class="term-preview" style="margin-top:24px"><div class="terminal"><span class="t-green">deploy@prod-web-01</span>:<span class="t-blue">/srv/shop</span>$ ls
compose.yaml  config  <span class="t-green">deploy.sh</span>  logs  releases
<span class="t-green">deploy@prod-web-01</span>:<span class="t-blue">/srv/shop</span>$ <span class="t-cursor"></span></div></div>` +
        sgroup('Text', [
          srow('Font family', 'Monospace fonts installed on this computer.', sel('Default (JetBrains Mono)', 220)),
          srow('Font size', 'Ctrl + = / Ctrl + − changes it per tab.', `<span class="input" style="width:88px"><input value="13" aria-label="Font size"/><span class="subtle">px</span></span>`),
          srow('Line height', '', `<span class="input" style="width:88px"><input value="1.5" aria-label="Line height"/></span>`),
          srow('Cursor style', '', seg('cursor', 'block', [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']], 'seg')),
          srow('Blinking cursor', '', sw('Blinking cursor', true))]) +
        sgroup('Colors', [
          srow('Color theme', 'Match app (light / dark) or pick one theme for each mode.', `<div class="theme-swatches">${[['Match app', '#0a0b0c', true], ['Solarized', '#002b36'], ['Dracula', '#282a36'], ['GitHub Light', '#ffffff']].map(([n, c, on]) => `<button type="button" class="theme-sw" role="radio" aria-checked="${!!on}" data-action="seg"><i style="background:${c}"></i><span>${n}</span></button>`).join('')}</div>`),
          srow('Import theme…', 'Windows Terminal (.json) or iTerm2 (.itermcolors).', btn({ label: 'Import…', icon: 'import', size: 'sm' }))]) +
        sgroup('Behavior', [
          srow('Shell for new terminals', 'Local terminals only.', sel('PowerShell 7', 180)),
          srow('Scrollback lines', '', `<span class="input" style="width:110px"><input value="10000" aria-label="Scrollback lines"/></span>`),
          srow('Copy on select', '', sw('Copy on select', false)),
          srow('Right-click in the terminal', 'Show menu, or copy / paste (PuTTY style).', seg('rclick', 'menu', [['menu', 'Show menu'], ['putty', 'Copy / paste']], 'seg')),
          srow('Warn before pasting multiple lines', '', sw('Warn before pasting multiple lines', true)),
          srow('Confirm before closing connected tabs', '', sw('Confirm before closing connected tabs', true)),
          srow('Suggest commands from history', 'Per host. Press → to accept a suggestion.', sw('Suggest commands from history', true) ),
          srow('Show server statistics', 'CPU, memory, disk and load under the session header.', sw('Show server statistics', true)),
          srow('Screen reader mode', '', sw('Screen reader mode', false)),
          srow('Command history', 'Stored per host in the vault.', btn({ label: 'Clear history…', variant: 'ghost', size: 'sm', cls: 'is-danger', action: 'toast-demo' }))]));
      case 'shortcuts': {
        const SC = [['Tabs', [['New terminal', 'mod+shift+T'], ['Close tab', 'mod+shift+W'], ['Next tab', 'ctrl+Tab'], ['Previous tab', 'ctrl+shift+Tab'], ['Reconnect tab', 'mod+shift+R'], ['Reopen closed tab', 'mod+alt+T'], ['Duplicate tab', '']]],
          ['Panes', [['Split right', 'mod+shift+D'], ['Split down', 'mod+shift+E'], ['MultiExec: type into all terminals', 'mod+shift+M']]],
          ['Navigation', [['Command palette', 'mod+K'], ['Search hosts', 'mod+shift+K', 'conflict'], ['Open snippets', 'mod+shift+S'], ['Open settings', 'mod+,'], ['Show / hide sidebar', 'mod+shift+B'], ['Quick connect', '']]],
          ['Terminal', [['Find in terminal', 'mod+shift+F'], ['Bigger text', 'mod+='], ['Smaller text', 'mod+-'], ['Default text size', 'mod+0']]],
          ['App', [['Lock vault', 'mod+shift+L'], ['Workspaces: save or open a layout', ''], ['Toggle diagnostics', '']]]];
        return spage('Keyboard shortcuts', 'Click a shortcut, then press the new key combination. Esc cancels. Terminal keys (Ctrl+C, Ctrl+D…) are never taken.',
          `<div class="row" style="margin-top:20px"><label class="input input-filter" style="width:280px">${ic('search', 14)}<input placeholder="Search commands or keys…" aria-label="Search shortcuts"/></label><span class="spacer"></span>${btn({ label: 'Reset all to default', icon: 'rotate-ccw', variant: 'ghost', size: 'sm' })}</div>` +
          SC.map(([g, list]) => `<div class="settings-group" style="margin-top:24px"><div class="sc-head"><span>${g}</span><span>Shortcut</span><span>Alternative</span></div>${list.map(([n, k, flag]) => `<div class="sc-row${flag ? ' is-conflict' : ''}"><span>${n}${flag ? ` <span class="badge badge--warning" style="height:18px;margin-left:6px"${tip('Also used by “Search resources” in Kubernetes')}>Also used by 1</span>` : ''}</span><button type="button" class="kbd-slot${n === 'Split down' ? ' is-recording' : ''}" aria-label="Change shortcut for ${n}">${n === 'Split down' ? '<span>Press keys…</span>' : k ? kbd(k) : '<span>Not set</span>'}</button><button type="button" class="kbd-slot" aria-label="Add alternative for ${n}">${n === 'Command palette' ? kbd('mod+shift+P') : '<span>—</span>'}</button></div>`).join('')}</div>`).join(''), 820);
      }
      case 'security': return spage('Security & vault', 'Passwords, keys and tokens are encrypted on this computer (AES-256-GCM). Shellhouse sends no telemetry.',
        sgroup('Vault', [
          srow('Status', 'Unlocked since 09:12 · 5 accounts, 4 keys, 3 registry logins.', btn({ label: 'Lock now', icon: 'lock', size: 'sm', k: 'mod+shift+L', tipText: 'Lock vault' })),
          srow('Master password', 'Last changed Aug 14, 2026.', btn({ label: 'Change password…', size: 'sm', action: 'toast-demo' })),
          srow('Remember on this device', 'The vault key is kept in the operating system keychain — open Shellhouse without the master password.', sw('Remember on this device', false))]) +
        sgroup('Auto-lock', [
          srow('Lock after the computer is idle for', '', sel('15 minutes', 140)),
          srow('Lock when the computer sleeps or the screen locks', '', sw('Lock on sleep', true))]) +
        sgroup('Backup', [
          srow('Encrypted backup', 'One encrypted file with hosts, groups, accounts, keys, snippets and settings. Protected by its own password.', btn({ label: 'Export backup…', icon: 'download', size: 'sm', action: 'toast-demo' })),
          srow('Restore', 'Replaces the current vault after you confirm. You need the master password of the backup.', btn({ label: 'Restore…', icon: 'upload', size: 'sm', variant: 'ghost', action: 'toast-demo' }))]) +
        sgroup('Connections', [
          srow('Host key checking', 'Ask when a server is new; block when its key changed.', sel('Ask · block on change', 200)),
          srow('Audit log', 'Records reveals of secrets and destructive actions on production.', btn({ label: 'Open audit log', variant: 'ghost', size: 'sm' }))]));
      case 'general': return spage('General', 'Startup and behavior of the app window.',
        sgroup('Startup', [srow('Open on startup', '', sel('Home', 160)), srow('Restore tabs from last session', 'Reconnects SSH sessions; RDP sessions reopen disconnected.', sw('Restore tabs', true)), srow('Start with the system', '', sw('Start with the system', false))]) +
        sgroup('Window', [srow('Title bar', 'Frameless (Shellhouse draws the title bar) or the system title bar.', seg('titlebar', 'frameless', [['frameless', 'Frameless'], ['system', 'System']], 'seg')), srow('Close button', '', sel('Quit the app', 160)), srow('Tray icon', 'Keep forwards and transfers running when the window is closed.', sw('Tray icon', true))]) +
        sgroup('Hosts', [srow('Double-click a host', '', sel('Connect in a new tab', 200)), srow('Default sort', 'Problems first, then by name.', sel('Problems first', 160))]));
      case 'files': return spage('Files & transfers', 'SFTP, local files, the in-app editor and session logs.',
        sgroup('Remote files', [srow('Double-click a file in SFTP', '', sel('Open in editor', 160)), srow('Edit text files in Shellhouse', 'CodeMirror editor with syntax highlighting; saving uploads to the server.', sw('In-app editor', true)), srow('External editor', '', sel('System default', 160))]) +
        sgroup('Transfers & performance', [srow('SFTP files at once', '', sel('4 (default)', 120)), srow('SFTP parallel requests', 'Each file is also sent in pipelined chunks.', sel('64 (default)', 120)), srow('Resume interrupted transfers', 'Keep partial files so a transfer can resume from where it stopped.', sw('Resume', true))]) +
        sgroup('Session logs', [srow('Record sessions', 'Save everything a session prints to a text file, one folder per host.', sel('SSH sessions', 160)), srow('Folder', '<span class="mono">~/Shellhouse/logs</span>', btn({ label: 'Choose…', size: 'sm' })), srow('Plain text', 'Remove colors and terminal control codes.', sw('Plain text', true))]));
      case 'keys': return spage('SSH keys', 'Private keys are stored encrypted in the vault. Deploy a key to append it to a server’s authorized_keys.',
        `<div class="row" style="margin-top:20px">${btn({ label: 'Generate key', icon: 'plus', variant: 'primary', action: 'toast-demo' })}${btn({ label: 'Import from file…', icon: 'import' })}</div>
        <div class="settings-group"><table class="dtable" aria-label="SSH keys"><colgroup><col/><col style="width:110px"/><col style="width:80px"/><col style="width:160px"/><col style="width:120px"/><col style="width:120px"/></colgroup>
        <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Used by accounts</th><th>Created</th><th></th></tr></thead><tbody>
        ${SSH_KEYS.map(([n, ty, sz, used, d, pp]) => `<tr><td class="cell-primary"><span class="cell-name">${ic('key', 14, 'subtle')}<span>${n}</span>${pp ? '<span class="subtle" style="font-weight:400">· passphrase</span>' : ''}</span></td><td>${ty}</td><td class="num">${sz}</td><td>${used === '—' ? '<span class="subtle">Not used</span>' : used}</td><td class="num">${d}</td><td style="text-align:right">${btn({ label: 'Copy public key', icon: 'copy', variant: 'ghost', size: 'sm', iconOnly: true, action: 'copy' })}${btn({ label: 'Deploy key to a server…', icon: 'upload', variant: 'ghost', size: 'sm', iconOnly: true, action: 'toast-demo' })}${btn({ label: 'More', icon: 'more', variant: 'ghost', size: 'sm', iconOnly: true })}</td></tr>`).join('')}
        </tbody></table></div>`, 900);
      case 'known-hosts': return spage('Known hosts', 'Server fingerprints you trusted. A changed key blocks the connection until you review it.',
        `<div class="callout callout--warning" role="alert" style="margin-top:20px">${ic('alert', 16)}<div><div class="callout__title">stg-db-01 presented a different host key</div><div class="callout__desc">RSA 3072 · SHA256:4hJx…Lr2s (was ED25519 · SHA256:9bQe…Mm1c). If the server was reinstalled, accept the new key; otherwise someone may be intercepting the connection.</div><div class="row" style="margin-top:8px">${btn({ label: 'Accept new key', size: 'sm', action: 'toast-demo' })}${btn({ label: 'Keep blocking', size: 'sm', variant: 'ghost' })}</div></div></div>
        <div class="settings-group"><table class="dtable" aria-label="Known hosts"><colgroup><col/><col style="width:110px"/><col style="width:200px"/><col style="width:130px"/><col style="width:48px"/></colgroup>
        <thead><tr><th>Host</th><th>Key type</th><th>Fingerprint</th><th>First seen</th><th></th></tr></thead><tbody>
        ${KNOWN_HOSTS.map(([h, ty, fp, d, ch]) => `<tr><td class="cell-primary"><span class="cell-name"><span class="mono">${h}</span>${ch ? '<span class="badge badge--warning" style="height:18px">Key changed</span>' : ''}</span></td><td>${ty}</td><td><span class="fp">${fp}</span></td><td class="num">${d}</td><td>${btn({ label: 'Remove', icon: 'trash', variant: 'ghost', size: 'sm', iconOnly: true, cls: 'is-danger' })}</td></tr>`).join('')}
        </tbody></table></div>`, 900);
      case 'modules': return spage('Modules', 'Optional features load only when enabled — startup stays fast and memory low.',
        sgroup('Installed', [['k8s', 'Kubernetes', 'Clusters, workloads, logs, shell, port-forward, Helm, topology and traffic map.', 'v1.2.0 · 6.1 MB', true], ['docker', 'Docker', 'Local, SSH and TCP endpoints. Containers, Compose, images, volumes, networks, registries.', 'v1.1.3 · 2.4 MB', true], ['bucket', 'S3 storage', 'AWS, MinIO, R2 and any S3-compatible API. Versions, share links, sync.', 'v1.0.8 · 1.8 MB', true], ['monitor', 'RDP', 'Embedded remote desktop (FreeRDP) or the system client.', 'v1.0.2 · 9.6 MB', true], ['plug', 'Serial', 'COM / tty ports with baud, parity and flow control.', 'v0.9.0 · 0.3 MB', false]]
          .map(([i, n, d, v, on]) => srow(`<span class="row" style="gap:8px">${ic(i, 16, 'subtle')}${n}<span class="subtle" style="font-weight:400;font-size:12px">${v}</span></span>`, d, sw(n, on)))));
      case 'updates': return spage('Updates', 'Current version: 1.2.0-beta.11.',
        sgroup('Status', [srow('Version 1.2.0 is available', 'Released Oct 2 · 84 MB · <a class="link" href="#/settings/updates">Release notes</a>', btn({ label: 'Download', icon: 'download', variant: 'primary', size: 'sm', action: 'toast-demo' }))]) +
        sgroup('Settings', [srow('Channel', '', seg('channel', 'beta', [['stable', 'Stable'], ['beta', 'Beta (early access)']], 'seg')), srow('Check for updates when the app starts', '', sw('Auto check', true))]));
      case 'diagnostics': return spage('Diagnostics', 'Information to include when you report a problem. Nothing is sent automatically.',
        sgroup('App', [['Version', '1.2.0-beta.11'], ['Electron', '33.2.1'], ['Chromium', '130.0.6723.137'], ['Node.js', '20.18.1'], ['Platform', 'Windows 11 23H2 · x64']].map(([k, v]) => srow(k, '', `<span class="mono muted">${v}</span>`))) +
        sgroup('Runtime', [srow('Memory', 'Main 142 MB · renderer 318 MB · session host 96 MB', ''), srow('Session host', '6 sessions · 2 forwards · 2 transfers', statusHtml('success', 'Running')), srow('Modules loaded', 'kubernetes, docker, s3, rdp', '')]) +
        sgroup('Logs', [srow('Verbose logging', 'Writes detailed SSH and module logs for 24 hours.', sw('Verbose logging', false)), srow('Copy details', 'Version, platform and the last 200 log lines (secrets removed).', btn({ label: 'Copy details', icon: 'copy', size: 'sm', action: 'copy' })), srow('Report a problem', '', btn({ label: 'Open issue…', icon: 'external', size: 'sm', variant: 'ghost' }))]));
    }
    return '';
  }

  /* 6.8 Transfers center — mọi nguồn (SFTP, S3, Docker files, editor). Lỗi: Resume / Discard. */
  function xferRow(x) {
    const dirIc = x.dir === 'up' ? 'upload' : 'download';
    let prog = '', num = '', acts = '';
    if (x.st === 'active') {
      prog = `<div class="xfer__prog"><span class="progress"><span class="progress__bar" style="width:${x.pct}%;display:block"></span></span></div>`;
      num = `${x.pct}% · ${x.speed}<div class="xfer__sub" style="text-align:right">${x.eta} left · ${x.size}</div>`;
      acts = btn({ label: 'Pause', icon: 'pause', variant: 'ghost', size: 'sm', iconOnly: true }) + btn({ label: 'Cancel', icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true });
    } else if (x.st === 'queued') {
      prog = '<span class="subtle" style="font-size:12px">Queued</span>'; num = x.size;
      acts = btn({ label: 'Remove from queue', icon: 'x', variant: 'ghost', size: 'sm', iconOnly: true });
    } else if (x.st === 'failed') {
      prog = `<div class="xfer__prog"><span class="progress"><span class="progress__bar" style="width:${x.pct}%;display:block;background:var(--danger)"></span></span></div>`;
      num = `${x.pct}% of ${x.size}`;
      acts = btn({ label: 'Resume', variant: 'ghost', size: 'sm', tipText: `Resume from ${x.pct}%`, action: 'toast-demo' }) + btn({ label: 'Discard (delete the partial file)', icon: 'trash', variant: 'ghost', size: 'sm', iconOnly: true, cls: 'is-danger', action: 'toast-demo' });
    } else {
      prog = `<span class="muted" style="font-size:12px">${x.note === 'Saved to server' ? 'Saved to server' : x.dir === 'up' ? 'Uploaded' : 'Downloaded'}${x.note && x.note !== 'Saved to server' ? ' ' + x.note : ''}</span>`; num = `${x.size}<div class="xfer__sub" style="text-align:right">${x.when}</div>`;
      acts = btn({ label: 'Show in folder', icon: 'folder-open', variant: 'ghost', size: 'sm', iconOnly: true });
    }
    return `<div class="xfer${x.st === 'failed' ? ' xfer--failed' : ''}" role="listitem">${x.st === 'failed' ? `<span class="sev-ic sev-ic--danger" style="margin:0">${ic('alert-circle', 16)}</span>` : ic(dirIc, 16)}
      <div style="min-width:0"><div class="xfer__name">${esc(x.name)}</div><div class="xfer__sub">${x.via} · ${x.dir === 'up' ? 'upload' : 'download'}${x.err ? ` · <span style="color:var(--danger)">${esc(x.err.split(' at ')[0])}</span>` : ''}</div></div>
      <div class="xfer__route" title="${esc(x.src)} → ${esc(x.dst)}">${esc(x.src)} → ${esc(x.dst)}</div>
      ${prog}<div class="xfer__num">${num}</div><div class="xfer__actions">${acts}</div></div>`;
  }
  function ctTransfers() {
    const grp = (title, st, extra = '') => { const list = XFERS.filter((x) => x.st === st); return list.length ? `<div class="xfer-group">${title} <span class="count">${list.length}</span><span class="spacer"></span>${extra}</div><div role="list">${list.map(xferRow).join('')}</div>` : ''; };
    return `<div class="toolbar"><label class="input input-filter">${ic('search', 14)}<input placeholder="${t('filter')}" aria-label="Filter transfers" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">Source: <b>Any</b></button><button type="button" class="chip">Direction: <b>Any</b></button></div>
        <span class="spacer"></span><span class="toolbar-count">2 running · 4.5 MB/s</span>
        ${btn({ label: 'Pause all', icon: 'pause', variant: 'ghost', size: 'sm' })}${btn({ label: 'Clear finished', variant: 'ghost', size: 'sm' })}</div>
      <div class="page" style="padding:0 0 24px">
        ${grp(t('failed'), 'failed', btn({ label: 'Retry failed', variant: 'ghost', size: 'sm' }) + `<button type="button" class="btn btn--ghost btn--sm select" style="min-width:0">Keep partial files${ic('chevron-down', 12)}</button>`).replace('margin-top:var(--sp-3)', '')}
        ${grp(t('active'), 'active')}${grp('Queued', 'queued', '<span class="subtle" style="font-size:12px;font-weight:400">4 files at once · change in Settings › Files</span>')}${grp(t('completed'), 'done')}
      </div>`;
  }

  /* 6.9 Files — trình quản lý tệp 2 khung: Local | Remote (SFTP), hàng đợi bên dưới */
  function fmPane({ side, title, picker, path, rows, focused, remote }) {
    const crumbsHtml = path.split('/').filter(Boolean).map((p) => `<a href="#/files">${p}</a>`).join('<span class="sep">/</span>');
    return `<section class="fm-pane${focused ? ' is-focused' : ''}" aria-label="${title}">
      <div class="fm-head">${picker}<div class="fm-path">${remote ? '' : '<a href="#/files">~</a><span class="sep">/</span>'}${remote ? '<span class="sep">/</span>' : ''}${crumbsHtml}</div>
        ${btn({ label: 'Up one folder', icon: 'arrow-up', variant: 'ghost', size: 'sm', iconOnly: true, k: 'backspace' })}${btn({ label: 'New folder', icon: 'folderplus', variant: 'ghost', size: 'sm', iconOnly: true })}${btn({ label: 'Refresh', icon: 'refresh', variant: 'ghost', size: 'sm', iconOnly: true })}${btn({ label: 'More', icon: 'more', variant: 'ghost', size: 'sm', iconOnly: true })}</div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="${title} files"><colgroup><col style="width:32px"/><col/><col style="width:84px"/><col style="width:110px"/>${remote ? '<col class="col-opt-2" style="width:96px"/>' : ''}</colgroup>
        <thead><tr><th class="col-check"></th><th aria-sort="ascending" class="is-sortable"><span class="th-inner">Name${ic('arrow-up', 12, 'sort-ic')}</span></th><th class="is-num">Size</th><th>Modified</th>${remote ? '<th class="col-opt-2">Permissions</th>' : ''}</tr></thead><tbody>
        ${rows.map(([n, d, sz, m, perm], i) => `<tr${(side === 'L' && n === 'release-2.15.0.tar.gz') || (side === 'R' && n === 'compose.yaml') ? ' aria-selected="true"' : ''}><td class="col-check">${n === '..' ? '' : `<input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${n}" ${(side === 'L' && n === 'release-2.15.0.tar.gz') || (side === 'R' && n === 'compose.yaml') ? 'checked' : ''}/>`}</td>
          <td class="cell-primary"><span class="cell-name">${ic(n === '..' ? 'corner-down-left' : d ? 'folder' : 'file', 14, d ? 'is-folder subtle' : 'subtle')}<span${n === '..' ? ' class="subtle" style="font-weight:400"' : ''}>${n}</span></span></td>
          <td class="is-num num">${sz || ''}</td><td class="num">${m || ''}</td>${remote ? `<td class="col-opt-2"><span class="mono subtle">${perm || ''}</span></td>` : ''}</tr>`).join('')}
        </tbody></table></div>
      <div class="fm-foot"><span>${rows.length - 1} items</span><span>1 selected · ${side === 'L' ? '84.6 MB' : '1.8 KB'}</span><span class="spacer"></span>${side === 'L' ? '<span>Free 212 GB</span>' : '<span>Free 30.1 GB · /dev/sda1</span>'}</div>
    </section>`;
  }
  function ctFiles() {
    const active = XFERS.filter((x) => x.st === 'active' || x.st === 'queued').slice(0, 3);
    return `<div class="toolbar" role="toolbar" aria-label="File manager">
        ${btn({ label: 'Upload', icon: 'upload', size: 'sm', k: 'F5', tipText: 'Copy selected from Local to prod-web-01', action: 'toast-demo' })}
        ${btn({ label: 'Download', icon: 'download', size: 'sm', tipText: 'Copy selected from prod-web-01 to Local', action: 'toast-demo' })}
        <span class="header-sep" aria-hidden="true"></span>
        ${btn({ label: 'Edit', icon: 'file-code', variant: 'ghost', size: 'sm', k: 'F4', tipText: 'Open in the in-app editor', action: 'go-editor' })}
        ${btn({ label: 'Rename', variant: 'ghost', size: 'sm', k: 'F2', tipText: 'Rename' })}
        ${btn({ label: 'Permissions…', variant: 'ghost', size: 'sm', tipText: 'chmod / chown' })}
        ${btn({ label: 'Compare folders', icon: 'diff', variant: 'ghost', size: 'sm' })}
        <span class="spacer"></span>
        <label class="check-row" style="font-size:12px">${sw('Sync browsing', false)}Sync browsing</label>
        ${btn({ label: 'Delete selected', icon: 'trash', variant: 'ghost', size: 'sm', iconOnly: true, k: 'del', cls: 'is-danger' })}
      </div>
      <div class="fm">
        ${fmPane({ side: 'L', title: 'Local', picker: `<button type="button" class="btn btn--sm select" aria-haspopup="menu">${ic('laptop', 14)}This computer${ic('chevron-down', 12)}</button>`, path: 'shellhouse/release', rows: LOCAL_FILES, focused: false })}
        ${fmPane({ side: 'R', title: 'Remote', remote: true, picker: `<button type="button" class="btn btn--sm select" aria-haspopup="menu">${ic('ubuntu', 14)}prod-web-01${envDot('prod')}${ic('chevron-down', 12)}</button>`, path: 'srv/shop', rows: REMOTE_FILES, focused: true })}
      </div>
      <div class="queue" aria-label="Transfer queue"><div class="queue__head"><b>Transfers</b><span>${active.length} in queue</span><span class="spacer"></span><a class="btn btn--ghost btn--sm" href="#/transfers">Open transfers ${ic('arrow-right', 12)}</a></div>
        ${active.map(xferRow).join('')}</div>`;
  }

  /* 6.10 Snippets — trình quản lý (list + inspector) ; chạy từ palette bằng tiền tố ";" */
  const snipHtml = (cmd) => esc(cmd).replace(/\{\{([^}]+)\}\}/g, (_, v) => `<span class="var">{{${v}}}</span>`);
  function ctSnippets() {
    return `<div class="toolbar"><label class="input input-filter">${ic('search', 14)}<input placeholder="Search snippets…" aria-label="Search snippets" data-role="table-filter"/>${kbd('/')}</label>
        <div class="chips"><button type="button" class="chip">Tag: <b>Any</b></button><button type="button" class="chip">Scope: <b>Any</b></button></div>
        <span class="spacer"></span><span class="toolbar-count">${SNIPPETS.length} snippets · run from ${kbd('mod+K')} with <span class="code-inline">;</span></span>
        ${btn({ label: 'New snippet', icon: 'plus', variant: 'primary', size: 'sm', k: 'n', tipText: 'New snippet', action: 'toast-demo' })}</div>
      <div class="table-wrap"><table class="dtable" role="grid" aria-label="Snippets"><colgroup><col style="width:36px"/><col style="width:230px"/><col/><col class="col-opt-2" style="width:110px"/><col class="col-opt-1" style="width:150px"/><col style="width:96px"/><col style="width:40px"/></colgroup>
        <thead><tr><th class="col-check"></th><th>Name</th><th>Command</th><th class="col-opt-2">Tags</th><th class="col-opt-1">Scope</th><th>Last run</th><th></th></tr></thead><tbody>
        ${SNIPPETS.map((x) => `<tr data-srow="${x.id}" class="${state.inspector && state.snippetActive === x.id ? 'is-active' : ''}" tabindex="-1"><td class="col-check"><input type="checkbox" class="checkbox" tabindex="-1" aria-label="Select ${x.name}"/></td>
          <td class="cell-primary"><span class="cell-name">${ic(x.macro ? 'list' : 'braces', 14, 'subtle')}<span>${x.name}</span></span></td>
          <td><span class="snip-cmd ellipsis" style="display:block">${snipHtml(x.cmd.split('\n')[0])}${x.cmd.includes('\n') ? ` <span class="subtle">+${x.cmd.split('\n').length - 1} lines</span>` : ''}</span></td>
          <td class="col-opt-2">${x.tags.join(', ')}</td><td class="col-opt-1">${x.scope}</td><td class="num">${x.used}</td>
          <td class="col-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Run ${x.name}" data-action="snippet-run" data-id="${x.id}" tabindex="-1">${ic('play', 14)}</button></td></tr>`).join('')}
        </tbody></table></div>`;
  }
  function inSnippet() {
    const x = SNIPPETS.find((y) => y.id === state.snippetActive) || SNIPPETS[0];
    const vars = [...x.cmd.matchAll(/\{\{([^}:]+)(?::([^}]*))?\}\}/g)].map((m) => [m[1], m[2]]).filter((v, i, a) => a.findIndex((w) => w[0] === v[0]) === i);
    return inspectorHead({
      iconTile: `<span class="itile itile--lg">${ic('braces', 16)}</span>`, name: x.name,
      meta: `<span>Snippet</span><span class="sep">·</span><span>${x.runs} runs</span><span class="sep">·</span><span>${x.used}</span>`,
      actions: btn({ label: 'Insert', size: 'sm', tipText: 'Insert into the active terminal', action: 'snippet-run', data: ` data-id="${x.id}"` }) + btn({ label: 'Insert and run', icon: 'play', size: 'sm', action: 'snippet-run', data: ` data-id="${x.id}"` }) + '<span class="spacer"></span>' + btn({ label: 'Delete snippet', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger', action: 'toast-demo' })
    }) + `<div class="inspector__body">
      <div class="section stack" style="gap:12px">
        <label class="field"><span class="field__label">Name</span><span class="input"><input value="${esc(x.name)}" aria-label="Name"/></span></label>
        <div class="field"><span class="field__label">Command</span><div class="code-box" contenteditable="true" spellcheck="false" aria-label="Command" role="textbox" aria-multiline="true">${snipHtml(x.cmd)}</div>
          <span class="field__hint">Use <span class="code-inline">{{name}}</span> for a required variable or <span class="code-inline">{{name:default}}</span> for one with a default.</span></div>
        <label class="field"><span class="field__label">Tags</span><span class="input"><input value="${x.tags.join(', ')}" placeholder="Tags, comma separated" aria-label="Tags"/></span></label>
        <label class="check-row">${sw('Macro', !!x.macro)}Macro: send line by line, waiting for the prompt</label>
      </div>
      <div class="section"><div class="section__head"><span class="section__title">Variables</span><span class="section__count">${vars.length}</span></div>
        ${vars.map(([n, d]) => `<div class="kv-line"><span class="mono">${n}</span><span class="subtle">${d !== undefined ? 'default ' + esc(d) : 'required'}</span></div>`).join('') || '<div class="subtle">No variables.</div>'}</div>
      <div class="section"><div class="section__head"><span class="section__title">Available on</span></div><div class="muted">${x.scope}</div></div>
    </div>`;
  }

  /* ---------------------------------------------------------------- 7. Overlays */

  /* 7.1 Menu (dropdown + context menu) — role=menu, ↑↓ Enter Esc */
  let menuState = null;
  function openMenu(x, y, items, anchor) {
    closeMenu(false);
    const layer = $('#layer-menu');
    layer.innerHTML = `<div class="menu" role="menu" tabindex="-1">${items.map((it, i) => {
      if (it.sep) return '<div class="menu__sep" role="separator"></div>';
      if (it.group) return `<div class="menu__label" role="presentation">${esc(it.group)}</div>`;
      const role = it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
      return `<button type="button" class="menu__item${it.danger ? ' menu__item--danger' : ''}" role="${role}" data-i="${i}" tabindex="-1"${it.checked !== undefined ? ` aria-checked="${!!it.checked}"` : ''}${it.disabled ? ' aria-disabled="true"' : ''}>
        ${it.checked !== undefined ? ic('check', 14, 'menu__check') : it.iconHtml || (it.icon ? ic(it.icon, 14) : '')}<span class="ellipsis">${esc(it.label)}</span>${it.meta ? `<span class="menu__meta">${esc(it.meta)}</span>` : it.k ? kbd(it.k) : ''}</button>`;
    }).join('')}</div>`;
    const m = $('.menu', layer);
    const r = m.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8), top = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
    m.style.left = left + 'px'; m.style.top = top + 'px';
    menuState = { items, anchor, el: m };
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    const first = $('.menu__item:not([aria-disabled="true"])', m);
    if (first) { first.focus(); first.dataset.active = 'true'; }
    m.addEventListener('click', (e) => {
      const b = e.target.closest('.menu__item'); if (!b) return;
      const it = items[+b.dataset.i];
      if (it.checked !== undefined) { it.checked = !it.checked; b.setAttribute('aria-checked', it.checked); it.run && it.run(it.checked); return; }
      closeMenu(true); it.run && it.run();
    });
    m.addEventListener('mousemove', (e) => { const b = e.target.closest('.menu__item'); if (b) { $$('.menu__item', m).forEach((x) => delete x.dataset.active); b.dataset.active = 'true'; b.focus(); } });
  }
  function closeMenu(restore) {
    if (!menuState) return;
    if (menuState.anchor) { menuState.anchor.setAttribute('aria-expanded', 'false'); if (restore) menuState.anchor.focus(); }
    $('#layer-menu').innerHTML = ''; menuState = null;
  }
  function menuKey(e) {
    if (!menuState) return false;
    const list = $$('.menu__item:not([aria-disabled="true"])', menuState.el);
    let i = list.findIndex((x) => x.dataset.active === 'true');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list.forEach((x) => delete x.dataset.active); list[i].dataset.active = 'true'; list[i].focus(); return true;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (list[i]) list[i].click(); return true; }
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); return true; }
    return true;
  }
  function anchorMenu(el, items) { const r = el.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, items, el); }
  function resourceMenu(kind, name) {
    const prodDel = kind === 'Deployment' && name === 'web';
    return [
      { label: 'Open', icon: 'panel-right', k: 'enter', run: () => {} },
      { label: 'Logs', icon: 'logs', k: 'L', run: () => { state.inspectorTab.pod = 'logs'; location.hash = '#/k8s/pods'; render(); } },
      { label: 'Open shell', icon: 'terminal-square', k: 'S', run: () => toast('info', 'Shell opened in a new tab', `kubectl exec -it ${name} -- sh`) },
      { label: 'Port-forward…', icon: 'route', k: 'F' },
      { label: 'Copy name', icon: 'copy', k: 'C', run: () => toast('success', 'Copied', name) },
      { label: 'Edit YAML', icon: 'code', k: 'E' },
      { sep: true },
      { label: kind === 'Pod' ? 'Restart (delete Pod)' : 'Rollout restart', icon: 'restart', k: 'shift+R', run: () => restartDemo(name) },
      { label: 'Scale…', icon: 'scale', disabled: kind === 'Pod' },
      { sep: true },
      { label: `Delete ${kind}…`, icon: 'trash', k: 'mod+backspace', danger: true, run: () => prodDel ? confirmDeleteWeb() : confirmAction({ level: 3, kind, name, env: 'prod' }) }
    ];
  }

  /* 7.2 Dialog + confirm theo mức rủi ro */
  let dialogState = null;
  function openDialog(html, opts = {}) {
    const prevFocus = document.activeElement;
    $('#layer-dialog').innerHTML = `<div class="overlay" data-role="overlay"></div><div class="dialog${opts.danger ? ' dialog--danger' : ''}" role="${opts.alert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc" style="${opts.width ? 'width:' + opts.width + 'px' : ''}">${html}</div>`;
    const d = $('.dialog');
    dialogState = { prevFocus, el: d, onClose: opts.onClose };
    $('[data-role="overlay"]').addEventListener('mousedown', () => closeDialog());
    const f = $(opts.focus || '[autofocus], input, .btn', d); if (f) f.focus();
    return d;
  }
  function closeDialog() {
    if (!dialogState) return;
    const p = dialogState.prevFocus; $('#layer-dialog').innerHTML = ''; dialogState = null;
    if (p && p.focus) p.focus();
  }
  function trapFocus(e, root) {
    const f = $$('button:not([disabled]), input, [tabindex="0"], a[href]', root).filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  /**
   * level 1 — reversible / low impact: không hỏi, làm ngay + toast có Undo (vd. restart Pod ở dev, copy)
   * level 2 — destructive nhưng phạm vi nhỏ, môi trường không phải prod: dialog Cancel / Confirm
   * level 3 — destructive trên PRODUCTION (CHỈ production — quyết định 2026-10-04): phải gõ tên (hoặc "N pods").
   *           Hàng loạt ở staging/dev → level 2 (dialog thường, liệt kê số lượng).
   */
  function confirmAction({ level, kind, name, env, count, impact, onConfirm, scope }) {
    if (level === 3 && env !== 'prod') level = 2;
    if (level === 1) { (onConfirm || (() => {}))(); toast('success', `${kind} ${name} restarted`, 'New Pod is starting…', { label: 'Undo', run: () => toast('info', 'Restart cancelled') }); return; }
    const typeText = count ? `${count} ${kind.toLowerCase()}s` : name;
    const isProd = env === 'prod';
    const title = count ? `Delete ${count} ${kind}s?` : `Delete ${kind} ${name}?`;
    const d = openDialog(`
      <div class="dialog__head"><span class="itile itile--lg">${ic('trash', 16)}</span><div style="flex:1;min-width:0"><h2 class="dialog__title" id="dlg-title">${esc(title)}</h2><p class="dialog__desc" id="dlg-desc">${level === 3 ? 'This cannot be undone.' : 'You can recreate it from the controller.'}${isProd ? ' This resource is in <b style="color:var(--env-prod)">production</b>.' : ''}</p></div>${isProd ? envBadge('prod') : env ? envBadge(env) : ''}</div>
      <div class="dialog__body">
        <div class="confirm-target">${ic(kind === 'Deployment' ? 'workload' : kind === 'Container' ? 'container' : kind === 'Object' ? 'image' : kind === 'Account' ? 'user' : 'pod', 14)}<span class="mono ellipsis" style="flex:1">${count ? esc(name) : (scope || 'prod-cluster / shop') + ' / ' + esc(name)}</span>${count ? `<span class="badge">${count} items</span>` : ''}</div>
        ${impact ? `<ul class="confirm-impact">${impact.map((x) => `<li>${ic(x[0], 14)}<span>${x[1]}</span></li>`).join('')}</ul>` : ''}
        ${level === 3 ? `<div class="field"><label class="field__label" for="confirm-input">Type <span class="code-inline">${esc(typeText)}</span> to confirm</label>
          <label class="input"><input id="confirm-input" type="text" autocomplete="off" spellcheck="false" data-expect="${esc(typeText)}" aria-describedby="confirm-hint"/></label>
          <span class="field__hint" id="confirm-hint">Case-sensitive. Paste is disabled for production.</span></div>` : ''}
      </div>
      <div class="dialog__foot"><span class="subtle">${kbd('esc')} to cancel</span>
        <button type="button" class="btn" data-dlg="cancel">${t('cancel')}</button>
        <button type="button" class="btn btn--danger" data-dlg="ok" ${level === 3 ? 'disabled' : ''}>${ic('trash', 14)}<span>${count ? `Delete ${count} ${kind}s` : `Delete ${kind}`}</span></button></div>`, { danger: true, alert: true, focus: level === 3 ? '#confirm-input' : '[data-dlg="cancel"]' });
    const ok = $('[data-dlg="ok"]', d);
    const inp = $('#confirm-input', d);
    if (inp) {
      inp.addEventListener('input', () => { ok.disabled = inp.value !== inp.dataset.expect; inp.parentElement.dataset.state = inp.value && !inp.dataset.expect.startsWith(inp.value) ? 'error' : ''; });
      inp.addEventListener('paste', (e) => { if (isProd) e.preventDefault(); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) ok.click(); });
    }
    $('[data-dlg="cancel"]', d).addEventListener('click', closeDialog);
    ok.addEventListener('click', () => { closeDialog(); (onConfirm || (() => {}))(); toast('success', count ? `Deleting ${count} ${kind}s` : `${kind} ${name} deleted`, isProd ? 'Recorded in audit log · prod-cluster' : '', null); });
  }
  function confirmDeleteWeb() {
    confirmAction({ level: 3, kind: 'Deployment', name: 'web', env: 'prod', impact: [['pod', '3 Pods will be terminated (2 healthy)'], ['service', 'Service <b>web</b> will have no endpoints — <b>shop.vn</b> returns 503'], ['history', 'Rollout history (14 revisions) is lost']] });
  }
  function restartDemo(name) { toast('success', `Restarting ${name}`, 'Rolling restart started · 0/3 updated', { label: 'Undo', run: () => toast('info', 'Rollout paused') }); }
  function shortcutsDialog() {
    const groups = [
      ['General', [['mod+K', 'Command palette'], ['?', 'Keyboard shortcuts'], ['/', 'Focus filter'], ['[', 'Toggle explorer'], [']', 'Toggle inspector'], ['alt+T', 'Toggle theme'], ['esc', 'Close / clear selection']]],
      ['Navigation', [['g h', 'Home'], ['g s', 'Hosts'], ['g f', 'Files'], ['g k', 'Kubernetes'], ['g d', 'Docker'], ['g b', 'Storage'], ['g t', 'Transfers']]],
      ['Lists', [['j', 'Next row'], ['k', 'Previous row'], ['x', 'Select row'], ['enter', 'Open in inspector'], ['shift+R', 'Restart / refresh'], ['mod+backspace', 'Delete…']]],
      ['Sessions', [['mod+T', 'New tab'], ['mod+W', 'Close tab'], ['alt+1', 'Go to tab 1…9'], ['mod+\\', 'Split right'], ['mod+shift+F', 'Toggle SFTP'], ['mod+shift+M', 'MultiExec'], ['mod+shift+S', 'Snippets']]]
    ];
    openDialog(`<div class="dialog__head"><span class="itile itile--lg">${ic('keyboard', 16)}</span><div style="flex:1"><h2 class="dialog__title" id="dlg-title">Keyboard shortcuts</h2><p class="dialog__desc" id="dlg-desc">Single-key shortcuts work when focus is not in a text field. <a class="link" href="#/settings/shortcuts">Customize…</a></p></div></div>
      <div class="dialog__body" style="display:grid;grid-template-columns:1fr 1fr;gap:16px 28px">${groups.map(([g, list]) => `<div><div class="section__title" style="margin-bottom:6px">${g}</div>${list.map(([k, l]) => `<div class="row" style="height:28px;justify-content:space-between"><span>${l}</span>${kbd(k)}</div>`).join('')}</div>`).join('')}</div>
      <div class="dialog__foot"><button type="button" class="btn" data-dlg="cancel">Close</button></div>`, { width: 620 });
    $('[data-dlg="cancel"]').addEventListener('click', closeDialog);
  }

  /* 7.2b Dialog bổ sung: Pull / Build image, Sync S3, Diff (YAML / Helm rollback), Group, Snippet variables */
  const dlgHead = (icon, title, desc) => `<div class="dialog__head"><span class="itile itile--lg">${ic(icon, 16)}</span><div style="flex:1;min-width:0"><h2 class="dialog__title" id="dlg-title">${title}</h2>${desc ? `<p class="dialog__desc" id="dlg-desc">${desc}</p>` : ''}</div></div>`;
  const dlgFoot = (primary, extra = '') => `<div class="dialog__foot">${extra || `<span class="subtle">${kbd('esc')} to cancel</span>`}<button type="button" class="btn" data-dlg="cancel">${t('cancel')}</button>${primary}</div>`;
  const field = (label, control, hint) => `<label class="field"><span class="field__label">${label}</span>${control}${hint ? `<span class="field__hint">${hint}</span>` : ''}</label>`;
  const inp = (v, ph = '', mono) => `<span class="input"><input value="${esc(v)}" placeholder="${esc(ph)}"${mono ? ' style="font-family:var(--font-mono);font-size:12px"' : ''}/></span>`;
  function bindDlg(d, onOk) { $$('[data-dlg="cancel"]', d).forEach((b) => b.addEventListener('click', closeDialog)); const ok = $('[data-dlg="ok"]', d); if (ok) ok.addEventListener('click', () => { closeDialog(); onOk && onOk(); }); }
  function pullDialog() {
    const d = openDialog(dlgHead('download', 'Pull an image', 'Runs docker pull on build-server. Progress continues in the background.') + `<div class="dialog__body">
      ${field('Image', inp('registry.shop.vn/api:5.2.1', 'nginx:1.27 or ghcr.io/org/app:1.0', true), 'Signed in to registry.shop.vn · <a class="link" href="#/docker/images">Manage registries</a>')}
      <div class="form-grid">${field('Platform', `<button type="button" class="btn select">linux/amd64 (default)${ic('chevron-down', 14)}</button>`)}${field('Registry login', `<button type="button" class="btn select">registry.shop.vn${ic('chevron-down', 14)}</button>`)}</div>
      <div class="stack" style="gap:6px;margin-top:4px"><div class="field__label">Progress</div>
        ${[['a3f1c2…', 'Already exists', 100], ['9e04bd…', 'Downloading 41.2 / 96.0 MB', 43], ['c71e0a…', 'Waiting', 0]].map(([l, st, p]) => `<div class="row" style="gap:10px;font-size:12px"><span class="mono subtle" style="width:64px">${l}</span><span class="progress" style="flex:1"><span class="progress__bar" style="width:${p}%;display:block"></span></span><span class="muted" style="width:170px">${st}</span></div>`).join('')}</div>
    </div>` + dlgFoot(`<button type="button" class="btn btn--primary" data-dlg="ok">${ic('download', 14)}<span>Pull</span></button>`), { width: 560 });
    bindDlg(d, () => toast('info', 'Pulling registry.shop.vn/api:5.2.1', 'Continues in the background · see Transfers'));
  }
  function buildDialog() {
    const d = openDialog(dlgHead('code', 'Build an image', 'Runs docker build (BuildKit) where Docker runs. The output appears live.') + `<div class="dialog__body">
      <div class="segmented seg-full" role="radiogroup" aria-label="Context location">${[['server', 'Folder on the server'], ['local', 'This computer'], ['git', 'Git URL']].map(([v, l]) => `<button type="button" class="segmented__item" role="radio" aria-checked="${v === 'server'}" data-action="seg">${l}</button>`).join('')}</div>
      ${field('Build context', inp('/srv/shop/api', '', true), 'A folder on the server, like /srv/app — the build runs there.')}
      <div class="form-grid">${field('Dockerfile', inp('Dockerfile', '', true), 'Relative to the context')}${field('Target stage', inp('', 'Optional — for multi-stage Dockerfiles'))}</div>
      ${field('Tags', inp('registry.shop.vn/api:5.2.1  registry.shop.vn/api:latest', '', true), 'Separated by spaces. Tags look like app:1.0 or ghcr.io/org/app:1.0')}
      ${field('Build arguments', `<div class="code-box" style="min-height:52px" contenteditable="true" role="textbox" aria-label="Build arguments">NODE_VERSION=22\nGIT_SHA=4f9a1c2</div>`, 'One NAME=value per line')}
      <div class="row" style="gap:20px"><label class="check-row"><input type="checkbox" class="checkbox" checked/>Pull base images</label><label class="check-row"><input type="checkbox" class="checkbox"/>Rebuild every step (--no-cache)</label><label class="check-row"><input type="checkbox" class="checkbox"/>Push after build</label></div>
    </div>` + dlgFoot(`<button type="button" class="btn btn--primary" data-dlg="ok">${ic('play', 14)}<span>Build</span></button>`), { width: 600 });
    bindDlg(d, () => toast('info', 'Building /srv/shop/api…', 'Live output opens in a new tab'));
  }
  function syncDialog() {
    const items = [['upload', 'images/2026/hero-winter.jpg', '3.1 MB'], ['upload', 'images/2026/hero-winter@2x.jpg', '7.4 MB'], ['upload', 'images/2026/sale-1111.webp', '640 KB'], ['update', 'images/2026/manifest.json', '1.3 KB'], ['update', 'images/2026/logo.svg', '6.4 KB'], ['delete', 'images/2026/hero-summer-2025.jpg', '2.2 MB'], ['delete', 'images/2026/old/banner-tet.png', '1.1 MB']];
    const d = openDialog(dlgHead('sync', 'Sync a folder with shop-media-assets', 'Compares by size and modified time. Nothing changes until you confirm.') + `<div class="dialog__body">
      <div class="form-grid">${field('From', `<span class="input">${ic('laptop', 14)}<input value="~/campaign/images/2026" style="font-family:var(--font-mono);font-size:12px"/></span>`)}${field('To', `<span class="input">${ic('bucket', 14)}<input value="s3://shop-media-assets/images/2026/" style="font-family:var(--font-mono);font-size:12px"/></span>`)}</div>
      <div class="row" style="gap:16px"><div class="segmented" role="radiogroup" aria-label="Mode">${[['copy', 'Copy new & changed'], ['mirror', 'Mirror (also delete)']].map(([v, l]) => `<button type="button" class="segmented__item" role="radio" aria-checked="${v === 'mirror'}" data-action="seg">${l}</button>`).join('')}</div><label class="check-row" style="font-size:12px"><input type="checkbox" class="checkbox"/>Skip files matching .syncignore</label></div>
      <div class="sync-sum"><span><b>3</b>to upload</span><span><b>2</b>to update</span><span class="is-danger"><b>2</b>to delete</span><span><b>48</b>unchanged</span><span class="subtle" style="margin-left:auto">14.6 MB to transfer</span></div>
      <div class="sync-list" role="list" aria-label="Preview">${items.map(([op, k, sz]) => `<div class="sync-item" role="listitem"><span class="op${op === 'delete' ? ' del' : op === 'upload' ? ' add' : op === 'update' ? ' upd' : ''}">${op}</span><span class="mono">${k}</span><span class="num subtle" style="text-align:right">${sz}</span></div>`).join('')}</div>
      <div class="field__hint">Versioning is on — deleted objects keep their old versions and can be restored.</div>
    </div>` + dlgFoot(`<button type="button" class="btn btn--primary" data-dlg="ok">${ic('sync', 14)}<span>Sync 7 changes</span></button>`, `<span class="subtle">${ic('info', 12)}Dry run · 2 min ago</span>`), { width: 720, focus: '[data-dlg="cancel"]' });
    bindDlg(d, () => toast('info', 'Syncing 7 changes', '14.6 MB · progress in Transfers', { label: 'Open', run: () => { location.hash = '#/transfers'; } }));
  }
  const DIFF_YAML = [['hunk', '@@ spec.template.spec.containers[web].resources @@'], ['', '        resources:'], ['', '          limits:'], ['', '            cpu: 500m'], ['del', '            memory: 256Mi'], ['add', '            memory: 512Mi'], ['', '          requests:'], ['', '            cpu: 100m'], ['del', '            memory: 128Mi'], ['add', '            memory: 256Mi']];
  function diffHtml(lines, start = 41) { let n = start; return `<div class="diff" role="region" aria-label="Changes">${lines.map(([k, l]) => k === 'hunk' ? `<div class="hunk"><span class="ln"></span><span class="mk"></span><span>${esc(l)}</span></div>` : `<div class="${k}"><span class="ln">${k === 'del' ? '' : n++}</span><span class="mk">${k === 'add' ? '+' : k === 'del' ? '−' : ''}</span><span>${esc(l)}</span></div>`).join('')}</div>`; }
  function yamlDiffDialog() {
    const d = openDialog(dlgHead('diff', 'Review changes to Deployment web', 'prod-cluster / shop · applied with server-side dry-run first.') + `<div class="dialog__body">${diffHtml(DIFF_YAML)}
      <div class="callout callout--info">${ic('info', 14)}<div class="callout__desc" style="margin:0">Server dry-run passed. Applying starts a rolling update of 3 Pods (revision 15).</div></div></div>` +
      dlgFoot(`<button type="button" class="btn btn--primary" data-dlg="ok"><span>Apply</span></button>`, `<span class="subtle">2 changes · ${btn({ label: 'Back to editor', variant: 'ghost', size: 'sm', action: 'noop' })}</span>`), { width: 680, focus: '[data-dlg="cancel"]' });
    bindDlg(d, () => toast('success', 'Applied to Deployment web', 'Rolling update started · revision 15'));
  }
  function rollbackDialog(rev) {
    rev = rev || 57;
    const h = HELM.find((x) => x.name === state.helmActive) || HELM[0];
    const isProd = true;
    const lines = [['hunk', '@@ values.yaml @@'], ['', 'image:'], ['', `  repository: ${h.name === 'shop' ? 'registry.shop.vn/web' : 'registry.k8s.io/' + h.name + '/controller'}`], ['del', `  tag: "${h.app}"`], ['add', `  tag: "${h.app.replace(/(\d+)$/, (n) => Math.max(0, n - 1))}"`], ['', 'migrations:'], ['del', '  enabled: true'], ['add', '  enabled: false'], ['hunk', '@@ chart @@'], ['del', `chart: ${h.chart}`], ['add', `chart: ${h.chart.replace(/(\d+)$/, (n) => Math.max(0, n - 1))}`]];
    const d = openDialog(`<div class="dialog__head"><span class="itile itile--lg">${ic('history', 16)}</span><div style="flex:1;min-width:0"><h2 class="dialog__title" id="dlg-title">Roll back ${h.name} to revision ${rev}?</h2><p class="dialog__desc" id="dlg-desc">Helm creates revision ${h.rev + 1} with the values and chart of revision ${rev}.</p></div>${isProd ? envBadge('prod') : ''}</div>
      <div class="dialog__body">${diffHtml(lines, 1)}
        <div class="row" style="gap:20px"><label class="check-row"><input type="checkbox" class="checkbox" checked/>Wait until resources are ready</label><label class="check-row"><input type="checkbox" class="checkbox"/>Run hooks</label></div></div>` +
      dlgFoot(`<button type="button" class="btn btn--primary" data-dlg="ok">${ic('history', 14)}<span>Roll back to ${rev}</span></button>`), { width: 680, focus: '[data-dlg="cancel"]' });
    bindDlg(d, () => toast('success', `Rolling back ${h.name}`, `Revision ${h.rev + 1} · waiting for resources`));
  }
  function groupDialog(id = 'prod') {
    const g = HOST_GROUPS.find((x) => x.id === id) || HOST_GROUPS[0];
    const d = openDialog(dlgHead('folder', `Group · ${g.name}`, `${g.hosts.length} hosts inherit these settings. A host can override the account, port and jump host — not the environment.`) + `<div class="dialog__body">
      ${field('Name', inp(g.name))}
      <div class="field"><span class="field__label">Environment</span><div class="env-pick" role="radiogroup" aria-label="Environment">${[['prod', 'Production'], ['staging', 'Staging'], ['dev', 'Development'], ['test', 'Test'], ['', 'None']].map(([v, l]) => `<button type="button" role="radio" aria-checked="${g.env === v}" data-action="seg">${v ? `<span class="dot ${v}"></span>` : ''}${l}</button>`).join('')}</div>
        <span class="field__hint">Production adds the red top line, the PROD label and type-to-confirm for destructive actions.</span></div>
      <div class="form-grid">
        ${field('Default account', `<button type="button" class="btn select">${ic('user', 14)}${g.defaults.account}${ic('chevron-down', 14)}</button>`)}
        ${field('Jump host', `<button type="button" class="btn select">${g.defaults.jump || 'None'}${ic('chevron-down', 14)}</button>`)}
        ${field('Port', inp(String(g.defaults.port)))}
        ${field('Startup snippet', `<button type="button" class="btn select">None${ic('chevron-down', 14)}</button>`)}
      </div>
      <label class="check-row"><input type="checkbox" class="checkbox" checked/>Start saved port forwards when a host connects</label>
    </div>` + dlgFoot(`<button type="button" class="btn btn--primary" data-dlg="ok"><span>Save</span></button>`), { width: 560, focus: '[role="radio"][aria-checked="true"]' });
    bindDlg(d, () => toast('success', 'Group saved', `${g.hosts.length} hosts updated`));
  }
  function snippetRun(id) {
    const x = SNIPPETS.find((y) => y.id === id) || SNIPPETS[0];
    const vars = [...x.cmd.matchAll(/\{\{([^}:]+)(?::([^}]*))?\}\}/g)].map((m) => [m[1], m[2]]).filter((v, i, a) => a.findIndex((w) => w[0] === v[0]) === i);
    if (!vars.length) { toast('success', `Inserted “${x.name}”`, 'into prod-web-01'); return; }
    const d = openDialog(dlgHead('braces', x.name, 'Fill in the variables. The command is inserted into prod-web-01.') + `<div class="dialog__body">
      ${vars.map(([n, def], i) => field(`<span class="mono">${n}</span>${def === undefined ? '' : ' <span class="subtle" style="font-weight:400">· default</span>'}`, `<span class="input"><input ${i === 0 ? 'autofocus' : ''} value="${esc(def === undefined ? (n === 'file' ? '/var/log/nginx/error.log' : '') : def)}" style="font-family:var(--font-mono);font-size:12px"/></span>`)).join('')}
      <div class="field"><span class="field__label">Preview</span><div class="code-box" style="min-height:0">${esc(x.cmd.replace(/\{\{([^}:]+)(?::([^}]*))?\}\}/g, (_, n, def) => def !== undefined ? def : n === 'file' ? '/var/log/nginx/error.log' : n))}</div></div>
    </div>` + dlgFoot(`<button type="button" class="btn" data-dlg="ok"><span>Insert</span></button><button type="button" class="btn btn--primary" data-dlg="ok">${ic('play', 14)}<span>Insert and run</span></button>`, `<span class="subtle">${kbd('enter')} insert and run</span>`), { width: 520 });
    bindDlg(d, () => toast('success', `Ran “${x.name}”`, 'on prod-web-01'));
  }
  function workspacesDialog() {
    const d = openDialog(dlgHead('grid', 'Workspaces', 'Save the current tabs and splits, then reopen them in one step.') + `<div class="dialog__body">
      <div class="row">${'<span class="input" style="flex:1"><input placeholder="Name for the current layout, e.g. Prod web + DB"/></span>'}${btn({ label: 'Save current', size: '' })}</div>
      <div class="plain-list">${[['Prod web + DB', '3 SSH · split', 'current'], ['Incident: payments', '2 SSH · 1 local · split', ''], ['Lab', '4 SSH', '']].map(([n, m, c]) => `<div class="list-row" style="height:40px"><span class="list-row__main"><span class="list-row__title"><span>${n}</span>${c ? '<span class="cur-mark">current</span>' : ''}</span><span class="list-row__sub">${m}</span></span>${btn({ label: 'Open', size: 'sm', variant: 'ghost' })}${btn({ label: 'Delete', icon: 'trash', size: 'sm', variant: 'ghost', iconOnly: true, cls: 'is-danger' })}</div>`).join('')}</div>
    </div><div class="dialog__foot"><button type="button" class="btn" data-dlg="cancel">Close</button></div>`, { width: 520 });
    bindDlg(d);
  }

  /* 7.3 Toast */
  function toast(kind, title, desc, action) {
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`; el.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
    el.innerHTML = `<span class="toast__icon">${ic(kind === 'success' ? 'check-circle' : kind === 'danger' ? 'x-circle' : kind === 'warning' ? 'alert' : 'info', 16)}</span>
      <div class="toast__body"><div class="toast__title">${esc(title)}</div>${desc ? `<div class="toast__desc">${esc(desc)}</div>` : ''}</div>
      <div class="toast__actions">${action ? `<button type="button" class="btn btn--sm" data-t="act">${esc(action.label)}</button>` : ''}<button type="button" class="btn btn--ghost btn--sm btn--icon" aria-label="Dismiss" data-t="x">${ic('x', 14)}</button></div>`;
    $('#toasts').appendChild(el);
    let timer;
    const leave = () => { el.dataset.leaving = 'true'; setTimeout(() => el.remove(), 140); };
    const arm = () => { timer = setTimeout(leave, 5000); };
    el.addEventListener('mouseenter', () => clearTimeout(timer)); el.addEventListener('mouseleave', arm);
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; if (b.dataset.t === 'act' && action.run) action.run(); leave(); });
    if (!window.__noToastTimeout) arm();
  }

  /* 7.4 Tooltip */
  let tipTimer = null, tipEl = null;
  function showTip(el, immediate) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const tt = $('#tooltip');
      tt.innerHTML = `<span>${esc(el.dataset.tip)}</span>${el.dataset.kbd ? kbd(el.dataset.kbd) : ''}`;
      tt.dataset.open = 'true';
      const r = el.getBoundingClientRect(), tr = tt.getBoundingClientRect();
      let x, y;
      if (el.dataset.tipSide === 'right') { x = r.right + 8; y = r.top + r.height / 2 - tr.height / 2; }
      else { x = r.left + r.width / 2 - tr.width / 2; y = r.bottom + 6; if (y + tr.height > window.innerHeight - 4) y = r.top - tr.height - 6; }
      tt.style.left = Math.max(6, Math.min(x, window.innerWidth - tr.width - 6)) + 'px'; tt.style.top = y + 'px';
      el.setAttribute('aria-describedby', 'tooltip'); tipEl = el;
    }, immediate ? 0 : 450);
  }
  function hideTip() { clearTimeout(tipTimer); const tt = $('#tooltip'); tt.dataset.open = 'false'; if (tipEl) tipEl.removeAttribute('aria-describedby'); tipEl = null; }

  /* 7.5 Command palette */
  let pal = null;
  function paletteItems() {
    const nav = [
      ['Go to Home', 'home', 'g h', '#/home'], ['Go to Hosts', 'server', 'g s', '#/hosts'], ['Go to Pods', 'pod', 'g k', '#/k8s/pods', 'prod-cluster / shop'], ['Go to Topology', 'network', '', '#/k8s/topology', 'prod-cluster / shop'],
      ['Go to Deployments', 'workload', '', '#/k8s/deployments', 'prod-cluster / shop'], ['Go to Helm releases', 'helm', '', '#/k8s/helm', 'prod-cluster'],
      ['Go to Containers', 'container', 'g d', '#/docker', 'build-server'], ['Go to Compose projects', 'layers', '', '#/docker/compose', 'build-server'], ['Go to Docker images', 'archive', '', '#/docker/images', 'build-server'], ['Go to Docker overview', 'gauge', '', '#/docker/overview', 'build-server'],
      ['Go to Storage', 'bucket', 'g b', '#/s3/objects', 'aws-media'], ['Go to Files (SFTP)', 'folder', 'g f', '#/files'], ['Go to Transfers', 'transfers', 'g t', '#/transfers'], ['Go to Snippets', 'braces', '', '#/snippets'],
      ...SETTINGS_SECTIONS.map(([id, l, i]) => ['Settings › ' + l, i, id === 'terminal' ? 'mod+,' : '', '#/settings/' + id])
    ].map(([label, icon, k, href, sub]) => ({ group: 'Navigation', label, icon, k, sub, run: () => { location.hash = href; } }));
    const hosts = ALL_HOSTS.map((h) => ({ group: 'Hosts', label: h.id, iconHtml: ic(h.os, 16), sub: `${h.user ? h.user + '@' : ''}${h.addr} · ${h.proto.toUpperCase()} · ${h.group}`, env: h.env, run: () => { state.hostTab = h.proto === 'rdp' ? 'rdp' : 'term'; location.hash = '#/hosts'; render(); } }));
    const actions = [
      { label: 'New SSH connection…', icon: 'plus', k: 'n', run: () => toast('info', 'New host', 'Host editor would open here') },
      { label: `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`, icon: state.theme === 'dark' ? 'sun' : 'moon', k: 'alt+T', run: () => setPref('theme', state.theme === 'dark' ? 'light' : 'dark') },
      { label: `Density: ${state.density === 'compact' ? 'comfortable' : 'compact'}`, icon: 'list', run: () => setPref('density', state.density === 'compact' ? 'comfortable' : 'compact') },
      { label: 'MultiExec: type into several terminals', icon: 'radio', k: 'mod+shift+M', run: () => { state.multi = true; location.hash = '#/hosts?multi=1'; render(); } },
      { label: 'Port forwarding for prod-web-01', icon: 'route', run: () => { state.panel = 'forwards'; location.hash = '#/hosts?panel=forwards'; render(); } },
      { label: 'Pull Docker image…', icon: 'download', sub: 'build-server', run: pullDialog },
      { label: 'Sync folder with bucket…', icon: 'sync', sub: 'shop-media-assets', run: syncDialog },
      { label: 'Roll back Helm release…', icon: 'history', sub: 'ingress-nginx', run: () => rollbackDialog(6) },
      { label: 'Workspaces: save or open a layout', icon: 'grid', run: workspacesDialog },
      { label: state.lang === 'en' ? 'Language: Tiếng Việt' : 'Language: English', icon: 'languages', run: () => setPref('lang', state.lang === 'en' ? 'vi' : 'en') },
      { label: 'Toggle explorer', icon: 'panel-left', k: '[', run: () => { state.explorer = !state.explorer; render(); } },
      { label: 'Toggle inspector', icon: 'panel-right', k: ']', run: () => { state.inspector = !state.inspector; render(); } },
      { label: 'Delete Deployment web…', icon: 'trash', sub: 'prod-cluster / shop', env: 'prod', danger: true, run: confirmDeleteWeb },
      { label: 'Restart Deployment web', icon: 'restart', sub: 'prod-cluster / shop', env: 'prod', run: () => restartDemo('web') },
      { label: 'Lock vault', icon: 'lock', k: 'mod+shift+L', run: () => toast('info', 'Vault locked', 'Credentials cleared from memory') },
      { label: 'Keyboard shortcuts', icon: 'keyboard', k: '?', run: shortcutsDialog }
    ].map((x) => ({ group: 'Actions', ...x }));
    const snippets = SNIPPETS.map((x) => ({ group: 'Snippets', label: x.name, icon: 'braces', sub: x.cmd.split('\n')[0], run: () => snippetRun(x.id) }));
    const recent = [
      { label: 'prod-web-01', iconHtml: ic('ubuntu', 16), sub: 'Terminal · 2m ago', env: 'prod', run: () => { state.hostTab = 'term'; location.hash = '#/hosts'; } },
      { label: 'web-7d9f8c6b5-h8sdl', icon: 'pod', sub: 'Pod · prod-cluster / shop', env: 'prod', run: () => { state.podActive = 'web-7d9f8c6b5-h8sdl'; state.inspector = true; location.hash = '#/k8s/pods'; } },
      { label: 'shop-media-assets/images/2026', icon: 'bucket', sub: 'Bucket · aws-media', run: () => { location.hash = '#/s3/objects'; } }
    ].map((x) => ({ group: 'Recent', ...x }));
    return [...recent, ...nav, ...actions, ...hosts, ...snippets];
  }
  function fuzzy(q, s) {
    if (!q) return { score: 0, idx: [] };
    const ql = q.toLowerCase(), sl = s.toLowerCase();
    const sub = sl.indexOf(ql);
    if (sub >= 0) {
      const wordStart = sub === 0 || /[\s\-_/.›]/.test(sl[sub - 1]);
      return { score: 100 + (wordStart ? 50 : 0) - sub, idx: Array.from({ length: q.length }, (_, i) => sub + i) };
    }
    let j = 0; const idx = [];
    for (let i = 0; i < sl.length && j < ql.length; i++) if (sl[i] === ql[j]) { idx.push(i); j++; }
    if (j < ql.length) return null;
    const spread = idx[idx.length - 1] - idx[0];
    if (spread > ql.length * 3) return null; // khớp quá rời rạc → bỏ (tránh nhiễu)
    return { score: 40 - spread, idx };
  }
  function hlText(s, idx) { const set = new Set(idx); return Array.from(s).map((c, i) => set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c)).join(''); }
  function openPalette(initial = '') {
    if (pal) return;
    closeMenu(false);
    const prevFocus = document.activeElement;
    $('#layer-dialog').insertAdjacentHTML('beforeend', `<div class="overlay" data-role="pal-overlay" style="z-index:var(--z-palette)"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="palette__input">${ic('search', 18)}<input type="text" placeholder="Type a command, host or resource…" aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" value="${esc(initial)}"/><span class="badge badge--outline">${MOD === '⌘' ? '⌘K' : 'Ctrl K'}</span></div>
        <div class="palette__list" id="pal-list" role="listbox" aria-label="Results"></div>
        <div class="palette__foot"><span>${kbd('up')}${kbd('down')} navigate</span><span>${kbd('enter')} run</span><span>${kbd('esc')} close</span><span class="spacer"></span><span><span class="code-inline">&gt;</span> commands · <span class="code-inline">@</span> hosts · <span class="code-inline">;</span> snippets</span></div>
      </div>`);
    const el = $('.palette'), input = $('input', el);
    pal = { el, input, sel: 0, items: [], prevFocus };
    const draw = () => {
      let q = input.value.trim(), only = null;
      if (q.startsWith('>')) { only = 'Actions'; q = q.slice(1).trim(); } else if (q.startsWith('@')) { only = 'Hosts'; q = q.slice(1).trim(); } else if (q.startsWith(';')) { only = 'Snippets'; q = q.slice(1).trim(); }
      let list = paletteItems().filter((x) => !only || x.group === only).map((x) => ({ ...x, m: fuzzy(q, x.label) || (q && x.sub ? (fuzzy(q, x.sub) ? { score: -10, idx: [] } : null) : null) })).filter((x) => x.m);
      if (!q && !only) list = list.filter((x) => (x.group !== 'Hosts' || ALL_HOSTS.find((h) => h.id === x.label).fav) && x.group !== 'Snippets');
      if (q) {
        // Nhóm có kết quả tốt nhất lên đầu; trong nhóm sắp theo điểm.
        const best = {}; list.forEach((x) => { best[x.group] = Math.max(best[x.group] ?? -1e9, x.m.score); });
        list.sort((a, b) => (best[b.group] - best[a.group]) || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || (b.m.score - a.m.score));
      }
      pal.items = list; pal.sel = Math.min(pal.sel, Math.max(0, list.length - 1));
      let g = null, html = '';
      list.forEach((x, i) => {
        if (x.group !== g) { g = x.group; html += `<div class="palette__group" role="presentation">${g === 'Hosts' && !q ? 'Favorite hosts' : g}</div>`; }
        html += `<div class="palette__item" role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === pal.sel}">${x.iconHtml || ic(x.icon, 16)}<span class="ellipsis" style="flex:none;max-width:60%${x.danger ? ';color:var(--danger)' : ''}">${hlText(x.label, x.m.idx)}</span>${x.sub ? `<span class="palette__sub">${esc(x.sub)}</span>` : ''}${x.env === 'prod' || x.k ? `<span class="row" style="margin-left:auto;gap:8px">${envDot(x.env)}${kbd(x.k)}</span>` : ''}</div>`;
      });
      $('#pal-list').innerHTML = html || `<div class="palette__empty"><div class="empty__title" style="font-size:13px">No results for “${esc(input.value)}”</div><div class="subtle" style="margin-top:4px">Try a host name, “pods”, or “>” for commands.</div></div>`;
      input.setAttribute('aria-activedescendant', list.length ? 'pal-' + pal.sel : '');
      const s = $(`#pal-${pal.sel}`); if (s) s.scrollIntoView({ block: 'nearest' });
    };
    pal.draw = draw;
    input.addEventListener('input', () => { pal.sel = 0; draw(); });
    $('#pal-list').addEventListener('mousemove', (e) => { const it = e.target.closest('.palette__item'); if (it && +it.dataset.i !== pal.sel) { pal.sel = +it.dataset.i; $$('.palette__item').forEach((x) => x.setAttribute('aria-selected', x.dataset.i == pal.sel)); } });
    $('#pal-list').addEventListener('click', (e) => { const it = e.target.closest('.palette__item'); if (it) runPal(+it.dataset.i); });
    $('[data-role="pal-overlay"]').addEventListener('mousedown', closePalette);
    draw(); input.focus();
  }
  function runPal(i) { const it = pal && pal.items[i]; closePalette(true); if (it && it.run) it.run(); }
  function closePalette(skipFocus) {
    if (!pal) return;
    const p = pal.prevFocus; pal.el.remove(); $('[data-role="pal-overlay"]').remove(); pal = null;
    if (!skipFocus && p && p.focus) p.focus();
  }
  function paletteKey(e) {
    if (!pal) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'n' || e.key === 'p'))) {
      e.preventDefault(); const n = pal.items.length; if (!n) return true;
      pal.sel = (pal.sel + (e.key === 'ArrowDown' || e.key === 'n' ? 1 : -1) + n) % n; pal.draw(); return true;
    }
    if (e.key === 'Enter') { e.preventDefault(); runPal(pal.sel); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return true; }
    if (e.key === 'Tab') { e.preventDefault(); return true; }
    return false;
  }

  /* ---------------------------------------------------------------- 9. Router + render */
  const k8sConn = { text: t('connected') + ' · prod-cluster · v1.30.4', kind: 'success' };
  const dockerRoute = (view, content, insp, crumbLabel) => () => ({ act: 'docker', env: 'staging', ex: exDocker(view), header: crumbs([{ iconHtml: ic('docker', 14), label: 'Docker', href: '#/docker' }, { label: 'build-server', switch: 'menu-endpoint', tip: 'Switch endpoint' }, { label: crumbLabel, href: '#/docker/' + view }]) + envBadge('staging'), actions: '', content: content(), inspector: insp, noInspectorToggle: !insp, conn: { text: t('connected') + ' · build-server · Engine 27.3', kind: 'success' } });
  const settingsRoute = (id) => () => {
    const label = (SETTINGS_SECTIONS.find((x) => x[0] === id) || [])[1];
    return { act: 'settings', ex: exSettings(id), header: crumbs([{ icon: 'settings', label: t('settings'), href: '#/settings/terminal' }, { label, href: '#/settings/' + id }]), actions: '', content: ctSettings(id), noInspectorToggle: true };
  };
  const ROUTES = {
    home: () => ({ act: 'home', ex: exHome(), header: crumbs([{ icon: 'home', label: t('home'), href: '#/home' }]), actions: '', content: ctHome(), noInspectorToggle: true }),
    hosts: () => ({ act: 'hosts', env: 'prod', ex: exHosts(state.multi ? 'multi' : state.panel === 'forwards' ? 'forwards' : ''), header: crumbs([{ icon: 'server', label: t('hosts'), href: '#/hosts' }, { label: 'Production', href: '#/hosts' }, state.multi ? { icon: 'radio', label: 'MultiExec', href: '#/hosts?multi=1' } : { iconHtml: ic(state.hostTab === 'rdp' ? 'windows' : 'ubuntu', 14), label: state.hostTab === 'rdp' ? 'prod-ad-01' : state.hostTab === 'logs' ? 'prod-lb-01' : 'prod-web-01', href: '#/hosts' }]) + envBadge('prod'), actions: btn({ label: 'Edit group', icon: 'sliders', variant: 'ghost', iconOnly: true, action: 'group-dialog' }) + btn({ label: 'New connection', icon: 'plus', variant: 'ghost', iconOnly: true, k: 'n', action: 'cmdk' }), content: ctHosts(), conn: { text: '6 ' + t('sessions') + ' · prod-web-01 18 ms', kind: 'success' }, noInspectorToggle: true }),
    files: () => ({ act: 'files', env: 'prod', ex: exFiles(), header: crumbs([{ icon: 'folder', label: 'Files', href: '#/files' }, { label: 'Local ⇄ prod-web-01', href: '#/files' }]) + envBadge('prod'), actions: '', content: ctFiles(), noInspectorToggle: true, conn: { text: 'SFTP · prod-web-01 · 18 ms', kind: 'success' } }),
    snippets: () => ({ act: 'hosts', ex: exHosts('snippets'), header: crumbs([{ icon: 'server', label: t('hosts'), href: '#/hosts' }, { label: 'Snippets', href: '#/snippets' }]), actions: '', content: ctSnippets(), inspector: inSnippet }),
    'k8s/pods': () => ({ act: 'k8s', env: 'prod', ex: exK8s('pods'), header: k8sHeader('Pods') + envBadge('prod'), actions: btn({ label: 'Create', icon: 'plus', variant: 'ghost', size: '', tipText: 'Apply manifest', k: 'n' }), content: ctPods(), inspector: inPod, conn: k8sConn }),
    'k8s/deployments': () => ({ act: 'k8s', env: 'prod', ex: exK8s('deployments'), header: k8sHeader('Deployments') + envBadge('prod'), actions: '', content: ctDeployments(), inspector: inDeploy, conn: k8sConn }),
    'k8s/helm': () => ({ act: 'k8s', env: 'prod', ex: exK8s('helm'), header: crumbs([{ icon: 'k8s', label: 'Kubernetes', href: '#/k8s/pods' }, { label: 'prod-cluster', switch: 'menu-context', tip: 'Switch context', k: 'mod+shift+K' }, { label: 'Helm releases', href: '#/k8s/helm' }]) + envBadge('prod'), actions: '', content: ctHelm(), inspector: inHelm, conn: k8sConn }),
    'k8s/topology': () => ({ act: 'k8s', env: 'prod', ex: exK8s('topology'), header: k8sHeader('Topology') + envBadge('prod'), actions: '', content: ctTopology(), conn: k8sConn, noInspectorToggle: true }),
    docker: () => ({ act: 'docker', env: 'staging', ex: exDocker(state.dockerView), header: crumbs([{ iconHtml: ic('docker', 14), label: 'Docker', href: '#/docker' }, { label: 'build-server', switch: 'menu-endpoint', tip: 'Switch endpoint' }, { label: state.dockerView === 'compose' ? 'Compose' : 'Containers', href: '#/docker' }]) + envBadge('staging'), actions: btn({ label: 'Run container', icon: 'play', variant: 'ghost', iconOnly: true, k: 'n' }), content: ctDocker(), inspector: inContainer, conn: { text: t('connected') + ' · build-server · Engine 27.3', kind: 'success' } }),
    'docker/overview': dockerRoute('overview', ctDockerOverview, null, 'Overview'),
    'docker/images': dockerRoute('images', ctImages, inImage, 'Images'),
    'docker/volumes': dockerRoute('volumes', ctVolumes, null, 'Volumes'),
    'docker/networks': dockerRoute('networks', ctNetworks, null, 'Networks'),
    s3: () => ({ act: 'storage', ex: exStorage(null), header: s3Crumbs([{ label: 'Buckets', href: '#/s3' }]), actions: '', content: ctBuckets(), conn: { text: t('connected') + ' · aws-media · ap-southeast-1', kind: 'success' }, noInspectorToggle: true }),
    's3/objects': () => ({ act: 'storage', ex: exStorage('shop-media-assets'), header: s3Crumbs([{ label: 'shop-media-assets', href: '#/s3/objects' }, { label: 'images', href: '#/s3/objects' }, { label: '2026', href: '#/s3/objects' }]), actions: btn({ label: 'Copy S3 URI', icon: 'copy', variant: 'ghost', iconOnly: true, tipText: 'Copy s3://shop-media-assets/images/2026/' }), content: ctObjects(), inspector: inObject, conn: { text: t('connected') + ' · aws-media · ap-southeast-1', kind: 'success' } }),
    transfers: () => ({ act: 'transfers', ex: exTransfers(), header: crumbs([{ icon: 'transfers', label: t('transfers'), href: '#/transfers' }]), actions: '', content: ctTransfers(), noInspectorToggle: true }),
    'settings/accounts': () => ({ act: 'settings', ex: exSettings('accounts'), header: crumbs([{ icon: 'settings', label: t('settings'), href: '#/settings/terminal' }, { label: t('accounts'), href: '#/settings/accounts' }]), actions: '', content: ctAccounts(), inspector: inAccount })
  };
  SETTINGS_SECTIONS.forEach(([id]) => { if (id !== 'accounts') ROUTES['settings/' + id] = settingsRoute(id); });

  function applyPrefs() {
    const b = document.body;
    b.dataset.theme = state.theme; b.dataset.density = state.density; b.dataset.os = state.os;
    document.documentElement.lang = state.lang;
  }
  function setPref(k, v) { state[k] = v; persist(); applyPrefs(); render(); }

  let lastRoute = null;
  function render() {
    applyPrefs();
    const make = ROUTES[state.route] || ROUTES.home;
    const scr = make();
    const app = $('#app');
    app.dataset.explorer = state.explorer ? 'open' : 'closed';
    renderTitlebar();
    renderActivityBar(scr.act);
    renderExplorer(scr.ex);
    const main = $('#main');
    if (scr.env === 'prod') main.dataset.env = 'prod'; else delete main.dataset.env;
    $('#main-header').innerHTML = scr.header + `<div class="header-actions">${scr.actions || ''}${scr.inspector ? btn({ label: 'Toggle inspector', icon: 'panel-right', variant: 'ghost', iconOnly: true, k: ']', action: 'toggle-inspector', attrs: `aria-pressed="${state.inspector}"` }) : ''}</div>`;
    const content = $('#content');
    const prevScroll = (lastRoute === state.route && $('.table-wrap', content)) ? $('.table-wrap', content).scrollTop : 0;
    content.innerHTML = scr.content;
    if (prevScroll && $('.table-wrap', content)) $('.table-wrap', content).scrollTop = prevScroll;
    const insp = $('#inspector');
    if (scr.inspector && state.inspector) { insp.classList.remove('hidden'); if (lastRoute !== state.route) insp.style.animation = ''; $('#inspector-inner').innerHTML = scr.inspector(); }
    else { insp.classList.add('hidden'); $('#inspector-inner').innerHTML = ''; }
    applyResponsive();
    renderStatusBar(scr);
    $$('[data-indeterminate]').forEach((c) => { c.indeterminate = true; });
    if (state.route === 'k8s/topology') setupGraph();
    lastRoute = state.route;
  }

  /* Cột tùy chọn: ẩn theo bề rộng thật của vùng nội dung (thay cho container query để colspan luôn đúng). */
  function applyResponsive() {
    const w = $('#content').clientWidth;
    $$('.dtable').forEach((tb) => {
      tb.classList.toggle('hide-opt-1', w < 1040);
      tb.classList.toggle('hide-opt-2', w < 900);
      tb.classList.toggle('no-tracks', w < 860);
      const hidden = (el) => (w < 1040 && el.classList.contains('col-opt-1')) || (w < 900 && el.classList.contains('col-opt-2'));
      const visible = $$('thead th', tb).filter((th) => !hidden(th)).length;
      $$('td[colspan]', tb).forEach((td) => {
        let start = 0; let sib = td.previousElementSibling;
        while (sib) { if (!hidden(sib)) start += +(sib.getAttribute('colspan') || 1); sib = sib.previousElementSibling; }
        td.setAttribute('colspan', Math.max(1, visible - start));
      });
    });
  }

  function parseHash() {
    const raw = (location.hash || '#/home').slice(2);
    const [path, query] = raw.split('?');
    let route = path || 'home';
    if (route === 'docker/compose') { state.dockerView = 'compose'; route = 'docker'; }
    else if (route === 'docker') state.dockerView = 'containers';
    else if (route.startsWith('docker/')) state.dockerView = route.split('/')[1];
    if (route === 'k8s') route = 'k8s/pods';
    if (route === 'settings' || route === 'settings/appearance-old') route = 'settings/terminal';
    if (route === 'settings/keyboard') route = 'settings/shortcuts';
    if (route === 'settings/vault') route = 'settings/security';
    if (route === 'hosts') { state.multi = false; }
    if (route === 'storage') route = 's3/objects';
    state.route = ROUTES[route] ? route : 'home';
    // Tham số demo (dùng cho ảnh chụp): ?theme=light&density=compact&itab=logs&select=3&split=1&tab=rdp&inspector=0&explorer=0
    if (query) {
      const q = new URLSearchParams(query);
      ['theme', 'density', 'lang', 'os'].forEach((k) => { if (q.get(k)) state[k] = q.get(k); });
      if (q.get('itab')) { const kind = { 'k8s/pods': 'pod', docker: 'container', 's3/objects': 'object', 'settings/accounts': 'account', 'k8s/deployments': 'deploy', 'k8s/helm': 'helm', 'docker/images': 'image', snippets: 'snippet' }[state.route]; if (kind) state.inspectorTab[kind] = q.get('itab'); }
      if (q.get('panel')) state.panel = q.get('panel');
      if (q.get('multi')) state.multi = q.get('multi') === '1';
      if (q.get('helm')) state.helmActive = q.get('helm');
      if (q.get('select')) { state.podSel = new Set(visiblePods().filter(isFailing).slice(0, +q.get('select')).map((p) => p.name)); }
      if (q.get('failing')) state.podFailing = true;
      if (q.get('split')) state.split = q.get('split') === '1';
      if (q.get('sftp')) state.panel = q.get('sftp') === '1' ? 'sftp' : 'none';
      if (q.get('tab')) state.hostTab = q.get('tab');
      if (q.get('inspector')) state.inspector = q.get('inspector') !== '0';
      if (q.get('explorer')) state.explorer = q.get('explorer') !== '0';
      if (q.get('problems')) { state.problemsAuto = false; state.problemsOpen = q.get('problems') === '1'; }
      if (q.get('container')) state.containerActive = q.get('container');
    }
  }

  /* ---------------------------------------------------------------- Actions (event delegation) */
  const ACTIONS = {
    'toggle-explorer': () => { state.explorer = !state.explorer; render(); },
    'toggle-inspector': () => { state.inspector = !state.inspector; render(); },
    'toggle-theme': () => setPref('theme', state.theme === 'dark' ? 'light' : 'dark'),
    'toggle-lang': () => setPref('lang', state.lang === 'en' ? 'vi' : 'en'),
    'set-pref': (el) => setPref(el.dataset.pref, el.dataset.val === 'system' ? 'dark' : el.dataset.val),
    cmdk: () => openPalette(),
    shortcuts: () => shortcutsDialog(),
    'toast-demo': (el) => toast('info', 'Not part of this prototype', (el.textContent || el.getAttribute('aria-label') || '').trim() + ' — interaction is out of scope'),
    'new-host': () => toast('info', 'New host', 'The host editor sheet would open here (N)'),
    'quick-connect': () => { location.hash = '#/hosts'; },
    'toggle-group': (el) => { const g = HOST_GROUPS.find((x) => x.id === el.dataset.id); g.open = !g.open; render(); },
    'open-rdp': () => { state.hostTab = 'rdp'; render(); },
    'open-term': () => { state.hostTab = 'term'; render(); },
    'host-tab': (el) => { state.hostTab = el.dataset.id; render(); },
    'toggle-split': () => { state.split = !state.split; render(); },
    'toggle-sftp': () => { state.panel = state.panel === 'sftp' ? 'none' : 'sftp'; render(); },
    'panel-sftp': () => { state.panel = state.panel === 'sftp' ? 'none' : 'sftp'; render(); },
    'panel-forwards': () => { state.panel = state.panel === 'forwards' ? 'none' : 'forwards'; render(); },
    'panel-none': () => { state.panel = 'none'; render(); },
    'multi-toggle': () => { state.multi = !state.multi; render(); },
    'multi-exit': (el, e) => { e.stopPropagation(); state.multi = false; if (location.hash.includes('multi=1')) location.hash = '#/hosts'; else render(); },
    'multi-all': () => { ['prod-web-01', 'prod-web-02', 'stg-web-01', 'prod-db-01'].forEach((h) => state.multiOn.add(h)); render(); },
    'multi-none': () => { state.multiOn.clear(); render(); },
    'multi-pick': (el) => { const h = el.dataset.host; state.multiOn.has(h) ? state.multiOn.delete(h) : state.multiOn.add(h); render(); },
    'go-files': () => { location.hash = '#/files'; },
    'go-editor': () => { state.hostTab = 'logs'; location.hash = '#/hosts'; },
    'go-pod': () => { state.podActive = 'web-7d9f8c6b5-h8sdl'; state.inspector = true; location.hash = '#/k8s/pods'; },
    'group-dialog': (el) => groupDialog(el.closest('[data-group]') ? el.closest('[data-group]').dataset.group : 'prod'),
    workspaces: () => workspacesDialog(),
    'snippet-palette': () => openPalette(';'),
    'snippet-run': (el, e) => { e.stopPropagation(); snippetRun(el.dataset.id); },
    'pull-dialog': () => pullDialog(),
    'build-dialog': () => buildDialog(),
    'sync-dialog': () => syncDialog(),
    'yaml-diff': () => yamlDiffDialog(),
    'diff-demo': () => yamlDiffDialog(),
    'rollback-dialog': (el) => rollbackDialog(+el.dataset.rev || 13),
    'delete-web': () => confirmDeleteWeb(),
    'helm-uninstall': () => confirmAction({ level: 3, kind: 'Helm release', name: state.helmActive, env: 'prod', scope: 'prod-cluster', impact: [['layers', 'All resources created by the chart are deleted'], ['history', 'Release history is removed (no rollback)']] }),
    'helm-menu': (el, e) => { e.stopPropagation(); const n = el.closest('tr').dataset.hrow; state.helmActive = n; anchorMenu(el, [{ label: 'Revisions', icon: 'history' }, { label: 'Diff with previous', icon: 'diff', run: () => rollbackDialog() }, { label: 'Roll back…', icon: 'history', run: () => rollbackDialog() }, { label: 'Upgrade…', icon: 'upload' }, { sep: true }, { label: 'Uninstall…', icon: 'trash', danger: true, run: () => ACTIONS['helm-uninstall']() }]); },
    'image-menu': (el, e) => { e.stopPropagation(); anchorMenu(el, [{ label: 'Run…', icon: 'play' }, { label: 'Tag…', icon: 'tag' }, { label: 'Push', icon: 'upload' }, { label: 'Copy ID', icon: 'copy', k: 'C' }, { sep: true }, { label: 'Remove image…', icon: 'trash', danger: true, run: () => confirmAction({ level: 2, kind: 'Image', name: 'registry.shop.vn/api:5.1.4', env: 'staging', scope: 'build-server', impact: [['archive', 'No container uses this image']] }) }]); },
    'menu-proto': (el) => anchorMenu(el, [{ group: 'Protocol' }, { label: 'SSH', icon: 'terminal-square', checked: true }, { label: 'Telnet', icon: 'terminal' }, { label: 'Serial (COM / tty)', icon: 'plug' }, { label: 'RDP', iconHtml: ic('windows', 14) }, { sep: true }, { label: 'Local shell', icon: 'laptop' }]),
    'term-menu': (el) => anchorMenu(el, [{ label: 'Duplicate tab', icon: 'copy' }, { label: 'Open SFTP in file manager', icon: 'columns', run: () => { location.hash = '#/files'; } }, { label: 'Deploy SSH key…', icon: 'key' }, { label: 'Session log', icon: 'record', meta: 'On' }, { label: 'Attach tmux session…', icon: 'panel-bottom' }, { sep: true }, { label: 'Clear scrollback', icon: 'x' }, { label: 'Disconnect', icon: 'plug', k: 'mod+shift+W' }]),
    'bucket-menu': (el) => anchorMenu(el, [{ group: 'shop-media-assets' }, { label: 'Stats (size by prefix & class)', icon: 'gauge' }, { label: 'Lifecycle rules', icon: 'clock', meta: '2 rules' }, { label: 'CORS', icon: 'globe' }, { label: 'Bucket policy', icon: 'shield' }, { label: 'Versioning', icon: 'history', meta: 'On' }, { label: 'Tags', icon: 'tag' }, { sep: true }, { label: 'Empty bucket…', icon: 'trash', danger: true }]),
    'nav-back': () => history.back(), 'nav-fwd': () => history.forward(), noop: () => {},
    'toggle-failing': () => { state.podFailing = !state.podFailing; state.podFocus = -1; render(); },
    'clear-filters': () => { state.podFailing = false; state.podFilter = ''; render(); },
    'clear-sel': () => { state.podSel.clear(); render(); },
    sort: (el) => { const k = el.dataset.key; state.podSort = { key: k, dir: state.podSort.key === k && state.podSort.dir === 'asc' ? 'desc' : 'asc' }; render(); },
    'row-check': (el, e) => { e.stopPropagation(); const n = el.closest('tr').dataset.row; state.podSel.has(n) ? state.podSel.delete(n) : state.podSel.add(n); render(); },
    'crow-check': (el, e) => { e.stopPropagation(); const n = el.closest('tr').dataset.crow; state.containerSel.has(n) ? state.containerSel.delete(n) : state.containerSel.add(n); render(); },
    'check-all': () => { const rows = visiblePods(); const all = rows.every((r) => state.podSel.has(r.name)); rows.forEach((r) => all ? state.podSel.delete(r.name) : state.podSel.add(r.name)); render(); },
    'bulk-copy': () => toast('success', `Copied ${state.podSel.size} names`, Array.from(state.podSel).join(', ')),
    'bulk-restart': () => { toast('success', `Restarting ${state.podSel.size} Pods`, 'Controllers will recreate them', { label: 'Undo', run: () => {} }); },
    'bulk-delete': () => confirmAction({ level: 3, kind: 'Pod', name: Array.from(state.podSel).join(', '), count: state.podSel.size, env: 'prod', impact: [['pod', 'Pods owned by a controller are recreated automatically'], ['alert', 'Standalone Pods are gone for good']], onConfirm: () => { state.podSel.clear(); render(); } }),
    'delete-pod': () => confirmAction({ level: 3, kind: 'Pod', name: state.podActive, env: 'prod', impact: [['workload', 'Deployment <b>web</b> will create a replacement Pod'], ['alert', 'In-flight requests on this Pod are dropped']] }),
    'delete-container': () => confirmAction({ level: 2, kind: 'Container', name: state.containerActive, env: 'staging', impact: [['bucket', 'Anonymous volumes are kept'], ['layers', 'Compose will recreate it on next <span class="code-inline">up</span>']] }),
    'delete-object': () => confirmAction({ level: 2, kind: 'Object', name: state.objActive, impact: [['history', 'Versioning is on — a delete marker is added; older versions stay restorable']] }),
    'delete-account': () => confirmAction({ level: 2, kind: 'Account', name: state.accountActive, impact: [['server', 'Hosts using this account will ask for credentials on next connect']] }),
    itab: (el) => { state.inspectorTab[el.dataset.kind] = el.dataset.id; render(); const tb = $(`.tab[data-id="${el.dataset.id}"]`); if (tb) tb.focus(); },
    'itab-logs': () => { state.inspectorTab.pod = 'logs'; render(); },
    'reveal-env': (el) => { const k = el.dataset.key; state.envReveal.has(k) ? state.envReveal.delete(k) : state.envReveal.add(k); render(); },
    copy: () => toast('success', 'Copied to clipboard'),
    'copy-link': () => toast('success', 'Presigned URL copied', 'Expires in 24 hours'),
    seg: (el) => { $$('[role="radio"]', el.parentElement).forEach((x) => x.setAttribute('aria-checked', x === el)); },
    switch: (el) => el.setAttribute('aria-checked', el.getAttribute('aria-checked') !== 'true'),
    upload: () => startUpload(),
    'zoom-in': () => zoomBy(0.1), 'zoom-out': () => zoomBy(-0.1), 'zoom-fit': () => fitGraph(true),
    'toggle-problems': () => { state.problemsAuto = false; state.problemsOpen = !state.problemsOpen; const g = $('[data-role="graph"]'); const p = $('.graph-problems', g); p.outerHTML = problemsPanel(); },
    notifications: (el) => anchorMenu(el, [{ group: 'Notifications' }, { label: 'web-7d9f… is crash-looping', icon: 'alert-circle', meta: '2m', run: () => { location.hash = '#/k8s/pods'; } }, { label: 'Upload finished: catalog-q4.pdf', icon: 'check-circle', meta: '12m' }, { label: 'shop.vn certificate expires in 9 days', icon: 'certificate', meta: '1h' }, { sep: true }, { label: 'Mark all as read', icon: 'check', run: () => { state.notifications = 0; render(); } }]),
    'vault-menu': (el) => anchorMenu(el, [{ group: 'hieu@shellhouse · Vault unlocked' }, { label: 'Lock vault now', icon: 'lock', k: 'mod+shift+L', run: () => toast('info', 'Vault locked', 'Credentials cleared from memory') }, { label: 'Auto-lock after', icon: 'clock', meta: '15 min' }, { label: 'Security & backup…', icon: 'shield', run: () => { location.hash = '#/settings/security'; } }, { sep: true }, { label: 'Accounts', icon: 'users', run: () => { location.hash = '#/settings/accounts'; } }, { label: 'Appearance', icon: 'sun', run: () => { location.hash = '#/settings/appearance'; } }, { label: 'Keyboard shortcuts', icon: 'keyboard', k: '?', run: shortcutsDialog }]),
    'menu-context': (el) => anchorMenu(el, [{ group: 'Contexts (kubeconfig)' }, ...CLUSTERS.map((c) => ({ label: c.id, icon: 'k8s', meta: c.env.toUpperCase(), checked: undefined, run: () => toast('info', 'Switched context', c.id) })), { sep: true }, { label: 'Manage clusters…', icon: 'settings' }]),
    'menu-endpoint': (el) => anchorMenu(el, DOCKER_ENDPOINTS.map((d) => ({ label: d.name, iconHtml: ic('docker', 14), meta: d.meta.split('://')[0] }))),
    'menu-s3acct': (el) => anchorMenu(el, S3_ACCOUNTS.map((a) => ({ label: a.name, iconHtml: ic(a.prov, 14), meta: a.meta.split(' · ')[0] }))),
    'menu-ns': (el) => anchorMenu(el, [{ group: 'Namespaces' }, ...['shop', 'payments', 'monitoring', 'kube-system', 'default'].map((n) => ({ label: n, checked: n === 'shop' || n === 'payments' })), { sep: true }, { label: 'All namespaces', icon: 'globe', k: 'shift+A' }]),
    'menu-columns': (el) => anchorMenu(el, [{ group: 'Columns' }, ...POD_COLS.filter((c) => !c.fixed).map((c) => ({ label: c.label, checked: state.podCols[c.key], run: (v) => { state.podCols[c.key] = v; render(); } })), { sep: true }, { label: 'Reset to default', icon: 'restart', run: () => { Object.keys(state.podCols).forEach((k) => (state.podCols[k] = true)); render(); } }]),
    'menu-view': (el) => anchorMenu(el, [{ group: 'Show' }, { label: 'Entry (Ingress)', checked: true }, { label: 'Pods', checked: true }, { label: 'Problem paths only', checked: false }, { sep: true }, { group: 'Layout' }, { label: 'Group by workload', checked: true }, { label: 'Compact cards', checked: false }, { sep: true }, { label: 'Fit to screen', icon: 'maximize', k: 'shift+1', run: () => fitGraph(true) }, { label: 'Export as SVG', icon: 'download' }]),
    'compose-menu': (el) => anchorMenu(el, [{ label: 'Pull images', icon: 'download' }, { label: 'Recreate', icon: 'refresh' }, { label: 'Open compose file', icon: 'file-code' }, { sep: true }, { label: 'Down (remove containers)…', icon: 'trash', danger: true, run: () => confirmAction({ level: 2, kind: 'Compose project', name: el.dataset.project, env: 'staging', impact: [['container', 'All containers in the project are removed'], ['bucket', 'Named volumes are kept']] }) }]),
    'row-menu': (el, e) => { e.stopPropagation(); const r = el.getBoundingClientRect(); const tr = el.closest('tr'); openMenu(r.right - 220, r.bottom + 4, resourceMenu(tr.dataset.row ? 'Pod' : tr.dataset.crow ? 'Container' : 'Object', tr.dataset.row || tr.dataset.crow || tr.dataset.orow || ''), el); },
    'inspector-menu': (el) => anchorMenu(el, resourceMenu(state.route === 'k8s/pods' ? 'Pod' : 'Resource', state.podActive).slice(2))
  };

  function startUpload() {
    toast('info', 'Uploading 1 file', 'hero-autumn@2x.jpg → shop-media-assets/images/2026/');
    const tr = state.transfers[0];
    if (state.uploadTimer) return;
    state.uploadTimer = setInterval(() => {
      tr.pct = Math.min(100, tr.pct + 7);
      const bars = $$('.progress__bar');
      renderStatusBar((ROUTES[state.route] || ROUTES.home)());
      if (state.route === 's3/objects') { const cell = $(`tr[data-orow="hero-autumn@2x.jpg"] .progress__bar`); if (cell) { cell.style.width = tr.pct + '%'; cell.parentElement.nextElementSibling.textContent = tr.pct + '%'; } }
      if (tr.pct >= 100) { clearInterval(state.uploadTimer); state.uploadTimer = null; state.transfers.shift(); OBJECTS[4].uploading = false; OBJECTS[4].modified = 'Just now'; toast('success', 'Upload complete', 'hero-autumn@2x.jpg · 6.1 MB'); render(); }
      void bars;
    }, 400);
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (menuState && !e.target.closest('.menu')) closeMenu(false);
    if (a && !a.closest('.menu')) { hideTip(); const fn = ACTIONS[a.dataset.action]; if (fn) { e.preventDefault(); fn(a, e); } return; }
    const tr = e.target.closest('tbody tr');
    if (tr) {
      if (tr.dataset.href) { location.hash = tr.dataset.href; return; }
      if (tr.dataset.row) { state.podActive = tr.dataset.row; state.inspector = true; state.podFocus = +tr.dataset.idx; render(); }
      else if (tr.dataset.crow) { state.containerActive = tr.dataset.crow; state.inspector = true; render(); }
      else if (tr.dataset.orow) { const o = OBJECTS.find((x) => x.name === tr.dataset.orow); if (o.folder) toast('info', 'Opening ' + o.name); else { state.objActive = o.name; state.inspector = true; render(); } }
      else if (tr.dataset.arow) { state.accountActive = tr.dataset.arow; state.inspector = true; render(); }
      else if (tr.dataset.srow) { state.snippetActive = tr.dataset.srow; state.inspector = true; render(); }
      else if (tr.dataset.irow) { state.imageActive = tr.dataset.irow; state.inspector = true; render(); }
      else if (tr.dataset.hrow) { state.helmActive = tr.dataset.hrow; state.inspector = true; render(); }
      else if (tr.dataset.drow) { state.inspector = true; render(); }
    }
  });
  document.addEventListener('submit', (e) => { const f = e.target.closest('[data-action-submit]'); if (f) { e.preventDefault(); ACTIONS[f.dataset.actionSubmit](); } });
  document.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tbody tr[data-row], tbody tr[data-crow], tbody tr[data-orow]');
    if (!tr) return;
    e.preventDefault();
    if (tr.dataset.row) { state.podActive = tr.dataset.row; }
    openMenu(e.clientX, e.clientY, resourceMenu(tr.dataset.row ? 'Pod' : tr.dataset.crow ? 'Container' : 'Object', tr.dataset.row || tr.dataset.crow || tr.dataset.orow));
  });
  document.addEventListener('input', (e) => {
    const r = e.target.dataset.role;
    if (r === 'table-filter' && state.route === 'k8s/pods') { state.podFilter = e.target.value; state.podFocus = -1; render(); const i = $('[data-role="table-filter"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    if (r === 'log-search') { state.logQuery = e.target.value; const pos = e.target.selectionStart; render(); const i = $('[data-role="log-search"]'); i.focus(); i.setSelectionRange(pos, pos); }
    if (r === 'graph-filter') { const q = e.target.value.toLowerCase(); $$('.gnode').forEach((n) => n.classList.toggle('is-dim', !!q && !n.title.toLowerCase().includes(q))); }
  });
  document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip]'); if (el && el !== tipEl) showTip(el); });
  document.addEventListener('mouseout', (e) => { const el = e.target.closest('[data-tip]'); if (el && !el.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && e.target.matches(':focus-visible')) showTip(el, true); else hideTip(); });
  document.addEventListener('mousedown', hideTip);

  /* Resizers */
  document.addEventListener('mousedown', (e) => {
    const r = e.target.closest('.resizer'); if (!r) return;
    e.preventDefault(); r.dataset.dragging = 'true';
    const which = r.dataset.resize, app = $('#app'), main = $('#main');
    const startX = e.clientX;
    const startW = which === 'explorer' ? $('#explorer').getBoundingClientRect().width : $('#inspector').getBoundingClientRect().width;
    const move = (ev) => {
      const d = ev.clientX - startX;
      if (which === 'explorer') app.style.setProperty('--explorer-w', Math.max(200, Math.min(420, startW + d)) + 'px');
      else main.style.setProperty('--inspector-w', Math.max(320, Math.min(640, startW - d)) + 'px');
    };
    const up = () => { delete r.dataset.dragging; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); if (state.route === 'k8s/topology') fitGraph(true); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });

  /* ---------------------------------------------------------------- 8. Keyboard */
  let gPending = false, gTimer = null;
  const inField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  function movePodFocus(d) {
    const rows = visiblePods(); if (!rows.length) return;
    state.podFocus = Math.max(0, Math.min(rows.length - 1, (state.podFocus < 0 ? (d > 0 ? -1 : 0) : state.podFocus) + d));
    render();
    const tr = $(`tr[data-idx="${state.podFocus}"]`); if (tr) { tr.focus(); tr.scrollIntoView({ block: 'nearest' }); }
  }
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); pal ? closePalette() : openPalette(); return; }
    if (paletteKey(e)) return;
    const ti = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tree__item');
    if (ti && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const items = $$('#explorer-body .tree__item'); let i = items.indexOf(ti);
      i = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((x) => x.setAttribute('tabindex', '-1')); items[i].setAttribute('tabindex', '0'); items[i].focus(); return;
    }
    if (menuState && menuKey(e)) return;
    if (dialogState) { if (e.key === 'Escape') { e.preventDefault(); closeDialog(); } else if (e.key === 'Tab') trapFocus(e, dialogState.el); return; }
    if (inField(document.activeElement)) { if (e.key === 'Escape') { document.activeElement.blur(); } return; }
    if (e.altKey && e.key.toLowerCase() === 't' || e.altKey && e.code === 'KeyT') { e.preventDefault(); ACTIONS['toggle-theme'](); return; }
    if (state.route === 'hosts' && e.altKey && /^[1-3]$/.test(e.key)) { state.multi = false; state.hostTab = ['term', 'rdp', 'logs'][+e.key - 1]; render(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); state.multi = !state.multi; if (state.route !== 'hosts') location.hash = '#/hosts' + (state.multi ? '?multi=1' : ''); else render(); return; }
    if (mod && e.key === '\\') { e.preventDefault(); ACTIONS['toggle-split'](); return; }
    if (mod && e.key === ',') { e.preventDefault(); location.hash = '#/settings/terminal'; return; }
    if (mod && (e.key === 'Backspace' || e.key === 'Delete') && state.route === 'k8s/pods') { e.preventDefault(); state.podSel.size ? ACTIONS['bulk-delete']() : ACTIONS['delete-pod'](); return; }
    if (mod || e.altKey) return;
    if (gPending) {
      gPending = false; clearTimeout(gTimer);
      const map = { h: 'home', s: 'hosts', f: 'files', k: 'k8s/pods', d: 'docker', b: 's3/objects', t: 'transfers' };
      if (map[e.key]) { e.preventDefault(); location.hash = '#/' + map[e.key]; }
      return;
    }
    switch (e.key) {
      case 'g': gPending = true; gTimer = setTimeout(() => (gPending = false), 900); return;
      case '/': { const f = $('[data-role="table-filter"], [data-role="graph-filter"]'); if (f) { e.preventDefault(); f.focus(); f.select(); } return; }
      case '?': e.preventDefault(); shortcutsDialog(); return;
      case '[': ACTIONS['toggle-explorer'](); return;
      case ']': ACTIONS['toggle-inspector'](); return;
      case 'Escape':
        if (state.podSel.size && state.route === 'k8s/pods') { state.podSel.clear(); render(); return; }
        if (state.route === 'k8s/topology') { state.graphSelected = null; $$('.gnode').forEach((n) => n.classList.remove('is-selected')); return; }
        if (state.inspector && $('#inspector:not(.hidden)')) { state.inspector = false; render(); }
        return;
    }
    if (state.route === 'k8s/pods') {
      const rows = visiblePods();
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); movePodFocus(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); movePodFocus(-1); }
      else if (e.key === 'x' && state.podFocus >= 0) { const n = rows[state.podFocus].name; state.podSel.has(n) ? state.podSel.delete(n) : state.podSel.add(n); render(); const tr = $(`tr[data-idx="${state.podFocus}"]`); tr && tr.focus(); }
      else if (e.key === 'Enter' && state.podFocus >= 0) { state.podActive = rows[state.podFocus].name; state.inspector = true; render(); const tr = $(`tr[data-idx="${state.podFocus}"]`); tr && tr.focus(); }
      else if (e.key === 'l' || e.key === 'L') { state.inspectorTab.pod = 'logs'; state.inspector = true; render(); }
      else if (e.key === 'R' && e.shiftKey) { state.podSel.size ? ACTIONS['bulk-restart']() : restartDemo(state.podActive); }
      else if (e.key === 'c' && state.podSel.size) ACTIONS['bulk-copy']();
    }
    if (state.route === 'k8s/topology') {
      if (e.key === '+' || e.key === '=') zoomBy(0.1);
      else if (e.key === '-') zoomBy(-0.1);
      else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) fitGraph(true);
    }
    if (e.key === 'n' && !e.shiftKey) ACTIONS['new-host']();
  });

  window.addEventListener('hashchange', () => { parseHash(); hideTip(); closeMenu(false); closeDialog(); render(); const c = $('#content'); if (c && document.activeElement === document.body) c.focus({ preventScroll: true }); });
  let rsT; window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { applyResponsive(); if (state.route === 'k8s/topology') fitGraph(false); }, 120); });

  /* Init */
  parseHash();
  render();
  window.SH = { state, render, openPalette, toast, confirmDeleteWeb, shortcutsDialog, openMenu, resourceMenu, groupDialog, yamlDiffDialog, rollbackDialog, pullDialog, buildDialog, syncDialog, snippetRun, workspacesDialog };
})();
