import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * Editor mã (CodeMirror 6) theo màu của app (biến CSS — tự đổi khi đổi theme sáng / tối).
 * Không điều khiển nội dung từ ngoài: nạp một lần (`initial`), đọc lại bằng ref.
 */

export interface CodeEditorHandle {
  text: () => string
  /** Thay toàn bộ nội dung (tải lại từ server) — giữ undo. */
  setText: (text: string) => void
  focus: () => void
}

export interface CursorInfo {
  line: number
  col: number
  /** Số ký tự đang chọn (0 = không chọn). */
  selected: number
}

const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--sh-surface)',
    color: 'var(--sh-fg)',
    fontSize: '13px'
  },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, monospace",
    lineHeight: '1.55'
  },
  '.cm-content': { caretColor: 'var(--sh-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sh-accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--sh-subtle)',
    color: 'var(--sh-faint)',
    borderRight: '1px solid var(--sh-line)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--sh-hover)', color: 'var(--sh-fg)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--sh-hover) 55%, transparent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--sh-accent) 24%, transparent)' },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--sh-accent) 14%, transparent)'
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--sh-accent) 22%, transparent)',
    outline: 'none'
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--sh-warning) 30%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--sh-warning) 60%, transparent)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--sh-accent) 35%, transparent)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--sh-subtle)',
    border: '1px solid var(--sh-line)',
    color: 'var(--sh-muted)'
  },
  '.cm-panels': {
    backgroundColor: 'var(--sh-elevated)',
    color: 'var(--sh-fg)',
    borderColor: 'var(--sh-line)'
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--sh-line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--sh-line)' },
  '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontSize: '12px',
    borderRadius: '5px'
  },
  '.cm-textfield': {
    backgroundColor: 'var(--sh-subtle)',
    border: '1px solid var(--sh-line)',
    color: 'var(--sh-fg)'
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--sh-subtle)',
    border: '1px solid var(--sh-line)',
    color: 'var(--sh-fg)'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--sh-elevated)',
    border: '1px solid var(--sh-line)',
    color: 'var(--sh-fg)'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--sh-accent-soft)',
    color: 'var(--sh-fg)'
  }
})

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword],
    color: 'var(--sh-syn-keyword)'
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: 'var(--sh-syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--sh-syn-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--sh-syn-comment)',
    fontStyle: 'italic'
  },
  {
    tag: [t.function(t.variableName), t.definition(t.variableName), t.labelName],
    color: 'var(--sh-syn-name)'
  },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--sh-syn-type)' },
  {
    tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)],
    color: 'var(--sh-syn-property)'
  },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--sh-syn-meta)' },
  { tag: [t.heading], fontWeight: '600', color: 'var(--sh-syn-name)' },
  { tag: [t.deleted, t.invalid], color: 'var(--sh-danger)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' }
])

export const CodeEditor = forwardRef<
  CodeEditorHandle,
  {
    initial: string
    /** Xuống dòng của file ('\r\n' = Windows) — giữ nguyên khi lưu. */
    lineSeparator: '\n' | '\r\n'
    language: Extension | null
    wrap: boolean
    readOnly?: boolean
    onChange: (text: () => string) => void
    onSave: () => void
    onCursor?: (c: CursorInfo) => void
    testId?: string
  }
>(function CodeEditor(
  { initial, lineSeparator, language, wrap, readOnly, onChange, onSave, onCursor, testId },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const langSlot = useRef(new Compartment())
  const wrapSlot = useRef(new Compartment())
  const roSlot = useRef(new Compartment())
  // Callback mới nhất (không dựng lại editor khi cha render lại).
  const cbs = useRef({ onChange, onSave, onCursor })
  useEffect(() => {
    cbs.current = { onChange, onSave, onCursor }
  })

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                cbs.current.onSave()
                return true
              }
            },
            indentWithTab
          ]),
          EditorState.lineSeparator.of(lineSeparator),
          theme,
          syntaxHighlighting(highlight),
          langSlot.current.of([]),
          wrapSlot.current.of([]),
          roSlot.current.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange(() => u.state.sliceDoc())
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head
              const line = u.state.doc.lineAt(head)
              cbs.current.onCursor?.({
                line: line.number,
                col: head - line.from + 1,
                selected: u.state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0)
              })
            }
          })
        ]
      })
    })
    view.current = v
    v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
    // Chỉ dựng một lần cho mỗi file (initial / lineSeparator đổi = tab khác).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: langSlot.current.reconfigure(language ?? []) })
  }, [language])
  useEffect(() => {
    view.current?.dispatch({
      effects: wrapSlot.current.reconfigure(wrap ? EditorView.lineWrapping : [])
    })
  }, [wrap])
  useEffect(() => {
    view.current?.dispatch({
      effects: roSlot.current.reconfigure(readOnly ? EditorState.readOnly.of(true) : [])
    })
  }, [readOnly])

  useImperativeHandle(ref, () => ({
    text: () => view.current?.state.sliceDoc() ?? '',
    setText: (text) => {
      const v = view.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    },
    focus: () => {
      view.current?.focus()
    }
  }))

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid={testId} />
})
