import { afterEach, describe, expect, it } from 'vitest'
import { isMultiline, joinPasteLines, pasteLines } from '../../src/renderer/src/terminal/paste'
import {
  choose,
  confirmAction,
  settleConfirm,
  useConfirm
} from '../../src/renderer/src/stores/confirm'
import { setCloseGuard, useTabs } from '../../src/renderer/src/stores/tabs'
import { overwriteAsker } from '../../src/renderer/src/components/files/overwrite'
import { sessionsByHost } from '../../src/renderer/src/components/sidebar/sessions'

/** Chờ hộp thoại kế tiếp xuất hiện trong hàng đợi rồi trả lời. */
async function answer(value: string | null): Promise<string> {
  await Promise.resolve()
  const head = useConfirm.getState().queue[0]
  if (!head) throw new Error('No dialog is open')
  settleConfirm(head.id, value)
  // Cho các .then() phía sau chạy.
  await new Promise((r) => setTimeout(r, 0))
  return head.options.title
}

afterEach(() => {
  for (const p of useConfirm.getState().queue) settleConfirm(p.id, null)
  useTabs.setState({ tabs: [], activeId: null, closed: [] })
})

describe('dán nhiều dòng', () => {
  it('nhận diện xuống dòng, kể cả \\n cuối và \\r', () => {
    expect(isMultiline('ls -la')).toBe(false)
    expect(isMultiline('ls\n')).toBe(true)
    expect(isMultiline('a\rb')).toBe(true)
  })

  it('tách dòng (bỏ dòng trống do \\n kết thúc) và nối thành một dòng', () => {
    expect(pasteLines('a\r\nb\nc\n')).toEqual(['a', 'b', 'c'])
    expect(pasteLines('only')).toEqual(['only'])
    expect(joinPasteLines('  cd /tmp \n\n ls -la\n')).toBe('cd /tmp ls -la')
  })
})

describe('hộp thoại xác nhận (stores/confirm)', () => {
  it('choose trả về nút đã bấm; đóng hộp thoại = null; hàng đợi theo thứ tự', async () => {
    const first = choose({ title: 'One', choices: [{ value: 'a', label: 'A' }] })
    const second = choose({ title: 'Two', choices: [{ value: 'b', label: 'B' }] })
    expect(useConfirm.getState().queue.map((p) => p.options.title)).toEqual(['One', 'Two'])
    expect(await answer('a')).toBe('One')
    expect(await answer(null)).toBe('Two')
    expect(await first).toBe('a')
    expect(await second).toBeNull()
  })

  it('confirmAction: OK = true, huỷ / Esc = false', async () => {
    const yes = confirmAction({ title: 'Delete?' })
    await answer('ok')
    expect(await yes).toBe(true)
    const no = confirmAction({ title: 'Delete?' })
    await answer(null)
    expect(await no).toBe(false)
  })
})

describe('đóng tab có guard (stores/tabs)', () => {
  const concern = {
    title: 'Close “web”?',
    message: 'You are connected to web.',
    confirmLabel: 'Close'
  }

  it('guard trả lý do → hỏi; huỷ giữ tab, đồng ý thì đóng; bấm đóng hai lần không hỏi chồng', async () => {
    const id = useTabs.getState().addLocal()
    setCloseGuard(id, () => concern)
    useTabs.getState().close(id)
    useTabs.getState().close(id)
    expect(useConfirm.getState().queue).toHaveLength(1)
    await answer(null)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([id])

    useTabs.getState().close(id)
    await answer('ok')
    expect(useTabs.getState().tabs).toHaveLength(0)
    setCloseGuard(id, null)
  })

  it('không có lý do → đóng ngay, không hỏi', () => {
    const id = useTabs.getState().addLocal()
    setCloseGuard(id, () => null)
    useTabs.getState().close(id)
    expect(useConfirm.getState().queue).toHaveLength(0)
    expect(useTabs.getState().tabs).toHaveLength(0)
    setCloseGuard(id, null)
  })

  it('"Close other tabs": tab thường đóng ngay, các tab cần hỏi gộp vào MỘT hộp thoại', async () => {
    const keep = useTabs.getState().addLocal()
    const plain = useTabs.getState().addLocal()
    const a = useTabs.getState().addLocal()
    const b = useTabs.getState().addLocal()
    setCloseGuard(a, () => concern)
    setCloseGuard(b, () => ({ ...concern, message: 'Unsaved changes.' }))
    useTabs.getState().closeOthers(keep)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([keep, a, b])
    expect(useTabs.getState().tabs.some((t) => t.id === plain)).toBe(false)
    expect(useConfirm.getState().queue).toHaveLength(1)
    expect(await answer('ok')).toBe('Close 2 more tabs?')
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([keep])
    expect(useTabs.getState().activeId).toBe(keep)
    setCloseGuard(a, null)
    setCloseGuard(b, null)
  })
})

