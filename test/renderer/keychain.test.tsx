// @vitest-environment jsdom
import './ds-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { AccountSummary, HostSummary, HostTree, KeySummary } from '@shared/hosts'

// Store hosts đăng ký onHostsChanged lúc nạp module → cần window.shellhouse trước mọi import.
const api = vi.hoisted(() => {
  const mock = {
    onHostsChanged: vi.fn(() => () => undefined),
    hostTree: vi.fn(),
    publicKey: vi.fn((id: string) =>
      Promise.resolve(
        id === 'k-rsa'
          ? // RSA 4096 giả: string "ssh-rsa", mpint e, mpint n (513 byte, byte đầu 0).
            `ssh-rsa ${btoa(
              String.fromCharCode(
                ...[0, 0, 0, 7, ...new TextEncoder().encode('ssh-rsa')],
                ...[0, 0, 0, 3, 1, 0, 1],
                ...[0, 0, 2, 1, 0, 0xc5, ...new Array<number>(511).fill(0xab)]
              )
            )} ci`
          : 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA laptop'
      )
    ),
    deleteKey: vi.fn(() => Promise.resolve({ ok: true, id: 'x' })),
    deleteAccount: vi.fn(() => Promise.resolve({ ok: true, id: 'x' })),
    writeClipboard: vi.fn(() => Promise.resolve()),
    importKeyFromFile: vi.fn(() => Promise.resolve(null))
  }
  ;(globalThis as unknown as { window: { shellhouse: unknown } }).window.shellhouse = mock
  return mock
})

const { useHosts } = await import('../../src/renderer/src/stores/hosts')
const { useConfirm, settleConfirm } = await import('../../src/renderer/src/stores/confirm')
const { Keychain } = await import('../../src/renderer/src/components/accounts/Keychain')

const keys: KeySummary[] = [
  {
    id: 'k-ed',
    name: 'laptop',
    type: 'ed25519',
    fingerprint: 'SHA256:AAAAbbbbCCCCddddEEEEffff0000',
    encrypted: true
  },
  { id: 'k-rsa', name: 'ci', type: 'rsa', fingerprint: 'SHA256:ZZZZyyyyXXXXwwww', encrypted: false }
]
const accounts: AccountSummary[] = [
  {
    id: 'a1',
    name: 'Prod deploy',
    username: 'deployer',
    hasPassword: true,
    keyId: 'k-ed',
    hasPassphrase: true,
    domain: '',
    notes: '',
    hostIds: ['h1', 'h2'],
    updatedAt: 1
  }
]
const hosts = ['h1', 'h2', 'h3'].map((id): HostSummary => ({
  id,
  groupId: null,
  label: `host-${id}`,
  hostname: `${id}.example`,
  port: null,
  username: '',
  auth: 'key',
  hasPassword: false,
  keyId: 'k-ed',
  keyFile: null,
  proxyJump: null,
  jumpHostIds: [],
  mode: 'builtin',
  direct: false,
  tags: [],
  color: null,
  protocol: 'ssh',
  legacyAlgorithms: false,
  serial: null,
  lastUsedAt: null,
  favorite: false,
  sort: 0,
  ...(id === 'h3' ? {} : { accountId: 'a1' })
}))

function setTree(tree: Partial<HostTree>): void {
  useHosts.setState({ tree: { groups: [], hosts, keys, accounts, ...tree } })
}

const rows = (): HTMLElement[] => screen.getAllByRole('option')

beforeEach(() => {
  setTree({})
  useConfirm.setState({ queue: [] })
  vi.clearAllMocks()
})

