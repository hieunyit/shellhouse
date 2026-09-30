import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Search } from 'lucide-react'
import { bestScore } from '@shared/fuzzy'
import {
  renderSnippet,
  SnippetInput,
  snippetVariables,
  type SnippetSummary
} from '@shared/snippets'
import { Button, Checkbox, cx, Field, Input, Modal, Notice, TextArea } from './ui'

type Mode =
  { kind: 'run'; snippet: SnippetSummary } | { kind: 'edit'; snippet: SnippetSummary | null }

export function SnippetsDialog({
  onClose,
  onInsert,
  canInsert
}: {
  onClose: () => void
  /** macro = chạy từng dòng, chờ dấu nhắc (MultiExec: trên mọi terminal đang bật). */
  onInsert: (text: string, run: boolean, macro: boolean) => void
  canInsert: boolean
}): React.JSX.Element {
  const [snippets, setSnippets] = useState<SnippetSummary[]>([])
  const [version, setVersion] = useState(0)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.shellhouse.listSnippets().then((list) => {
      if (!cancelled) setSnippets(list)
    })
    return () => {
      cancelled = true
    }
  }, [version])

  const results = useMemo(() => {
    if (!query.trim()) return snippets
    return snippets
      .map((s) => ({ s, score: bestScore(query, [s.name, s.body, ...s.tags]) }))
      .filter((r): r is { s: SnippetSummary; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.s)
  }, [snippets, query])

  return (
    <Modal title="Snippets" onClose={onClose} width="max-w-3xl" testId="snippets-dialog">
      <div className="flex h-[26rem] gap-4">
        <div className="flex w-64 shrink-0 flex-col gap-2">
          <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-subtle px-2 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20">
            <Search size={14} className="text-faint" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              placeholder="Search snippets…"
              data-testid="snippet-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, results.length - 1))
                if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
                if (e.key === 'Enter') {
                  // Otherwise this same Enter would submit the variables form that appears next
                  // (and run the command) before the user can fill it in.
                  e.preventDefault()
                  const s = results[cursor]
                  if (s) setMode({ kind: 'run', snippet: s })
                }
              }}
            />
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto rounded-md border border-line"
            role="listbox"
          >
            {results.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === cursor}
                data-testid="snippet-item"
                data-name={s.name}
                className={cx(
                  'block w-full border-b border-line px-3 py-2 text-left last:border-b-0',
                  mode?.snippet?.id === s.id || i === cursor ? 'bg-accent-soft' : 'hover:bg-hover'
                )}
                onClick={() => {
                  setCursor(i)
                  setMode({ kind: 'run', snippet: s })
                }}
              >
                <span className="block truncate text-[13px] text-fg">{s.name}</span>
                <span className="block truncate font-mono text-xs text-faint">{s.body}</span>
              </button>
            ))}
            {results.length === 0 && <p className="p-3 text-xs text-faint">No snippets yet.</p>}
          </div>
          <Button
            icon={<Plus size={14} />}
            data-testid="snippet-new"
            onClick={() => {
              setMode({ kind: 'edit', snippet: null })
            }}
          >
            New snippet
          </Button>
        </div>
        <div className="min-w-0 flex-1">
          {mode?.kind === 'run' && (
            <RunForm
              key={mode.snippet.id}
              snippet={mode.snippet}
              canInsert={canInsert}
              onEdit={() => {
                setMode({ kind: 'edit', snippet: mode.snippet })
              }}
              onInsert={(text, run) => {
                onInsert(text, run, mode.snippet.mode === 'macro')
                onClose()
              }}
            />
          )}
          {mode?.kind === 'edit' && (
            <EditForm
              key={mode.snippet?.id ?? 'new'}
              snippet={mode.snippet}
              onDone={(saved) => {
                setVersion((v) => v + 1)
                setMode(saved ? { kind: 'run', snippet: saved } : null)
              }}
            />
          )}
          {!mode && (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line p-6 text-center text-xs text-muted">
              <p>
                Pick a snippet to insert it into the active terminal.
                <br />
                Use <code className="text-fg">{'{{name}}'}</code> for a required variable or{' '}
                <code className="text-fg">{'{{name:default}}'}</code> for one with a default.
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function RunForm({
  snippet,
  canInsert,
  onEdit,
  onInsert
}: {
  snippet: SnippetSummary
  canInsert: boolean
  onEdit: () => void
  onInsert: (text: string, run: boolean) => void
}): React.JSX.Element {
  const vars = snippetVariables(snippet.body)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v.name, v.defaultValue ?? '']))
  )
  const [error, setError] = useState<string | null>(null)
  const preview = ((): string => {
    try {
      return renderSnippet(snippet.body, values)
    } catch {
      return snippet.body
    }
  })()
  const submit = (run: boolean): void => {
    try {
      onInsert(renderSnippet(snippet.body, values), run)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <form
      className="flex h-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit(true)
      }}
    >
      <div className="flex items-center">
        <h3 className="flex-1 text-sm font-semibold">{snippet.name}</h3>
        <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={onEdit}>
          Edit
        </Button>
      </div>
      {vars.map((v, i) => (
        <Field key={v.name} label={v.name}>
          <Input
            autoFocus={i === 0}
            mono
            data-testid={`snippet-var-${v.name}`}
            value={values[v.name] ?? ''}
            onChange={(e) => {
              setValues({ ...values, [v.name]: e.target.value })
            }}
          />
        </Field>
      ))}
      {snippet.mode === 'macro' && (
        <Notice testId="snippet-macro-note">
          Macro: each line is sent after the previous one returns to the prompt. In MultiExec it
          runs in every selected terminal. Press Ctrl+C in a terminal to stop it there.
        </Notice>
      )}
      <pre
        className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-subtle p-2.5 font-mono text-xs whitespace-pre-wrap text-fg"
        data-testid="snippet-preview"
      >
        {preview}
      </pre>
      {error && <Notice tone="danger">{error}</Notice>}
      {!canInsert && <Notice tone="warning">No connected terminal tab.</Notice>}
      <div className="flex justify-end gap-2">
        {snippet.mode !== 'macro' && (
          <Button
            disabled={!canInsert}
            data-testid="snippet-insert"
            onClick={() => {
              submit(false)
            }}
          >
            Insert
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!canInsert} data-testid="snippet-run">
          {snippet.mode === 'macro' ? 'Run macro' : 'Insert and run'}
        </Button>
      </div>
    </form>
  )
}

