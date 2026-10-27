// @vitest-environment jsdom
import './ds-dom'
import { forwardRef, useImperativeHandle } from 'react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { EditorDoc } from '../../src/renderer/src/editor/docs'
import type { CodeEditorHandle } from '../../src/renderer/src/editor/CodeEditor'
const h = vi.hoisted(() => ({
  text: '',
  finish: null as null | (() => void),
  guard: null as null | (() => unknown),
  written: [] as string[],
  versions: [] as unknown[]
}))
vi.mock('../../src/renderer/src/editor/docs', () => ({
  looksBinary: () => false,
  editorDoc: () => doc
}))
const doc: EditorDoc = {
  key: 'test',
  name: 'config.txt',
  path: '/config.txt',
  where: 'server',
  read: () => Promise.resolve({ bytes: new TextEncoder().encode('original'), version: { n: 1 } }),
  write: (bytes, version) => {
    h.written.push(new TextDecoder().decode(bytes))
    h.versions.push(version)
    return new Promise((resolve) => {
      h.finish = () => {
        resolve({ n: h.written.length + 1 })
      }
    })
  },
  isConflict: () => false
}
vi.mock('../../src/renderer/src/editor/CodeEditor', () => ({
  CodeEditor: forwardRef<
    CodeEditorHandle,
    { initial: string; onChange: (text: () => string) => void }
  >(function FakeEditor(props, ref) {
    if (!h.text) h.text = props.initial
    useImperativeHandle(ref, () => ({
      text: () => h.text,
      focus: () => undefined,
      setText: (text: string) => {
        h.text = text
      }
    }))
    return (
      <textarea
        aria-label="code"
        defaultValue={props.initial}
        onChange={(e) => {
          h.text = e.target.value
          props.onChange(() => h.text)
        }}
      />
    )
  })
}))
vi.mock('../../src/renderer/src/editor/languages', () => ({
  allLanguages: () => [],
  languageOf: () => null
}))
vi.mock('../../src/renderer/src/stores/tabs', () => ({
  useTabs: { getState: () => ({ setTitle: () => undefined }) },
  setCloseGuard: (_: string, guard: (() => unknown) | null) => {
    h.guard = guard
  }
}))
vi.mock('../../src/renderer/src/stores/confirm', () => ({
  confirmAction: () => Promise.resolve(false)
}))
vi.mock('../../src/renderer/src/stores/toasts', () => ({
  toast: { error: () => undefined, success: () => undefined }
}))
import { EditorTabView } from '../../src/renderer/src/editor/EditorTab'
it('giữ dirty và cảnh báo đóng tab nếu gõ thêm trong lúc lưu; lần lưu kế tiếp ghi bản mới', async () => {
  const view = render(<EditorTabView tabId="editor" docKey="test" active={false} />)
  const code = await view.findByRole('textbox', { name: 'code' })
  fireEvent.change(code, { target: { value: 'first saved version' } })
  fireEvent.click(view.getByTestId('editor-save'))
  await waitFor(() => {
    expect(h.finish).not.toBeNull()
  })
  fireEvent.change(code, { target: { value: 'second UNSAVED version' } })
  await act(async () => {
    h.finish?.()
    await Promise.resolve()
  })
  expect(view.getByTestId('editor-state').textContent).toBe('Unsaved changes')
  expect(h.guard?.()).not.toBeNull()
  expect((view.getByTestId('editor-save') as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(view.getByTestId('editor-save'))
  await act(async () => {
    h.finish?.()
    await Promise.resolve()
  })
  expect(h.written).toEqual(['first saved version', 'second UNSAVED version'])
  expect(h.versions).toEqual([{ n: 1 }, { n: 2 }])
  expect(view.getByTestId('editor-state').textContent).toBe('Saved')
  expect(h.guard?.()).toBeNull()
})