describe('đóng tab trong lúc đang hỏi (stores/tabs)', () => {
  const concern = { title: 'Close “web”?', message: 'Connected.', confirmLabel: 'Close' }

  it('shell thoát sạch (close lần nữa) khi hộp thoại đang mở: Cancel mà hết lý do hỏi → vẫn đóng', async () => {
    const id = useTabs.getState().addLocal()
    let connected = true
    setCloseGuard(id, () => (connected ? concern : null))
    useTabs.getState().close(id)
    connected = false
    useTabs.getState().close(id)
    expect(useConfirm.getState().queue).toHaveLength(1)
    await answer(null)
    expect(useTabs.getState().tabs).toHaveLength(0)
    setCloseGuard(id, null)
  })

  it('bấm đóng lần nữa nhưng vẫn còn kết nối: Cancel giữ tab', async () => {
    const id = useTabs.getState().addLocal()
    setCloseGuard(id, () => concern)
    useTabs.getState().close(id)
    useTabs.getState().close(id)
    await answer(null)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([id])
    setCloseGuard(id, null)
  })

  it('"Close other tabs": đổi sang tab khác trong lúc hỏi → không bị kéo về tab gốc', async () => {
    const keep = useTabs.getState().addLocal()
    const asked = useTabs.getState().addLocal()
    setCloseGuard(asked, () => concern)
    useTabs.getState().closeOthers(keep)
    expect(useTabs.getState().activeId).toBe(keep)
    const other = useTabs.getState().addLocal()
    expect(useTabs.getState().activeId).toBe(other)
    await answer('ok')
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([keep, other])
    expect(useTabs.getState().activeId).toBe(other)
    setCloseGuard(asked, null)
  })

  it('"Close other tabs": tab đang active bị đóng sau khi xác nhận → chuyển về tab gốc', async () => {
    const keep = useTabs.getState().addLocal()
    const asked = useTabs.getState().addLocal()
    setCloseGuard(asked, () => concern)
    useTabs.getState().closeOthers(keep)
    useTabs.getState().activate(asked)
    await answer('ok')
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual([keep])
    expect(useTabs.getState().activeId).toBe(keep)
    setCloseGuard(asked, null)
  })
})

describe('hỏi ghi đè (overwriteAsker)', () => {
  it('"Replace all" áp dụng cho các mục còn lại, không hỏi lại', async () => {
    const ask = overwriteAsker(3)
    const first = ask('a exists')
    await answer('replace-all')
    expect(await first).toBe(true)
    expect(await ask('b exists')).toBe(true)
    expect(await ask('c exists')).toBe(true)
    expect(useConfirm.getState().queue).toHaveLength(0)
  })

  it('Esc = bỏ qua mọi mục còn lại; một mục thì không có nút "… all"', async () => {
    const ask = overwriteAsker(2)
    const first = ask('a exists')
    await answer(null)
    expect(await first).toBe(false)
    expect(await ask('b exists')).toBe(false)

    const single = overwriteAsker(1)
    const one = single('x exists')
    await Promise.resolve()
    const values = useConfirm.getState().queue[0]?.options.choices.map((c) => c.value)
    expect(values).toEqual(['skip', 'replace'])
    await answer('replace')
    expect(await one).toBe(true)
  })
})

describe('trạng thái phiên theo host (thanh bên)', () => {
  it('lấy trạng thái tốt nhất trong các tab của host; nhớ kết quả theo (tabs, byTab)', () => {
    const tabs = [
      { id: 't1', title: 'a', target: { kind: 'host' as const, hostId: 'h1' } },
      { id: 't2', title: 'a', target: { kind: 'host' as const, hostId: 'h1' } },
      { id: 't3', title: 'b', target: { kind: 'host' as const, hostId: 'h2' } },
      { id: 't4', title: 'l', target: { kind: 'local' as const } }
    ]
    const byTab = { t1: 'disconnected', t2: 'connected', t4: 'connected' } as const
    const map = sessionsByHost(tabs, byTab)
    expect(map.get('h1')).toBe('connected')
    // Tab chưa báo trạng thái = đang kết nối.
    expect(map.get('h2')).toBe('connecting')
    expect(map.size).toBe(2)
    expect(sessionsByHost(tabs, byTab)).toBe(map)
  })
})
