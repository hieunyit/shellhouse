import { useEffect, useState } from 'react'
import type { ImportCandidate } from '@shared/hosts'
import { Button, Modal, Notice } from './ui'

export function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)

  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.shellhouse.scanSshConfig().then(
      (list) => {
        setCandidates(list)
        setSelected(new Set(list.filter((c) => !c.duplicate && !c.problem).map((c) => c.alias)))
      },
      (e: unknown) => {
        setCandidates([])
        setError(
          (e instanceof Error ? e.message : String(e)).replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            ''
          )
        )
      }
    )
  }, [])

  const toggle = (alias: string): void => {
    const next = new Set(selected)
    if (next.has(alias)) next.delete(alias)
    else next.add(alias)
    setSelected(next)
  }

  const run = async (): Promise<void> => {
    const { imported, skipped } = await window.shellhouse.importSshConfig([...selected])
    setResult(
      `Imported ${imported} host${imported === 1 ? '' : 's'}.` +
        (skipped.length ? ` Skipped: ${skipped.join(', ')}.` : '')
    )
  }

  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  ) : (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button
        variant="primary"
        disabled={!candidates?.length || selected.size === 0}
        data-testid="import-run"
        onClick={() => void run()}
      >
        Import {selected.size} host{selected.size === 1 ? '' : 's'}
      </Button>
    </>
  )

  return (
    <Modal
      title="Import from ~/.ssh/config"
      description="Wildcard patterns are skipped. Nothing in the file is executed."
      onClose={onClose}
      width="max-w-2xl"
      testId="import-dialog"
      footer={footer}
    >
      {candidates === null && <p className="text-sm text-muted">Reading…</p>}
      {error && (
        <Notice tone="danger" testId="import-error">
          {error}
        </Notice>
      )}
      {!error && candidates?.length === 0 && (
        <p className="text-sm text-muted">No hosts found in ~/.ssh/config.</p>
      )}
      {candidates && candidates.length > 0 && !result && (
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-subtle text-xs text-muted">
              <tr>
                <th className="w-9 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Host</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.alias}
                  className="border-t border-line"
                  data-testid={`import-row-${c.alias}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--sh-accent)]"
                      disabled={!!c.problem}
                      checked={selected.has(c.alias)}
                      onChange={() => {
                        toggle(c.alias)
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 text-fg">{c.alias}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted">
                    {c.username ?? '?'}@{c.hostname}
                    {c.port === 22 ? '' : `:${c.port}`}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {c.problem && <span className="text-danger">{c.problem}</span>}
                    {!c.problem && c.duplicate && (
                      <span className="text-warning">A host with this name already exists</span>
                    )}
                    {!c.problem && c.proxyJump && (
                      <span className="text-faint">via {c.proxyJump}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && (
        <Notice tone="success" testId="import-result">
          {result}
        </Notice>
      )}
    </Modal>
  )
}
