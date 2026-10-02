import { useCallback, useEffect, useRef, useState } from 'react'
import type { Extension } from '@codemirror/state'
import { AlertTriangle, FileCode, RotateCw, Save, WrapText } from 'lucide-react'
import { cleanError } from '../lib/format'
import { setCloseGuard, useTabs } from '../stores/tabs'
import { toast } from '../stores/toasts'
import { Button, cx } from '../components/ui'
import { CodeEditor, type CodeEditorHandle, type CursorInfo } from './CodeEditor'
import { editorDoc, looksBinary, type EditorDoc, type EditorVersion } from './docs'
import { allLanguages, languageOf } from './languages'

/**
 * Tab editor trong app: mở file trên server (SFTP / S3…), tô màu cú pháp, Ctrl+S lưu thẳng lên
 * nơi chứa. Lưu mà file đã bị sửa nơi khác → hỏi ghi đè / tải lại. Đóng tab còn thay đổi chưa lưu
 * → hỏi trước.
 */

type Loaded = { text: string; lineSeparator: '\n' | '\r\n'; version: EditorVersion | null }

const WRAP_KEY = 'shellhouse.editor.wrap'

export function EditorTabView({
  tabId,
  docKey,
  active
}: {
  tabId: string
  docKey: string
  active: boolean
}): React.JSX.Element {
  const doc = editorDoc(docKey)
  const editor = useRef<CodeEditorHandle>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(doc ? null : 'This file is no longer open.')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, col: 1, selected: 0 })
  const [langId, setLangId] = useState<string | null>(() =>
    doc ? (languageOf(doc.path)?.id ?? null) : null
  )
  /** Gói tô màu đã nạp (theo id — đổi ngôn ngữ thì gói cũ không còn dùng). */
  const [loadedLang, setLoadedLang] = useState<{ id: string; ext: Extension } | null>(null)
  const language = loadedLang && loadedLang.id === langId ? loadedLang.ext : null
  const [wrap, setWrap] = useState(() => {
    try {
      return window.localStorage.getItem(WRAP_KEY) === '1'
    } catch {
      return false
    }
  })
  /** Đổi mỗi lần tải lại từ server → dựng lại editor với nội dung mới. */
  const [generation, setGeneration] = useState(0)
  const version = useRef<EditorVersion | null>(null)
  const dirtyRef = useRef(false)

  const markDirty = (v: boolean): void => {
    dirtyRef.current = v
    setDirty(v)
  }

  /** Nội dung vừa đọc từ nơi chứa → editor (kiểm nhị phân / UTF-8, giữ kiểu xuống dòng). */
  const apply = useCallback(({ bytes, version: v }: Awaited<ReturnType<EditorDoc['read']>>) => {
    setError(null)
    if (looksBinary(bytes)) {
      setError('This looks like a binary file — it cannot be edited as text.')
      return
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      setError('This file is not UTF-8 text — download it and edit it locally instead.')
      return
    }
    version.current = v
    setLoaded({ text, lineSeparator: text.includes('\r\n') ? '\r\n' : '\n', version: v })
    dirtyRef.current = false
    setDirty(false)
    setConflict(false)
    setGeneration((g) => g + 1)
  }, [])
  const fail = useCallback((e: unknown) => {
    setError(cleanError(e))
  }, [])
  const load = useCallback(() => {
    void doc?.read().then(apply, fail)
  }, [doc, apply, fail])

  useEffect(() => {
    void doc?.read().then(apply, fail)
  }, [doc, apply, fail])

  // Ngôn ngữ: nạp lười gói tô màu.
  useEffect(() => {
    let cancelled = false
    const info = allLanguages().find((l) => l.id === langId)
    if (!info) return
    void info.load().then((ext) => {
      if (!cancelled) setLoadedLang({ id: info.id, ext })
    })
    return () => {
      cancelled = true
    }
  }, [langId])

  // Đóng tab còn thay đổi chưa lưu → hỏi.
  useEffect(() => {
    setCloseGuard(tabId, () => {
      if (!dirtyRef.current) return true
      return window.confirm(`Discard your unsaved changes to ${doc?.name ?? 'this file'}?`)
    })
    return () => {
      setCloseGuard(tabId, null)
    }
  }, [tabId, doc])

  // Tiêu đề tab có dấu • khi chưa lưu.
  useEffect(() => {
    if (!doc) return
    useTabs.getState().setTitle(tabId, dirty ? `● ${doc.name}` : doc.name)
  }, [dirty, doc, tabId])

  useEffect(() => {
    if (active && loaded) editor.current?.focus()
  }, [active, loaded])

  const save = useCallback(
    async (force = false) => {
      if (!doc || !editor.current || saving) return
      setSaving(true)
      const text = editor.current.text()
      try {
        const next = await doc.write(new TextEncoder().encode(text), force ? null : version.current)
        version.current = next
        markDirty(false)
        setConflict(false)
        toast.success(`Saved ${doc.name}`, { group: `editor-save:${docKey}`, duration: 2000 })
      } catch (e) {
        if (doc.isConflict(e)) setConflict(true)
        else toast.error(`Could not save ${doc.name}`, { description: cleanError(e) })
      } finally {
        setSaving(false)
      }
    },
    [doc, docKey, saving]
  )

  if (!doc) {
    return <EditorMessage text={error ?? 'This file is no longer open.'} />
  }

  return (
    <div className="flex size-full min-h-0 flex-col bg-surface" data-testid="editor">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <FileCode size={14} className="shrink-0 text-faint" />
        <span
          className="min-w-0 truncate font-mono text-fg"
          title={doc.path}
          data-testid="editor-path"
        >
          {doc.path}
        </span>
        <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-[11px] text-muted">
          {doc.where}
        </span>
        <span
          className={cx('shrink-0 text-[11px]', dirty ? 'text-warning' : 'text-faint')}
          data-testid="editor-state"
        >
          {saving ? 'Saving…' : dirty ? 'Modified' : loaded ? 'Saved' : 'Loading…'}
        </span>
        <div className="flex-1" />
        <select
          aria-label="Language"
          data-testid="editor-language"
          className="h-7 cursor-pointer rounded-md border border-line bg-transparent px-1.5 text-xs text-muted outline-none hover:text-fg"
          value={langId ?? ''}
          onChange={(e) => {
            setLangId(e.target.value || null)
          }}
        >
          <option value="">Plain text</option>
          {allLanguages().map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={wrap}
          title="Wrap long lines"
          className={cx(
            'flex size-7 items-center justify-center rounded-md',
            wrap ? 'bg-accent-soft text-fg' : 'text-faint hover:bg-hover hover:text-fg'
          )}
          onClick={() => {
            setWrap(!wrap)
            try {
              window.localStorage.setItem(WRAP_KEY, wrap ? '0' : '1')
            } catch {
              // Bỏ qua.
            }
          }}
        >
          <WrapText size={14} />
        </button>
        <button
          type="button"
          title="Reload from the server"
          data-testid="editor-reload"
          className="flex size-7 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg"
          onClick={() => {
            if (dirtyRef.current && !window.confirm('Discard your changes and reload the file?'))
              return
            load()
          }}
        >
          <RotateCw size={14} />
        </button>
        <Button
          variant="primary"
          size="sm"
          icon={<Save size={13} />}
          data-testid="editor-save"
          disabled={!loaded || saving || !dirty}
          onClick={() => void save()}
        >
          Save
        </Button>
      </div>
      {conflict && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-warning-soft px-3 py-2 text-xs"
          data-testid="editor-conflict"
        >
          <AlertTriangle size={14} className="text-warning" />
          <span className="text-fg">{doc.name} was changed on the server since you opened it.</span>
          <div className="flex-1" />
          <Button size="sm" data-testid="editor-overwrite" onClick={() => void save(true)}>
            Overwrite with mine
          </Button>
          <Button size="sm" variant="ghost" data-testid="editor-take-theirs" onClick={() => { load(); }}>
            Reload theirs
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {error ? (
          <EditorMessage text={error} />
        ) : loaded ? (
          <CodeEditor
            key={generation}
            ref={editor}
            initial={loaded.text}
            lineSeparator={loaded.lineSeparator}
            language={language}
            wrap={wrap}
            testId="editor-code"
            onChange={() => {
              if (!dirtyRef.current) markDirty(true)
            }}
            onSave={() => void save()}
            onCursor={setCursor}
          />
        ) : (
          <EditorMessage text="Opening…" />
        )}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-subtle px-3 text-[11px] text-faint tabular-nums">
        <span data-testid="editor-cursor">
          Ln {cursor.line}, Col {cursor.col}
          {cursor.selected ? ` (${cursor.selected} selected)` : ''}
        </span>
        {loaded && <span>{loaded.lineSeparator === '\r\n' ? 'CRLF' : 'LF'}</span>}
        <span>UTF-8</span>
        <div className="flex-1" />
        <span>Ctrl+S save · Ctrl+F find · Ctrl+Z undo</span>
      </div>
    </div>
  )
}

function EditorMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      className="flex size-full items-center justify-center p-6 text-center text-xs text-faint"
      data-testid="editor-message"
    >
      {text}
    </div>
  )
}