function EditForm({
  snippet,
  onDone
}: {
  snippet: SnippetSummary | null
  onDone: (saved: SnippetSummary | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(snippet?.name ?? '')
  const [body, setBody] = useState(snippet?.body ?? '')
  const [tags, setTags] = useState(snippet?.tags.join(', ') ?? '')
  const [macro, setMacro] = useState(snippet?.mode === 'macro')
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="flex h-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        const parsed = SnippetInput.safeParse({
          ...(snippet ? { id: snippet.id } : {}),
          name,
          body,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          mode: macro ? 'macro' : 'paste'
        })
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Invalid input')
          return
        }
        void window.shellhouse.saveSnippet(parsed.data).then((result) => {
          if (!result.ok) setError(result.message)
          else
            onDone({
              id: result.id,
              name: parsed.data.name,
              body: parsed.data.body,
              tags: parsed.data.tags,
              mode: parsed.data.mode ?? 'paste',
              updatedAt: Date.now()
            })
        })
      }}
    >
      <Input
        autoFocus
        placeholder="Name"
        data-testid="snippet-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value)
        }}
      />
      <TextArea
        className="min-h-0 flex-1"
        placeholder={'e.g. tail -n {{lines:100}} -f {{file}}'}
        spellCheck={false}
        data-testid="snippet-body"
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
        }}
      />
      <Input
        placeholder="Tags, comma separated"
        value={tags}
        onChange={(e) => {
          setTags(e.target.value)
        }}
      />
      <Checkbox
        label="Macro: send line by line, waiting for the prompt"
        description="For multi-step jobs on several servers (MultiExec). Special lines: “# wait 5” pauses 5 s, “# expect Password:” waits for that text."
        checked={macro}
        data-testid="snippet-macro"
        onChange={(e) => {
          setMacro(e.target.checked)
        }}
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex gap-2">
        {snippet && (
          <Button
            variant="danger-ghost"
            onClick={() =>
              void window.shellhouse.deleteSnippet(snippet.id).then(() => {
                onDone(null)
              })
            }
          >
            Delete
          </Button>
        )}
        <div className="flex-1" />
        <Button
          onClick={() => {
            onDone(snippet)
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" data-testid="snippet-save">
          Save
        </Button>
      </div>
    </form>
  )
}
