import { useCallback, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { ImportCandidate } from '@shared/hosts'
import { Button, Modal, Notice, Segmented } from './ui'

type Source = 'ssh-config' | 'mobaxterm'

interface Scan {
  candidates: ImportCandidate[]
  /** MobaXterm: file đã đọc (null = chưa có file). */
  file?: string | null
  /** MobaXterm: phiên không phải SSH bị bỏ qua. */
  ignored?: Record<string, number>
}

const DESCRIPTION: Record<Source, string> = {
  'ssh-config': 'Wildcard patterns are skipped. Nothing in the file is executed.',
  mobaxterm:
    'SSH sessions and their folders are imported. Saved passwords are never read from MobaXterm.'
}

function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

const scanSshConfig = (): Promise<Scan> =>
  window.shellhouse.scanSshConfig().then((candidates) => ({ candidates }))

export function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [source, setSource] = useState<Source>('ssh-config')
  const [scan, setScan] = useState<Scan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((request: Promise<Scan>): void => {
    void request.then(
      (s) => {
        setScan(s)
        setSelected(
          new Set(s.candidates.filter((c) => !c.duplicate && !c.problem).map((c) => c.alias))
        )
      },
      (e: unknown) => {
        setScan({ candidates: [] })
        setError(cleanError(e))
      }
    )
  }, [])

  const load = (next: Source, pick: boolean): void => {
    setScan(null)
    setError(null)
    apply(next === 'ssh-config' ? scanSshConfig() : window.shellhouse.scanMobaXterm(pick))
  }

  useEffect(() => {
    apply(scanSshConfig())
  }, [apply])

  const toggle = (alias: string): void => {
    const next = new Set(selected)
    if (next.has(alias)) next.delete(alias)
    else next.add(alias)
    setSelected(next)
  }

  const run = async (): Promise<void> => {
    const aliases = [...selected]
    try {
      const { imported, skipped } =
        source === 'ssh-config'
          ? await window.shellhouse.importSshConfig(aliases)
          : await window.shellhouse.importMobaXterm(aliases)
      setResult(
        `Imported ${imported} host${imported === 1 ? '' : 's'}.` +
          (skipped.length ? ` Skipped: ${skipped.join(', ')}.` : '')
      )
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const candidates = scan?.candidates ?? null
  const ignored = Object.entries(scan?.ignored ?? {})
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
      title="Import hosts"
      description={DESCRIPTION[source]}
      onClose={onClose}
      width="max-w-2xl"
      testId="import-dialog"
      footer={footer}
    >
      {!result && (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={source}
            testIdPrefix="import-source"
            options={[
              { value: 'ssh-config', label: '~/.ssh/config' },
              { value: 'mobaxterm', label: 'MobaXterm' }
            ]}
            onChange={(next) => {
              setSource(next)
              load(next, false)
            }}
          />
          {source === 'mobaxterm' && (
            <>
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-faint"
                title={scan?.file ?? undefined}
                data-testid="import-file"
              >
                {scan?.file ?? ''}
              </span>
              <Button
                size="sm"
                icon={<FolderOpen size={13} />}
                data-testid="import-choose-file"
                onClick={() => {
                  load('mobaxterm', true)
                }}
              >
                Choose file…
              </Button>
            </>
          )}
        </div>
      )}
      {scan === null && <p className="text-sm text-muted">Reading…</p>}
      {error && (
        <Notice tone="danger" testId="import-error">
          {error}
        </Notice>
      )}
      {!error && !result && candidates?.length === 0 && (
        <p className="text-sm text-muted" data-testid="import-empty">
          {source === 'ssh-config'
            ? 'No hosts found in ~/.ssh/config.'
            : scan?.file
              ? 'No SSH sessions found in this file.'
              : 'MobaXterm.ini was not found in the usual place. Choose the file — portable MobaXterm keeps it next to MobaXterm.exe.'}
        </p>
      )}
      {!result && ignored.length > 0 && (
        <p className="text-xs text-faint" data-testid="import-ignored">
          Not imported (not SSH): {ignored.map(([kind, n]) => `${n} ${kind}`).join(', ')}.
        </p>
      )}
      {candidates && candidates.length > 0 && !result && (
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-subtle text-xs text-muted">
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
                  <td className="px-3 py-2">
                    {c.group && c.group.length > 0 && (
                      <span className="block text-[11px] text-faint">{c.group.join(' › ')}</span>
                    )}
                    <span className="text-fg">{c.label ?? c.alias}</span>
                  </td>
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
