/** Bản dịch tiếng Việt — Kubernetes: Map, Topology, Traffic. Khoá = chuỗi tiếng Anh trong code (xem src/shared/i18n/index.ts). */
export const k8sMap: Readonly<Record<string, string>> = {
  // ——— Map: thanh công cụ, menu View ———
  Topology: 'Topology',
  View: 'View',
  'Find on map…  ( / )': 'Tìm trên map…  ( / )',
  'Find on map': 'Tìm trên map',
  collapsed: 'đang gập',
  'Show only workloads whose pod labels match — e.g. tier=backend, app.kubernetes.io/part-of=shop, env in (prod,staging), !canary':
    'Chỉ hiện workload có label của pod khớp — vd. tier=backend, app.kubernetes.io/part-of=shop, env in (prod,staging), !canary',
  'Filter by label: tier=backend': 'Lọc theo label: tier=backend',
  'Filter by label': 'Lọc theo label',
  'Clear label filter': 'Xoá bộ lọc label',
  'Go to the next problem': 'Tới vấn đề tiếp theo',
  'Nodes ready: {ready} of {total}': 'Node Ready: {ready}/{total}',
  'Group namespaces': 'Gom namespace',
  'Label key, e.g. team': 'Label key, vd. team',
  'Group by label key': 'Gom theo label key',
  'Group namespaces into regions': 'Gom namespace thành vùng',
  'by purpose': 'theo mục đích',
  'by name prefix': 'theo prefix của tên',
  'by {key}': 'theo {key}',
  'by label…': 'theo label…',
  'System namespaces': 'Namespace hệ thống',
  Connections: 'Kết nối',
  'Route → Service → workload → volume': 'Route → Service → workload → volume',
  'Problems only': 'Chỉ xem vấn đề',
  'Dim everything that is healthy': 'Làm mờ những gì đang Healthy',
  'Dark canvas': 'Nền tối',
  'Dark background for the map, whatever the app theme': 'Nền tối cho map, bất kể theme của app',
  'Expand all': 'Mở hết',
  'Collapse all': 'Gập hết',
  'Updated {time}': 'Cập nhật lúc {time}',
  'This cluster is very large — only part of it is on the map. Pick fewer namespaces.':
    'Cluster quá lớn — map chỉ có một phần. Hãy chọn ít namespace hơn.',
  'Cluster map — drag to move, scroll to zoom, click to select':
    'Cluster map — kéo để di chuyển, cuộn để zoom, bấm để chọn',
  'Drawing the cluster map…': 'Đang vẽ cluster map…',
  'Zoom out ( - )': 'Thu nhỏ ( - )',
  'Zoom in ( + )': 'Phóng to ( + )',
  'Fit the whole cluster ( 0 )': 'Vừa khung toàn bộ cluster ( 0 )',
  Healthy: 'Healthy',
  traffic: 'traffic',
  '{n} degraded': '{n} Degraded',
  '{n} failing': '{n} Failing',
  '{ok} healthy, {warn} degraded, {bad} failing': '{ok} Healthy, {warn} Degraded, {bad} Failing',
  'Ready / desired pods': 'Pod Ready / desired',
  Applications: 'Applications',
  'Ingress & networking': 'Ingress & networking',
  Monitoring: 'Monitoring',
  Expand: 'Mở rộng',
  Collapse: 'Thu gọn',

  // ——— Map: bảng bên phải, thẻ nổi ———
  'Show resources': 'Xem resource',
  'Open details': 'Mở chi tiết',
  Center: 'Căn giữa',
  'In / out': 'Vào / ra',
  Affected: 'Bị ảnh hưởng',
  Showing: 'Đang hiện',
  'Show on map': 'Hiện trên map',
  'Nothing else on the map depends on it.': 'Không có gì khác trên map phụ thuộc vào nó.',
  'If it changes or fails: {list}.': 'Nếu nó thay đổi hoặc lỗi: {list}.',
  'Receives traffic from': 'Nhận traffic từ',
  'Applies to': 'Áp dụng cho',
  'Linked from': 'Được nối từ',
  'Sends traffic to': 'Gửi traffic tới',
  'Routes to': 'Định tuyến tới',
  'Routes attached': 'Route gắn vào',
  Uses: 'Uses',
  'Network policies': 'NetworkPolicy',
  In: 'Thuộc',
  requested: 'đã request',
  'No live CPU / memory (metrics-server not available).':
    'Không có CPU / memory live (không có metrics-server).',
  '{n} service': '{n} service',
  '{n} services': '{n} service',
  '{n} route': '{n} route',
  '{n} routes': '{n} route',
  '{n} workload': '{n} workload',
  '{n} workloads': '{n} workload',
  '{n} volume': '{n} volume',
  '{n} volumes': '{n} volume',
  '{n} gateway': '{n} gateway',
  '{n} gateways': '{n} gateway',
  '{n} policy': '{n} policy',
  '{n} policies': '{n} policy',
  'Standalone pods': 'Pod lẻ',
  'Can’t read “{part}” — use key=value, key!=value, key in (a,b), key or !key':
    'Không đọc được “{part}” — dùng key=value, key!=value, key in (a,b), key hoặc !key',

  // ——— Traffic (Caretta) ———
  'Show live traffic': 'Hiện traffic live',
  'Rates between workloads measured by Caretta (eBPF) — optional':
    'Tốc độ giữa các workload do Caretta (eBPF) đo — tuỳ chọn',
  'Off — the topology does not need it.': 'Đang tắt — Topology không cần đến nó.',
  'Live from {n} Caretta agents · updated {when}': 'Live từ {n} agent Caretta · cập nhật {when}',
  'Measuring traffic from Caretta…': 'Đang đo traffic từ Caretta…',
  'Not available — {reason}.': 'Không có — {reason}.',
  'Caretta is not installed': 'Chưa cài Caretta',
  'To see traffic, install Caretta (no Prometheus needed):':
    'Để xem traffic, cài Caretta (không cần Prometheus):',
  'Copy command': 'Sao chép lệnh',
  'Live traffic': 'Traffic live',
  'Unavailable — {reason}.': 'Không có — {reason}.',
  'No traffic observed in the last minute.': 'Không thấy traffic trong phút vừa qua.',
  'Called by': 'Được gọi bởi',
  Calls: 'Gọi tới',
  'No live traffic data': 'Không có dữ liệu traffic live',
  '{reason}. The service map is drawn from Caretta (eBPF) — no Prometheus or sidecars needed. The Topology view works without it.':
    '{reason}. Service map được vẽ từ Caretta (eBPF) — không cần Prometheus hay sidecar. Topology vẫn dùng được khi không có nó.',
  'Caretta is running but saw no connections in the last minute.':
    'Caretta đang chạy nhưng không thấy kết nối nào trong phút vừa qua.',
  'updated {when}': 'cập nhật {when}',
  'Hide idle': 'Ẩn kết nối idle',
  'Open {kind}': 'Mở {kind}',
  '{n} Caretta agent': '{n} agent Caretta',
  '{n} Caretta agents': '{n} agent Caretta',
  idle: 'idle',
  'outside the cluster': 'ngoài cluster',
  'live traffic': 'traffic live',
  'via Ingress {names}': 'qua Ingress {names}',
  'Live traffic (Caretta): in / out': 'Traffic live (Caretta): vào / ra',

  // ——— Topology tĩnh ———
  Entry: 'Entry',
  Routes: 'Routes',
  Services: 'Services',
  Workloads: 'Workloads',
  'Config & storage': 'Config & storage',
  'Where traffic enters the cluster: Gateways (their routes nested below), Ingresses, LoadBalancer and NodePort Services':
    'Nơi traffic đi vào cluster: Gateway (route xếp ngay dưới), Ingress, Service LoadBalancer và NodePort',
  'Gateway API routes (HTTPRoute, GRPCRoute)': 'Route của Gateway API (HTTPRoute, GRPCRoute)',
  'Services: port → targetPort and how many endpoints are ready':
    'Service: port → targetPort và số endpoint Ready',
  'Deployments, StatefulSets, DaemonSets, Jobs and CronJobs':
    'Deployment, StatefulSet, DaemonSet, Job và CronJob',
  'Pods of each workload — failing ones first': 'Pod của từng workload — pod lỗi lên trước',
  'ConfigMaps, Secrets and volumes the pods need to start':
    'ConfigMap, Secret và volume mà pod cần để khởi động',
  'Find by name or label…  ( / )': 'Tìm theo tên hoặc label…  ( / )',
  'Find on the topology': 'Tìm trên Topology',
  hidden: 'đang ẩn',
  '{n} problem': '{n} vấn đề',
  '{n} problems': '{n} vấn đề',
  'Highlight problems': 'Làm nổi bật vấn đề',
  'No problems found': 'Không thấy vấn đề',
  'Path of {name}': 'Đường đi của {name}',
  'Show everything': 'Hiện tất cả',
  'Show everything ( Esc )': 'Hiện tất cả ( Esc )',
  'Config & storage lane': 'Làn Config & storage',
  'ConfigMaps, Secrets and volumes each workload needs':
    'ConfigMap, Secret và volume mà mỗi workload cần',
  'Topology — scroll to move, Ctrl + scroll to zoom, click to select':
    'Topology — cuộn để di chuyển, Ctrl + cuộn để zoom, bấm để chọn',
  'Mapping the topology…': 'Đang dựng Topology…',
  'Nothing to show in these namespaces. Pick other namespaces, or show system namespaces in View.':
    'Không có gì để hiện trong các namespace này. Chọn namespace khác, hoặc bật namespace hệ thống trong View.',
  'Nothing to show in these namespaces.': 'Không có gì để hiện trong các namespace này.',
  'Request path': 'Request path',
  Broken: 'Broken',
  'Fit everything ( 0 )': 'Vừa toàn bộ ( 0 )',
  'Reset layout': 'Reset layout',
  '{n} hidden': '{n} đang ẩn',
  '{n} entry point': '{n} entry point',
  '{n} entry points': '{n} entry point',
  '{n} warning': '{n} cảnh báo',
  '{n} warnings': '{n} cảnh báo',
  'Expand namespace': 'Mở namespace',
  'Collapse namespace': 'Gập namespace',
  'Collapse pod list': 'Gập danh sách pod',
  'Show every pod': 'Hiện từng pod',
  'No pods': 'Không có pod',
  'not ready': 'Not ready',
  '+{n} more pod': '+{n} pod nữa',
  '+{n} more pods': '+{n} pod nữa',
  Isolated: 'Isolated',
  failing: 'Failing',
  degraded: 'Degraded',

  // ——— Topology: bảng chi tiết ———
  'Focus on its path': 'Chỉ xem đường đi của nó',
  'Port-forward…': 'Port-forward…',
  Problems: 'Vấn đề',
  'Comes from': 'Đến từ',
  Needs: 'Cần',
  Runs: 'Chạy',
  'Installed by': 'Cài bằng',
  'none — endpoints are managed manually': 'không có — endpoint quản lý thủ công',
  Endpoints: 'Endpoints',
  'default certificate': 'chứng chỉ mặc định',
  'default backend': 'backend mặc định',
  'Click a pod for its logs and shell.': 'Bấm một pod để xem log và mở shell.',
  'Entry points': 'Entry points',
  'Running, not ready': 'Running, Not ready',
  'In {in} · out {out} · updated {when}': 'Vào {in} · ra {out} · cập nhật {when}',
  '{min}–{max} replicas, now {current}': '{min}–{max} replica, hiện {current}',

  // ——— Topology: vấn đề (giải thích bằng lời) ———
  'Schedule {schedule}': 'Lịch {schedule}',
  'Job failed': 'Job thất bại',
  'No pods ready ({ready}/{desired})': 'Không có pod nào Ready ({ready}/{desired})',
  'Only {ready} of {desired} pods ready': 'Chỉ {ready}/{desired} pod Ready',
  'HorizontalPodAutoscaler {name}: {current} replicas now':
    'HorizontalPodAutoscaler {name}: hiện {current} replica',
  'HPA {name} is at its maximum ({max} replicas) — it cannot scale further':
    'HPA {name} đã ở mức max ({max} replica) — không scale thêm được nữa',
  'PersistentVolumeClaim {name} not found': 'Không tìm thấy PersistentVolumeClaim {name}',
  'PersistentVolumeClaim {name} is {status}': 'PersistentVolumeClaim {name} đang {status}',
  'not bound': 'chưa Bound',
  'ConfigMap {name} not found': 'Không tìm thấy ConfigMap {name}',
  'Secret {name} not found': 'Không tìm thấy Secret {name}',
  'All inbound traffic is blocked by NetworkPolicy {names}':
    'Mọi traffic inbound bị NetworkPolicy {names} chặn',
  'No controller': 'Không có controller',
  'Claim is {status}': 'Claim đang {status}',
  'Nothing on the map matches “{query}”': 'Không có gì trên bản đồ khớp “{query}”',
  'Claim is {status} and no workload uses it': 'Claim đang {status} và chưa workload nào dùng',
  'Pending is normal while waiting for a first consumer; otherwise check the StorageClass and the provisioner.':
    'Pending là bình thường khi chờ pod đầu tiên dùng; nếu không, kiểm tra StorageClass và provisioner.',
  'Selector {selector} matches no pods — the Service has no endpoints':
    'Selector {selector} không khớp pod nào — Service không có endpoint',
  'No ready endpoints — requests to this Service fail':
    'Không có endpoint nào Ready — request tới Service này sẽ lỗi',
  'No selector and no endpoints — nothing receives its traffic':
    'Không có selector và không có endpoint — không ai nhận traffic của nó',
  'targetPort “{port}” is not a named port in {workload}':
    'targetPort “{port}” không phải tên port nào trong {workload}',
  'targetPort {port} is not exposed by any container of {workload}':
    'targetPort {port} không được container nào của {workload} khai báo',
  'LoadBalancer has no external address yet': 'LoadBalancer chưa có external IP',
  Headless: 'Headless',
  'No selector — endpoints managed manually': 'Không có selector — endpoint quản lý thủ công',
  '{ready}/{total} endpoints ready': '{ready}/{total} endpoint Ready',
  '{ready}/{total} pods ready': '{ready}/{total} pod Ready',
  'Address pending': 'Đang chờ địa chỉ',
  'Every node': 'Mọi node',
  'Referenced but does not exist': 'Được tham chiếu nhưng không tồn tại',
  'This Service does not exist': 'Service này không tồn tại',
  'Backend Service {name} does not exist — these requests fail':
    'Backend Service {name} không tồn tại — các request này sẽ lỗi',
  'Service {name} has no port {port}': 'Service {name} không có port {port}',
  'TLS Secret {name} not found — HTTPS falls back to a default certificate':
    'Không tìm thấy Secret TLS {name} — HTTPS sẽ dùng chứng chỉ mặc định',
  'Parent Gateway {name} not found — the route is not attached':
    'Không tìm thấy parent Gateway {name} — route chưa được gắn',
  'No ingress class': 'Không có ingress class',
  'Any host': 'Mọi host',
  '{n} pod in {status}': '{n} pod đang {status}',
  '{n} pods in {status}': '{n} pod đang {status}',
  '{n} pod running but not ready (readiness probe failing)':
    '{n} pod đang chạy nhưng chưa Ready (readiness probe fail)',
  '{n} pods running but not ready (readiness probe failing)':
    '{n} pod đang chạy nhưng chưa Ready (readiness probe fail)',
  '{n} container restart': '{n} lần restart container',
  '{n} container restarts': '{n} lần restart container',
  '{n} pod without a controller': '{n} pod không có controller',
  '{n} pods without a controller': '{n} pod không có controller',
  '{n} endpoint (manual)': '{n} endpoint (thủ công)',
  '{n} endpoints (manual)': '{n} endpoint (thủ công)',
  '+{n} more rule': '+{n} rule nữa',
  '+{n} more rules': '+{n} rule nữa',
  '+{n} more workload': '+{n} workload nữa',
  '+{n} more workloads': '+{n} workload nữa',
  '{ready}/{desired} ready': '{ready}/{desired} Ready',
  'Not found': 'Không tìm thấy',

  // ——— Object Topology (tab Topology của tài nguyên) ———
  Ownership: 'Ownership',
  Policies: 'Policies',
  'Access (RBAC)': 'Access (RBAC)',
  owns: 'sở hữu',
  selects: 'chọn',
  'routes to': 'định tuyến tới',
  attaches: 'gắn vào',
  uses: 'dùng',
  mounts: 'mount',
  'bound to': 'gắn với',
  'runs on': 'chạy trên',
  scales: 'scale',
  protects: 'bảo vệ',
  isolates: 'cô lập',
  'runs as': 'chạy với danh tính',
  'bound by': 'được gán bởi',
  grants: 'cấp quyền',
  calls: 'gọi',
  'Mapping relationships…': 'Đang dựng quan hệ…',
  'Zoom out': 'Thu nhỏ',
  'Zoom in': 'Phóng to',
  Fit: 'Vừa khung',
  'Click an object to trace it; double-click to open it.':
    'Bấm một object để lần theo; bấm đúp để mở.',
  'Can be expanded': 'Có thể mở rộng',
  'Highlight everything affected if this object changes or fails':
    'Làm nổi bật mọi thứ bị ảnh hưởng nếu object này thay đổi hoặc lỗi',
  'Blast radius': 'Blast radius',
  'Show its relationships too': 'Hiện cả quan hệ của nó',
  'Expanding…': 'Đang mở rộng…',
  'Nothing else in this graph depends on it.': 'Không có gì khác trong graph này phụ thuộc vào nó.',
  'Affects {list}': 'Ảnh hưởng tới {list}',
  '{n} referenced object is missing: {list}': '{n} object được tham chiếu không tồn tại: {list}',
  '{n} referenced objects are missing: {list}': '{n} object được tham chiếu không tồn tại: {list}',
  '{n} relationship': '{n} quan hệ',
  '{n} relationships': '{n} quan hệ',
  'Too many {kind} objects in {ns} — only the first {max} were read':
    'Quá nhiều {kind} trong {ns} — chỉ đọc {max} cái đầu',
  'Too many {kind} objects — only the first {max} were read':
    'Quá nhiều {kind} — chỉ đọc {max} cái đầu',
  'Not allowed to list {kind} in {ns}': 'Không có quyền list {kind} trong {ns}',
  'Not allowed to list {kind}': 'Không có quyền list {kind}',
  'Not allowed to read {kind} in {ns}': 'Không có quyền đọc {kind} trong {ns}',
  'Not allowed to read {kind}': 'Không có quyền đọc {kind}',
  'Unknown (not allowed to read)': 'Không rõ (không có quyền đọc)',
  unscheduled: 'chưa được schedule',
  '{in} in / {out} out rules': '{in} rule vào / {out} rule ra',
  'Identity of the pods': 'Danh tính của pod',
  config: 'config',
  secret: 'secret',
  volume: 'volume',
  'Pods run on {n} nodes — showing {max}': 'Pod chạy trên {n} node — hiện {max}',
  'This service has no selector — endpoints are managed manually':
    'Service này không có selector — endpoint được quản lý thủ công',
  'No pods match the selector — the service has no endpoints':
    'Không pod nào khớp selector — service không có endpoint',
  'Nothing in this namespace uses it — safe to change':
    'Không có gì trong namespace này dùng nó — đổi an toàn',
  'Only routes in the same namespace are shown': 'Chỉ hiện route cùng namespace',
  '+{n} more': '+{n} nữa',
  '{n} not shown': '{n} không hiện',
  '{n} disruption allowed': 'cho phép {n} gián đoạn',
  '{n} permission': '{n} quyền',
  '{n} permissions': '{n} quyền',
  '{n} endpoint': '{n} endpoint',
  '{n} endpoints': '{n} endpoint',
  '{n} pod here': '{n} pod ở đây',
  '{n} pods here': '{n} pod ở đây',
  'Change view': 'Đổi chế độ xem',
  'View options': 'Tuỳ chọn hiển thị',
  // Service map (Map → Traffic, tab Traffic của workload)
  'External clients': 'Client bên ngoài',
  'outside scope': 'ngoài phạm vi',
  'smaller peers': 'các bên nhỏ hơn',
  'Rates appear after two samples (a few seconds).': 'Tốc độ hiện sau hai lần lấy mẫu (vài giây).',
  'No connections yet': 'Chưa có kết nối nào',
  'Only selected': 'Chỉ namespace đã chọn',
  'Find service…': 'Tìm service…',
  'Find service': 'Tìm service',
  'No traffic in the last minute — showing the connections Caretta has seen, dimmed.':
    'Không có traffic trong phút vừa qua — đang hiện mờ các kết nối Caretta đã thấy.',
  'No connections in {scope}': 'Không có kết nối nào trong {scope}',
  'Caretta saw traffic elsewhere in the cluster, but none to or from this scope.':
    'Caretta thấy traffic ở chỗ khác trong cluster, nhưng không có gì đi vào hay ra khỏi phạm vi này.',
  'Fit everything': 'Xem toàn bộ',
  'Collapse group': 'Gộp lại',
  Contains: 'Gồm',
  '{n} address': '{n} địa chỉ',
  '{n} addresses': '{n} địa chỉ',
  'Show idle ({n})': 'Hiện kết nối idle ({n})',
  '+{n} more connection': '+{n} kết nối nữa',
  '+{n} more connections': '+{n} kết nối nữa',
  'Top {n} only': 'Chỉ top {n}',
  'Expand {n}': 'Mở rộng {n}',
  'Service map': 'Service map',
  'callers → this workload → callees': 'bên gọi → workload này → bên được gọi',
  'Connections measured by Hubble (Cilium) or byte rates by Caretta (eBPF) — optional':
    'Số kết nối do Hubble (Cilium) đo hoặc tốc độ byte do Caretta (eBPF) đo — không bắt buộc',
  'Live from Hubble (Cilium) · updated {when}': 'Trực tiếp từ Hubble (Cilium) · cập nhật {when}',
  'Measuring traffic…': 'Đang đo traffic…',
  'Cilium cluster: enable Hubble Relay': 'Cluster dùng Cilium: bật Hubble Relay',
  'Otherwise install Caretta (no Prometheus needed):':
    'Nếu không, cài Caretta (không cần Prometheus):',
  '{reason}. The service map is drawn from Hubble (Cilium) or Caretta (eBPF) — no Prometheus or sidecars needed. The Topology view works without it.':
    '{reason}. Bản đồ dịch vụ dựng từ Hubble (Cilium) hoặc Caretta (eBPF) — không cần Prometheus hay sidecar. Chế độ Topology vẫn dùng được khi không có.',
  '{source} is running but saw no connections in the last minute.':
    '{source} đang chạy nhưng không thấy kết nối nào trong phút vừa qua.',
  '{source} saw traffic elsewhere in the cluster, but none to or from this scope.':
    '{source} thấy traffic ở chỗ khác trong cluster, nhưng không có traffic vào / ra phạm vi này.',
  '{source} is running but saw no connections to or from this workload in the last interval.':
    '{source} đang chạy nhưng không thấy kết nối nào vào / ra workload này trong lượt đo vừa rồi.',
  'On a Cilium cluster, Hubble works instead — enable Hubble Relay with':
    'Cluster dùng Cilium thì dùng Hubble thay thế — bật Hubble Relay bằng',
  'Live traffic: in / out': 'Traffic trực tiếp: vào / ra',
  '{n} conn/s': '{n} kết nối/s',
  'Get the pods healthy first; the budget opens up once they are ready.':
    'Làm cho pod khoẻ lại trước; khi pod sẵn sàng, PDB sẽ cho phép gián đoạn.',
  'Run more replicas or relax minAvailable / maxUnavailable.':
    'Chạy thêm replica hoặc nới minAvailable / maxUnavailable.',
  'PodDisruptionBudget {name} ({rule}) allows no disruptions — draining a node with these pods will hang':
    'PodDisruptionBudget {name} ({rule}) không cho gián đoạn pod nào — drain node chứa các pod này sẽ bị treo',
  'IngressClass {name} does not exist — no controller serves this Ingress':
    'IngressClass {name} không tồn tại — không controller nào phục vụ Ingress này',
  'Use one of: {names}': 'Dùng một trong: {names}',
  '(no IngressClass installed)': '(chưa cài IngressClass nào)',
  'No ingress class and no default IngressClass — the controller may ignore it':
    'Không ghi ingress class và không có IngressClass mặc định — controller có thể bỏ qua Ingress này',
  'Set spec.ingressClassName: {name}': 'Đặt spec.ingressClassName: {name}',
  '{host}{path} is also defined by Ingress {others} — the controller picks only one':
    '{host}{path} cũng được khai báo ở Ingress {others} — controller chỉ chọn một',
  'Certificate in {name} expired on {date} — browsers reject HTTPS':
    'Chứng chỉ trong {name} đã hết hạn ngày {date} — trình duyệt từ chối HTTPS',
  'Renew the certificate (cert-manager: check the Certificate resource).':
    'Gia hạn chứng chỉ (cert-manager: kiểm tra tài nguyên Certificate).',
  'Certificate in {name} expires in {n} day ({date})':
    'Chứng chỉ trong {name} hết hạn sau {n} ngày ({date})',
  'Certificate in {name} expires in {n} days ({date})':
    'Chứng chỉ trong {name} hết hạn sau {n} ngày ({date})',
  'Compare the selector with the pod labels of the workload it should reach.':
    'So selector với nhãn pod của workload mà Service cần trỏ tới.',
  'Check the readiness probe and the logs of the selected pods.':
    'Kiểm tra readiness probe và log của các pod được chọn.',
  'Point targetPort at a port the container listens on (number or containerPort name).':
    'Đặt targetPort là cổng container thật sự lắng nghe (số hoặc tên containerPort).',
  'The cluster needs a load-balancer controller (cloud provider, MetalLB…) — or use NodePort / Ingress.':
    'Cluster cần controller load balancer (cloud, MetalLB…) — hoặc dùng NodePort / Ingress.',
  'Create the Service, or fix the backend name in the Ingress.':
    'Tạo Service, hoặc sửa tên backend trong Ingress.',
  'Create the Service, or fix the backend name in the route.':
    'Tạo Service, hoặc sửa tên backend trong route.',
  'Use a port number or port name that the Service declares.':
    'Dùng số cổng hoặc tên cổng mà Service khai báo.',
  'Create the Secret (kubectl create secret tls …) or let cert-manager issue it.':
    'Tạo Secret (kubectl create secret tls …) hoặc để cert-manager cấp.',
  'Fix parentRefs or create the Gateway.': 'Sửa parentRefs hoặc tạo Gateway.',
  'Create it in this namespace — pods wait in CreateContainerConfigError until then.':
    'Tạo nó trong namespace này — trước đó pod đứng ở CreateContainerConfigError.',
  'Create the PersistentVolumeClaim or fix the claim name.':
    'Tạo PersistentVolumeClaim hoặc sửa tên claim.',
  'Check the StorageClass and the provisioner — the claim waits for a volume.':
    'Kiểm tra StorageClass và provisioner — claim đang chờ volume.',
  'Raise maxReplicas, or give each pod more CPU / memory.':
    'Tăng maxReplicas, hoặc cấp thêm CPU / RAM cho mỗi pod.',
  'Check the image name / tag and the imagePullSecrets for the registry.':
    'Kiểm tra tên / tag image và imagePullSecrets của registry.',
  'Open the logs of the previous container run to see why it exits.':
    'Mở log của lần chạy trước (previous) để xem vì sao container thoát.',
  'Open the pod events — usually not enough CPU / memory, or a volume / node selector.':
    'Mở event của pod — thường do thiếu CPU / RAM, hoặc volume / node selector.',
  'Check the readiness probe — path, port and how long the app takes to start.':
    'Kiểm tra readiness probe — path, cổng và thời gian app cần để khởi động.',
  'How requests reach your apps': 'Request đi vào app theo đường nào',
  'Which machine runs which pods, and which machines are full':
    'Pod nằm trên máy nào, máy nào đang quá tải',
  'Who calls whom, and how much': 'Ai gọi ai, tốc độ bao nhiêu',
  'Show only pods whose labels match — e.g. tier=backend, app.kubernetes.io/part-of=shop, env in (prod,staging), !canary':
    'Chỉ làm nổi pod có nhãn khớp — vd. tier=backend, app.kubernetes.io/part-of=shop, env in (prod,staging), !canary',
  'Open namespace {name}': 'Mở namespace {name}',
  '{n} failing pod': '{n} pod lỗi',
  '{n} failing pods': '{n} pod lỗi',
  'Average traffic from {start} to {end}': 'Traffic trung bình từ {start} đến {end}',
  'from Prometheus {via}': 'từ Prometheus {via}',
  '{object} — count from Prometheus (no message)':
    '{object} — số lần từ Prometheus (không có nội dung)',
  '{kind} events in this namespace — count from Prometheus (no message)':
    'Event của {kind} trong namespace này — số lần từ Prometheus (không có nội dung)',
  'From Prometheus (event exporter)': 'Từ Prometheus (event exporter)',
  'Earlier event counts come from Prometheus.': 'Số event trước đó lấy từ Prometheus.',
  'average from {start} to {end} · from Prometheus {via}':
    'trung bình từ {start} đến {end} · từ Prometheus {via}',
  'Checking for Prometheus…': 'Đang tìm Prometheus…',
  'History needs a Prometheus in the cluster.': 'Xem lịch sử cần Prometheus trong cluster.',
  'Prometheus has Hubble metrics without workload labels — enable the "tcp" metric with labelsContext=source_namespace,source_workload,destination_namespace,destination_workload.':
    'Prometheus có metric Hubble nhưng thiếu nhãn workload — bật metric "tcp" với labelsContext=source_namespace,source_workload,destination_namespace,destination_workload.',
  'Prometheus does not collect Caretta or Hubble traffic metrics.':
    'Prometheus chưa thu metric traffic của Caretta hay Hubble.',
  'Live — read directly every 10 seconds': 'Trực tiếp — đọc mỗi 10 giây',
  'Average over the last {range}, from Prometheus': 'Trung bình {range} gần nhất, từ Prometheus',
  History: 'Lịch sử',
  'Time range': 'Khoảng thời gian',
  'from Prometheus': 'từ Prometheus',
  Outbound: 'Đi ra ngoài',
  'All types': 'Mọi loại',
  Observed: 'Quan sát',
  Idle: 'Yên',
  Seen: 'Đã thấy',
  Undeclared: 'Không khai báo',
  'Not seen': 'Chưa thấy',
  'Not measured': 'Chưa đo',
  "Can't tell": 'Chưa rõ',
  'Show addresses': 'Hiện từng địa chỉ',
  'Looking up…': 'Đang tra cứu…',
  'No connection seen': 'Không thấy kết nối',
  'not declared': 'không khai báo',
  'not declared anywhere': 'không khai báo ở đâu',
  'Filter by workload, destination or source': 'Lọc theo workload, đích hoặc nơi khai báo',
  'Filter connections': 'Lọc kết nối',
  'Observed traffic: {source}, average over the last minute.':
    'Traffic quan sát: {source}, trung bình 1 phút gần nhất.',
  'No traffic source in this cluster (Caretta or Hubble) — only the configuration is shown, so nothing can be marked seen or undeclared.':
    'Cluster này không có nguồn traffic (Caretta hoặc Hubble) — chỉ hiện cấu hình nên không thể đánh dấu "đã thấy" hay "không khai báo".',
  'No traffic source in this cluster (Caretta or Hubble) — only the configuration is shown.':
    'Cluster này không có nguồn traffic (Caretta hoặc Hubble) — chỉ hiện cấu hình.',
  'Hostnames are looked up on this computer to match the IPs that were seen — a cluster with its own DNS can answer differently.':
    'Tên máy được tra DNS trên máy này để khớp với các IP đã thấy — DNS riêng của cluster có thể trả lời khác.',
  'Hostnames are looked up on this computer to match the IPs that were seen. Also look up internal names (.corp, .internal…) with this computer’s DNS':
    'Tên máy được tra DNS trên máy này để khớp với các IP đã thấy. Tra cả tên nội bộ (.corp, .internal…) bằng DNS của máy này',
  'Also look up internal names (.corp, .internal…) with this computer’s DNS':
    'Tra cả tên nội bộ (.corp, .internal…) bằng DNS của máy này',
  'Show {n} system connection (DNS, kube-system)': 'Hiện {n} kết nối hệ thống (DNS, kube-system)',
  'Show {n} system connections (DNS, kube-system)': 'Hiện {n} kết nối hệ thống (DNS, kube-system)',
  'Where this workload is configured to connect (env, arguments, ConfigMaps, Secrets), next to the traffic that was actually seen.':
    'Nơi workload này được cấu hình để kết nối (env, tham số, ConfigMap, Secret), đặt cạnh traffic thực sự đã thấy.',
  'Where each workload connects: what is declared in env / ConfigMaps / Secrets next to the traffic that was actually seen':
    'Mỗi workload nối tới đâu: phần khai báo trong env / ConfigMap / Secret đặt cạnh traffic thực sự đã thấy',
  'The destinations, with what is declared in the configuration next to what was seen, are in':
    'Các đích đi ra, kèm phần khai báo trong cấu hình đặt cạnh phần đã thấy, nằm ở',
  'Declared in the configuration, and traffic is flowing to it now':
    'Có khai báo trong cấu hình, và đang có traffic tới đó',
  'Declared, and a connection was seen, but it is quiet right now':
    'Có khai báo, đã thấy kết nối nhưng lúc này đang yên',
  'Declared in the configuration but no connection to it was seen — a dead setting, a backup path, or not used yet':
    'Có khai báo trong cấu hình nhưng không thấy kết nối nào tới đó — cấu hình chết, đường dự phòng, hoặc chưa ai dùng',
  'Declared by a name that could not be matched to the IPs that were seen (an internal name that is not looked up, or the lookup failed)':
    'Khai báo bằng một tên không ghép được với các IP đã thấy (tên nội bộ chưa được tra, hoặc tra cứu thất bại)',
  'This cluster has no traffic source (Caretta or Hubble), so only the configuration is known':
    'Cluster này không có nguồn traffic (Caretta hoặc Hubble) nên chỉ biết cấu hình',
  'Traffic was seen to a destination that is not declared in any env, ConfigMap or Secret — hardcoded, discovered at runtime, or unexpected':
    'Có traffic tới một đích không khai báo trong env, ConfigMap hay Secret nào — hardcode, tìm lúc chạy, hoặc bất ngờ',
  '+{n} more place': '+{n} nơi khai báo khác',
  '+{n} more places': '+{n} nơi khai báo khác',
  'Some workload kinds could not be listed (no permission) — the list may be incomplete.':
    'Có loại workload không list được (thiếu quyền) — danh sách có thể chưa đầy đủ.',
  'This workload could not be read (no permission).': 'Không đọc được workload này (thiếu quyền).',
  'Where this workload is configured to connect — read from its environment variables, arguments, ConfigMaps and Secrets. Not observed traffic.':
    'Nơi workload này được cấu hình để kết nối tới — đọc từ biến môi trường, tham số, ConfigMap và Secret của nó. Không phải traffic quan sát được.',
  'No connection targets found in the configuration of this workload.':
    'Không tìm thấy điểm đến kết nối nào trong cấu hình của workload này.',
  'Through Service': 'Qua Service',
  'Read from configuration — not observed traffic.':
    'Đọc từ cấu hình — không phải traffic quan sát được.',
  'via {service}': 'qua {service}',
  'Reached through an ExternalName Service': 'Gọi qua một Service ExternalName',
  'Outbound lane': 'Làn đi ra ngoài',
  'Where the workloads are configured to connect (hosts and ports found in env, args, ConfigMaps and Secrets) — declared, not observed traffic':
    'Nơi các workload được cấu hình để kết nối tới (host và cổng tìm thấy trong env, tham số, ConfigMap và Secret) — là khai báo, không phải traffic quan sát được',
  'Hosts and ports the workloads are configured to connect to':
    'Host và cổng mà các workload được cấu hình để kết nối tới',
  'Hosts and ports the workloads are configured to connect to — from env, ConfigMaps and Secrets':
    'Host và cổng mà các workload được cấu hình để kết nối tới — từ env, ConfigMap và Secret',
  'Read Secrets for destinations': 'Đọc Secret để tìm điểm đến',
  'Reads only the Secrets a workload references, keeps just the host and port, and is recorded in the audit log':
    'Chỉ đọc đúng các Secret mà workload tham chiếu, chỉ giữ host và cổng, và được ghi vào audit log',
  Service: 'Service',
  Pod: 'Pod',
  'Private network': 'Mạng riêng',
  'Unresolved name': 'Tên chưa xác định',
  'default port': 'cổng mặc định',
  'In cluster': 'Trong cluster',
  Destination: 'Điểm đến',
  'Destination type': 'Loại điểm đến',
  'Declared in': 'Khai báo ở',
  'Default port of the scheme': 'Cổng mặc định của giao thức',
  'Copy host:port': 'Sao chép host:port',
  'Copy {value}': 'Sao chép {value}',
  'Filter by workload, host, port or source': 'Lọc theo workload, host, cổng hoặc nơi khai báo',
  'Filter outbound connections': 'Lọc kết nối đi ra',
  'Nothing matches this filter.': 'Không có gì khớp bộ lọc này.',
  'No connection targets found in the configuration of these workloads.':
    'Không tìm thấy điểm đến kết nối nào trong cấu hình của các workload này.',
  'Reading workload configuration…': 'Đang đọc cấu hình workload…',
  'Large cluster — only part of it was scanned. Pick fewer namespaces.':
    'Cluster lớn — mới quét một phần. Hãy chọn ít namespace hơn.',
  'Read from configuration: environment variables, arguments, and the ConfigMaps and Secrets the pods reference. These are where workloads are set up to connect — not observed traffic, and not every connection is listed here.':
    'Đọc từ cấu hình: biến môi trường, tham số, và các ConfigMap / Secret mà pod tham chiếu. Đây là nơi workload được thiết lập để kết nối — không phải traffic quan sát được, và không phải kết nối nào cũng có ở đây.',
  '{n} ConfigMap or Secret could not be read (no permission).':
    '{n} ConfigMap hoặc Secret không đọc được (thiếu quyền).',
  '{n} ConfigMaps or Secrets could not be read (no permission).':
    '{n} ConfigMap hoặc Secret không đọc được (thiếu quyền).',
  '{n} Secret skipped (too many).': 'Bỏ qua {n} Secret (quá nhiều).',
  '{n} Secrets skipped (too many).': 'Bỏ qua {n} Secret (quá nhiều).',
  '{n} Secret not read (reading Secrets is off).': '{n} Secret chưa đọc (đang tắt đọc Secret).',
  '{n} Secrets not read (reading Secrets is off).': '{n} Secret chưa đọc (đang tắt đọc Secret).',
  '+{n} more destination': '+{n} điểm đến khác',
  '+{n} more destinations': '+{n} điểm đến khác'
}