describe('Keychain', () => {
  it('một danh sách: tài khoản + key, chip lọc có số đếm, tìm', async () => {
    render(<Keychain />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(rows().map((r) => r.dataset['item'])).toEqual(['account:a1', 'key:k-rsa', 'key:k-ed'])
    expect(screen.getByTestId('keychain-filter-all').textContent).toBe('All3')
    expect(screen.getByTestId('keychain-filter-accounts').textContent).toBe('Accounts1')
    expect(screen.getByTestId('keychain-filter-keys').textContent).toBe('SSH keys2')

    fireEvent.click(screen.getByTestId('keychain-filter-keys'))
    expect(rows().map((r) => r.dataset['item'])).toEqual(['key:k-rsa', 'key:k-ed'])

    fireEvent.change(screen.getByTestId('keychain-search'), { target: { value: 'lapt' } })
    expect(rows().map((r) => r.dataset['item'])).toEqual(['key:k-ed'])
    expect(screen.getByTestId('keychain-filter-all').textContent).toBe('All1')
  })

  it('dòng key: loại + số bit, ai đang dùng (tài khoản + host, không trùng)', async () => {
    render(<Keychain initialFilter="keys" />)
    // Dòng trong danh sách + khung chi tiết (ci được chọn sẵn).
    expect(await screen.findAllByText('RSA 4096')).toHaveLength(2)
    const ed = rows().find((r) => r.dataset['item'] === 'key:k-ed')
    if (!ed) throw new Error('missing row')
    // h1, h2 qua tài khoản; h3 trực tiếp.
    expect(within(ed).getByTestId('key-row-usage').textContent).toBe(
      'Used by: Prod deploy · 3 hosts'
    )
  })

  it('bàn phím: ↓ chọn mục kế, Enter mở tài khoản, "/" vào ô tìm', async () => {
    render(<Keychain />)
    await act(async () => {
      await Promise.resolve()
    })
    const list = screen.getByTestId('keychain-list')
    // Mục đầu được chọn sẵn → khung chi tiết là tài khoản.
    expect(screen.getByTestId('account-detail').dataset['accountName']).toBe('Prod deploy')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(screen.getByTestId('key-detail').dataset['keyName']).toBe('ci')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(screen.getByTestId('account-editor')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))

    list.focus()
    fireEvent.keyDown(list, { key: '/' })
    expect(document.activeElement).toBe(screen.getByTestId('keychain-search'))
  })

  it('Delete: key đang dùng → báo, không gọi xoá; key rảnh → hỏi rồi xoá', async () => {
    render(<Keychain initialFilter="keys" />)
    await act(async () => {
      await Promise.resolve()
    })
    const list = screen.getByTestId('keychain-list')
    // k-ed (đang dùng)
    fireEvent.keyDown(list, { key: 'End' })
    fireEvent.keyDown(list, { key: 'Delete' })
    const blocked = useConfirm.getState().queue[0]
    expect(blocked?.options.testId).toBe('key-in-use')
    await act(async () => {
      if (blocked) settleConfirm(blocked.id, 'ok')
      await Promise.resolve()
    })
    expect(api.deleteKey).not.toHaveBeenCalled()

    // k-rsa (không ai dùng)
    fireEvent.keyDown(list, { key: 'Home' })
    fireEvent.keyDown(list, { key: 'Delete' })
    const ask = useConfirm.getState().queue[0]
    expect(ask?.options.testId).toBe('key-delete-confirm')
    await act(async () => {
      if (ask) settleConfirm(ask.id, 'ok')
      await Promise.resolve()
    })
    expect(api.deleteKey).toHaveBeenCalledWith('k-rsa')
  })

  it('liên kết trong chi tiết key → chọn tài khoản (bỏ lọc nếu đang ẩn)', async () => {
    render(<Keychain initialFilter="keys" />)
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.mouseDown(rows().find((r) => r.dataset['item'] === 'key:k-ed') as HTMLElement)
    const usage = screen.getByTestId('key-usage-accounts')
    fireEvent.click(within(usage).getByText('Prod deploy'))
    expect(screen.getByTestId('account-detail').dataset['accountName']).toBe('Prod deploy')
    expect(screen.getByTestId('keychain-filter-all').getAttribute('aria-checked')).toBe('true')
  })
})
