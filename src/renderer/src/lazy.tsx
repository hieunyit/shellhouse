import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react'

/**
 * Các màn ít dùng lúc khởi động được tách thành chunk riêng → bundle chính nhỏ hơn, mở app nhanh
 * hơn. Ngay sau lần vẽ đầu, `preloadLazyParts()` nạp sẵn mọi chunk.
 *
 * Không dùng thẳng React.lazy: nó luôn "suspend" một nhịp ở lần render đầu (kể cả khi module đã
 * nạp), làm hộp thoại hiện trễ một khung hình và phím Esc bấm ngay sau đó bị mất. Ở đây, nếu module
 * đã nạp lúc mount thì render đồng bộ; không thì dùng lazy (có Suspense riêng để không ẩn các hộp
 * thoại khác). Lựa chọn được chốt theo từng lần mount — xem Component.
 */
function preloadable<P extends object>(
  load: () => Promise<ComponentType<P>>,
  /** Vẽ trong lúc chờ chunk (mặc định: không gì cả). */
  fallback: ReactNode = null
): { Component: ComponentType<P>; preload: () => Promise<void> } {
  let loaded: ComponentType<P> | null = null
  const remember = (c: ComponentType<P>): ComponentType<P> => {
    loaded = c
    return c
  }
  const Lazy = lazy(async () => ({ default: remember(await load()) }))
  function Component(props: P): React.JSX.Element {
    // Chốt cách render MỘT LẦN lúc mount. Nếu đổi giữa các lần render (chunk vừa nạp xong khi hộp
    // thoại đang mở), React thấy loại component khác → huỷ và mount lại → mất dữ liệu đang nhập.
    const [Loaded] = useState(() => loaded)
    if (Loaded) return <Loaded {...props} />
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return {
    Component,
    preload: async () => {
      remember(await load())
    }
  }
}

const settings = preloadable(() =>
  import('./components/settings/SettingsPage').then((m) => m.SettingsPage)
)
const snippets = preloadable(() =>
  import('./components/SnippetsDialog').then((m) => m.SnippetsDialog)
)
const hostForm = preloadable(() => import('./components/HostForm').then((m) => m.HostForm))
const groupForm = preloadable(() => import('./components/GroupForm').then((m) => m.GroupForm))
const importDialog = preloadable(() =>
  import('./components/ImportDialog').then((m) => m.ImportDialog)
)
const exportDialog = preloadable(() =>
  import('./components/ExportDialog').then((m) => m.ExportDialog)
)
const sftp = preloadable(() => import('./terminal/SftpPanel').then((m) => m.SftpPanel))
const forwards = preloadable(() => import('./terminal/ForwardsPanel').then((m) => m.ForwardsPanel))
const deployKey = preloadable(() =>
  import('./terminal/DeployKeyDialog').then((m) => m.DeployKeyDialog)
)

/**
 * Editor trong app (CodeMirror ~ vài trăm KB): chỉ nạp khi mở tab editor đầu tiên — không nằm trong
 * bundle khởi động, cũng không nạp sẵn (phần lớn người dùng không mở editor).
 */
const editorTab = preloadable(() => import('./editor/EditorTab').then((m) => m.EditorTabView))
export const EditorTabView = editorTab.Component

/**
 * Terminal (xterm.js + WebGL + addon ~500 KB): tách khỏi bundle khởi động — màn đầu (Home, thanh
 * bên) vẽ không phải chờ parse xterm. Bắt đầu nạp ngay khi renderer chạy (`preloadTerminal()` trong
 * main.tsx, song song với chờ font) nên tab local lúc khởi động thường render đồng bộ; nếu chưa kịp
 * thì khung nền màu terminal giữ chỗ (không chớp trắng). Trong lúc đó chưa có controller của tab —
 * mọi chỗ gọi `controllers.get(id)` đều đã chịu được undefined; TerminalView tự activate khi mount.
 */
const terminalView = preloadable(
  () => import('./terminal/TerminalView').then((m) => m.TerminalView),
  <div className="h-full bg-terminal" data-testid="terminal-loading" />
)
export const TerminalView = terminalView.Component

/**
 * Remote Desktop trong tab: view nhỏ; backend IronRDP (WASM ~6 MB) là chunk riêng, chỉ nạp khi kết
 * nối lần đầu (rdp/ironrdp.ts).
 */
const rdpView = preloadable(
  () => import('./rdp/RdpView').then((m) => m.RdpView),
  <div className="h-full bg-terminal" data-testid="rdp-view-loading" />
)
export const RdpView = rdpView.Component

/**
 * Design kit của giao diện mới (design system trong ds/ + Radix): chunk riêng, chỉ nạp khi mở từ bảng
 * lệnh — không nạp sẵn, không nằm trong bundle khởi động.
 */
const designKit = preloadable(() => import('./ds/kit/DesignKit').then((m) => m.DesignKit))
export const DesignKit = designKit.Component

/** Nạp chunk terminal sớm nhất có thể (gọi một lần lúc khởi động; gọi lại không tốn gì). */
export function preloadTerminal(): Promise<void> {
  return terminalView.preload()
}

export const SettingsPage = settings.Component
export const SnippetsDialog = snippets.Component
export const HostForm = hostForm.Component
export const GroupForm = groupForm.Component
export const ImportDialog = importDialog.Component
export const ExportDialog = exportDialog.Component
export const SftpPanel = sftp.Component
export const ForwardsPanel = forwards.Component
export const DeployKeyDialog = deployKey.Component

/** Nạp sẵn mọi chunk (file nằm trong app, tổng ~60 KB → xong trong vài ms). */
export function preloadLazyParts(): Promise<unknown> {
  return Promise.all(
    [
      terminalView,
      settings,
      snippets,
      hostForm,
      groupForm,
      importDialog,
      exportDialog,
      sftp,
      forwards,
      deployKey
    ].map((p) => p.preload())
  )
}
