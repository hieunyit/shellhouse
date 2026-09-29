import { lazy, Suspense, useState, type ComponentType } from 'react'

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
  load: () => Promise<ComponentType<P>>
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
      <Suspense fallback={null}>
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
  import('./components/settings/SettingsDialog').then((m) => m.SettingsDialog)
)
const snippets = preloadable(() =>
  import('./components/SnippetsDialog').then((m) => m.SnippetsDialog)
)
const hostForm = preloadable(() => import('./components/HostForm').then((m) => m.HostForm))
const groupForm = preloadable(() => import('./components/GroupForm').then((m) => m.GroupForm))
const importDialog = preloadable(() =>
  import('./components/ImportDialog').then((m) => m.ImportDialog)
)
const sftp = preloadable(() => import('./terminal/SftpPanel').then((m) => m.SftpPanel))
const forwards = preloadable(() => import('./terminal/ForwardsPanel').then((m) => m.ForwardsPanel))
const deployKey = preloadable(() =>
  import('./terminal/DeployKeyDialog').then((m) => m.DeployKeyDialog)
)

export const SettingsDialog = settings.Component
export const SnippetsDialog = snippets.Component
export const HostForm = hostForm.Component
export const GroupForm = groupForm.Component
export const ImportDialog = importDialog.Component
export const SftpPanel = sftp.Component
export const ForwardsPanel = forwards.Component
export const DeployKeyDialog = deployKey.Component

/** Nạp sẵn mọi chunk (file nằm trong app, tổng ~60 KB → xong trong vài ms). */
export function preloadLazyParts(): Promise<unknown> {
  return Promise.all(
    [settings, snippets, hostForm, groupForm, importDialog, sftp, forwards, deployKey].map((p) =>
      p.preload()
    )
  )
}
