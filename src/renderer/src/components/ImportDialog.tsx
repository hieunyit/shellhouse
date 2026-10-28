import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FolderOpen, RefreshCw } from 'lucide-react'
import { Username, type ImportCandidate, type ImportOptions } from '@shared/hosts'
import { t, tn } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import { useHosts } from '../stores/hosts'
import { importKey } from './accounts/ImportKeyDialog'
import { Button, Field, Input, Modal, Notice, Select } from './ui'

const PAGE_SIZE = 100

type Source = 'ssh-config' | 'mobaxterm' | 'csv' | 'ansible' | 'rdp' | 'yaml'

interface Scan {
  candidates: ImportCandidate[]
  /** MobaXterm: file đã đọc (null = chưa có file). */
  file?: string | null
  /** MobaXterm / CSV: phiên không phải SSH bị bỏ qua. */
  ignored?: Record<string, number>
  /** CSV: cột chứa bí mật (Password…) đã bị bỏ qua. */
  secretColumns?: string[]
}

function description(source: Source): string {
  switch (source) {
    case 'ssh-config':
      return t('Wildcard patterns are skipped. Nothing in the file is executed.')
    case 'mobaxterm':
      return t(
        'SSH sessions are imported into the selected group. Saved passwords are never read from MobaXterm.'
      )
    case 'csv':
      return t(
        'Termius or spreadsheet export. Columns are matched by name; passwords are never imported.'
      )
    case 'ansible':
      return t(
        'An Ansible inventory (INI or YAML). Hosts are imported into the selected group; ansible_host, ansible_port, ansible_user and the key file are used. Passwords and vault values are never read.'
      )
    case 'yaml':
      return t(
        'A file saved with Export hosts (Shellhouse YAML). Hosts are imported into the selected group; passwords are never in it.'
      )
    case 'rdp':
      return t(
        'Remote Desktop (.rdp) files saved by mstsc or Windows App. Each file becomes an RDP host; saved passwords are not imported.'
      )
  }
}

function cleanError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

const scanSshConfig = (): Promise<Scan> =>
  window.shellhouse.scanSshConfig().then((candidates) => ({ candidates }))

export function ImportDialog({
  onClose,
  initialGroupId = null
}: {
  onClose: () => void
  initialGroupId?: string | null
}): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null)
  const scanRequest = useRef(0)
  const importing = useRef(false)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<Source>('ssh-config')
  const [scan, setScan] = useState<Scan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Nhóm đích có sẵn cho mọi host đã chọn ('' = không nhóm). */
  const [groupId, setGroupId] = useState(initialGroupId ?? '')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [keyId, setKeyId] = useState('')
  const [jumpHostId, setJumpHostId] = useState('')
  /** User SSH cho mọi host đã chọn ('' = theo file). */
  const [username, setUsername] = useState('')
  const tree = useHosts((s) => s.tree)
  const groupTree = useHosts((s) => s.groupTree)

  const changePage = (next: number): void => {
    setPage(next)
    if (previewRef.current) previewRef.current.scrollTop = 0
  }

  const apply = useCallback((request: Promise<Scan>, id: number): void => {
    void request.then(
      (s) => {
        if (id !== scanRequest.current) return
        setError(null)
        setScan(s)
        setSelected(
          new Set(s.candidates.filter((c) => !c.duplicate && !c.problem).map((c) => c.alias))
        )
      },
      (e: unknown) => {
        if (id !== scanRequest.current) return
        setScan({ candidates: [] })
        setError(cleanError(e))
      }
    )
  }, [])

  const load = (next: Source, pick: boolean): void => {
    const id = ++scanRequest.current
    setError(null)
    setSelected(new Set())
    setQuery('')
    setPage(0)
    // CSV / .rdp: không có vị trí mặc định — chờ người dùng chọn file.
    if ((next === 'csv' || next === 'ansible' || next === 'rdp' || next === 'yaml') && !pick) {
      setScan({ candidates: [], file: null })
      return
    }
    setScan(null)
    apply(
      next === 'ssh-config'
        ? scanSshConfig()
        : next === 'csv'
          ? window.shellhouse.scanCsv()
          : next === 'ansible'
            ? window.shellhouse.scanAnsible()
            : next === 'yaml'
              ? window.shellhouse.scanShellhouseYaml()
              : next === 'rdp'
                ? window.shellhouse.scanRdpFiles()
                : window.shellhouse.scanMobaXterm(pick),
      id
    )
  }

  useEffect(() => {
    const generation = scanRequest
    apply(scanSshConfig(), ++generation.current)
    return () => {
      generation.current++
    }
  }, [apply])

  const toggle = (alias: string): void => {
    const next = new Set(selected)
    if (next.has(alias)) next.delete(alias)
    else next.add(alias)
    setSelected(next)
  }

  const run = async (): Promise<void> => {
    if (importing.current) return
    importing.current = true
    setBusy(true)
    setError(null)
    const aliases = [...selected]
    const options: ImportOptions = {
      ...(groupId ? { groupId } : {}),
      ...(keyId ? { keyId } : {}),
      ...(jumpHostId ? { jumpHostId } : {}),
      ...(user ? { username: user } : {})
    }
    try {
      const { imported, skipped } =
        source === 'ssh-config'
          ? await window.shellhouse.importSshConfig(aliases, options)
          : source === 'csv'
            ? await window.shellhouse.importCsv(aliases, options)
            : source === 'ansible'
              ? await window.shellhouse.importAnsible(aliases, options)
              : source === 'yaml'
                ? await window.shellhouse.importShellhouseYaml(aliases, options)
                : source === 'rdp'
                  ? await window.shellhouse.importRdpFiles(aliases, {
                      ...(groupId ? { groupId } : {})
                    })
                  : await window.shellhouse.importMobaXterm(aliases, options)
      setResult(
        tn(imported, 'Imported {n} host.', 'Imported {n} hosts.') +
          (skipped.length ? ' ' + t('Skipped: {names}.', { names: skipped.join(', ') }) : '')
      )
    } catch (e) {
      setError(cleanError(e))
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  const candidates = scan?.candidates ?? null
  const importable = useMemo(() => (candidates ?? []).filter((c) => !c.problem), [candidates])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (candidates ?? []).filter(
      (c) =>
        !needle ||
        [
          c.alias,
          c.label ?? '',
          c.hostname,
          c.username ?? '',
          ...(c.group ?? []),
          ...(c.tags ?? [])
        ].some((value) => value.toLowerCase().includes(needle))
    )
  }, [candidates, query])
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1))
  const offset = currentPage * PAGE_SIZE
  const visible = filtered.slice(offset, offset + PAGE_SIZE)
  const allSelected = importable.length > 0 && importable.every((c) => selected.has(c.alias))
  const invalidCount = (candidates?.length ?? 0) - importable.length
  const duplicateCount = importable.filter((c) => c.duplicate).length
  const groupMissing = !!groupId && !tree.groups.some((g) => g.id === groupId)
  const user = username.trim()
  const userError =
    source !== 'rdp' && user && !Username.safeParse(user).success ? t('Invalid username') : null
  // Host đã chọn mà file không ghi user — cần điền ô User (RDP: user không bắt buộc).
  const missingUser =
    source === 'rdp' || user
      ? 0
      : (candidates ?? []).filter((c) => selected.has(c.alias) && !c.username).length
  const ignored = Object.entries(scan?.ignored ?? {})
  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      {t('Done')}
    </Button>
  ) : (
    <>
      <Button disabled={busy} onClick={onClose}>
        {t('Cancel')}
      </Button>
      <Button
        variant="primary"
        disabled={
          busy ||
          groupMissing ||
          !candidates?.length ||
          selected.size === 0 ||
          userError !== null ||
          missingUser > 0
        }
        data-testid="import-run"
        onClick={() => void run()}
      >
        {tn(selected.size, 'Import {n} host', 'Import {n} hosts')}
      </Button>
    </>
  )

  return (
    <Modal
      title={t('Import hosts')}
      description={description(source)}
      onClose={onClose}
      width="max-w-2xl"
      testId="import-dialog"
      footer={footer}
    >
      <fieldset disabled={busy} className="min-w-0 space-y-3 border-0 p-0">
        {!result && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('Source')}>
                <Select
                  aria-label={t('Source')}
                  data-testid="import-source"
                  value={source}
                  onChange={(e) => {
                    if (importing.current) return
                    const next = e.target.value as Source
                    setSource(next)
                    load(next, false)
                  }}
                >
                  <option value="ssh-config">~/.ssh/config</option>
                  <option value="mobaxterm">MobaXterm</option>
                  <option value="csv">CSV / Termius</option>
                  <option value="ansible">Ansible</option>
                  <option value="rdp">Remote Desktop (.rdp)</option>
                  <option value="yaml">Shellhouse YAML</option>
                </Select>
              </Field>
              <Field
                label={t('Into group')}
                hint={
                  groupMissing ? (
                    <span className="text-danger">
                      {t('The selected group no longer exists. Choose another group.')}
                    </span>
                  ) : (
                    t(
                      'All selected hosts go directly into this group. Source folders are not created.'
                    )
                  )
                }
              >
                <Select
                  aria-label={t('Into group')}
                  aria-invalid={groupMissing}
                  data-testid="import-option-group"
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value)
                  }}
                >
                  <option value="">{t('No group')}</option>
                  {tree.groups
                    .map((g) => ({ id: g.id, path: groupTree.path(g.id).join(' › ') }))
                    .sort((a, b) => a.path.localeCompare(b.path))
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.path}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-subtle/50 p-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
                title={source === 'ssh-config' ? '~/.ssh/config' : (scan?.file ?? undefined)}
                data-testid="import-file"
              >
                {source === 'ssh-config' ? '~/.ssh/config' : scan?.file || t('No file selected')}
              </span>
              <Button
                size="sm"
                icon={source === 'ssh-config' ? <RefreshCw size={13} /> : <FolderOpen size={13} />}
                disabled={busy || scan === null}
                data-testid="import-choose-file"
                onClick={() => {
                  load(source, true)
                }}
              >
                {source === 'ssh-config'
                  ? t('Refresh')
                  : source === 'rdp'
                    ? t('Choose files…')
                    : t('Choose file…')}
              </Button>
            </div>
          </div>
        )}
        {scan === null && <p className="text-sm text-muted">{t('Reading…')}</p>}
        {error && (
          <Notice tone="danger" testId="import-error">
            {error}
          </Notice>
        )}
        {!error && !result && candidates?.length === 0 && (
          <p className="text-sm text-muted" data-testid="import-empty">
            {source === 'ssh-config'
              ? t('No hosts found in ~/.ssh/config.')
              : scan?.file
                ? t('No SSH sessions found in this file.')
                : source === 'rdp'
                  ? t('Choose one or more .rdp files.')
                  : source === 'yaml'
                    ? t('Choose a file saved with Export hosts.')
                    : source === 'ansible'
                      ? t(
                          'Choose an Ansible inventory file — the hosts file (INI) or inventory.yml.'
                        )
                      : source === 'csv'
                        ? t(
                            'Choose a CSV file. In Termius: export your hosts as CSV. A header row with Hostname (or Host / IP) is required; Label, Port, Username, Group and Tags are used when present.'
                          )
                        : t(
                            'MobaXterm.ini was not found in the usual place. Choose the file — portable MobaXterm keeps it next to MobaXterm.exe.'
                          )}
          </p>
        )}
        {!result && ignored.length > 0 && (
          <p className="text-xs text-faint" data-testid="import-ignored">
            {t('Not imported (not SSH): {list}.', {
              list: ignored.map(([kind, n]) => `${formatNumber(n)} ${kind}`).join(', ')
            })}
          </p>
        )}
        {!result && (scan?.secretColumns?.length ?? 0) > 0 && (
          <p className="text-xs text-faint" data-testid="import-secrets-skipped">
            {source === 'ansible'
              ? t(
                  'Ignored variables with secrets: {names}. Add passwords or keys after importing.',
                  {
                    names: scan?.secretColumns?.join(', ') ?? ''
                  }
                )
              : t(
                  'Ignored columns with secrets: {columns}. Add passwords or keys after importing.',
                  {
                    columns: scan?.secretColumns?.join(', ') ?? ''
                  }
                )}
          </p>
        )}
        {candidates && candidates.length > 0 && !result && (
          <div className="space-y-2">
            <div
              className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"
              aria-live="polite"
              data-testid="import-summary"
            >
              <span>{tn(selected.size, '{n} host selected', '{n} hosts selected')}</span>
              <span>
                {tn(duplicateCount, '{n} duplicate', '{n} duplicates')} ·{' '}
                {tn(invalidCount, '{n} invalid entry', '{n} invalid entries')}
              </span>
            </div>
            <Input
              aria-label={t('Search import preview')}
              placeholder={t('Search hosts, addresses, tags')}
              data-testid="import-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                changePage(0)
              }}
            />
            <div
              className="max-h-[32vh] overflow-auto rounded-lg border border-line"
              ref={previewRef}
              data-testid="import-preview"
            >
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 bg-subtle text-xs text-muted">
                  <tr>
                    <th className="w-9 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('Select all importable hosts')}
                        ref={(input) => {
                          if (input) input.indeterminate = !allSelected && selected.size > 0
                        }}
                        className="accent-[var(--sh-accent)]"
                        data-testid="import-select-all"
                        checked={allSelected}
                        onChange={(e) => {
                          setSelected(
                            e.target.checked ? new Set(importable.map((c) => c.alias)) : new Set()
                          )
                        }}
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">{t('Host')}</th>
                    <th className="px-3 py-2 font-medium">{t('Target')}</th>
                    <th className="px-3 py-2 font-medium">{t('Notes')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr
                      key={c.alias}
                      className="border-t border-line"
                      data-testid={`import-row-${c.alias}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="accent-[var(--sh-accent)]"
                          aria-label={t('Select {name}', { name: c.alias })}
                          disabled={!!c.problem}
                          checked={selected.has(c.alias)}
                          onChange={() => {
                            toggle(c.alias)
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {c.group && c.group.length > 0 && (
                          <span className="block text-xs text-faint">{c.group.join(' › ')}</span>
                        )}
                        <span className="text-fg">{c.label ?? c.alias}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted">
                        {source === 'rdp' ? (
                          c.username ? (
                            `${c.username}@`
                          ) : (
                            ''
                          )
                        ) : user ? (
                          <span className="text-fg">{user}@</span>
                        ) : c.username ? (
                          `${c.username}@`
                        ) : (
                          <span className="text-warning">?@</span>
                        )}
                        {c.hostname}
                        {c.port === (source === 'rdp' ? 3389 : 22) ? '' : `:${c.port}`}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {c.problem && <span className="text-danger">{c.problem}</span>}
                        {!c.problem && keyId && ((c.warning && source !== 'yaml') || c.keyFile) && (
                          <span className="block text-muted" data-testid="import-key-note">
                            {t('Uses key {name}', {
                              name: tree.keys.find((k) => k.id === keyId)?.name ?? ''
                            })}
                          </span>
                        )}
                        {!c.problem && (source === 'yaml' || !keyId) && c.warning && (
                          <span className="block text-warning" data-testid="import-warning">
                            {c.warning}
                            {source !== 'yaml' && (
                              <> — {t('choose a key below or add one later')}</>
                            )}
                          </span>
                        )}
                        {!c.problem && !c.username && !user && source !== 'rdp' && (
                          <span className="block text-warning" data-testid="import-no-user">
                            {t('No user in the file — enter one under User')}
                          </span>
                        )}
                        {!c.problem && c.duplicate && (
                          <span className="text-warning">
                            {t('A host with this name already exists')}
                          </span>
                        )}
                        {!c.problem && c.proxyJump && (
                          <span className="text-faint">
                            {t('via {host}', { host: c.proxyJump })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-4 text-center text-muted">
                        {t('No matching hosts.')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span data-testid="import-preview-count">
                {t('Showing {from}–{to} of {total} hosts', {
                  from: filtered.length ? formatNumber(offset + 1) : '0',
                  to: formatNumber(Math.min(offset + PAGE_SIZE, filtered.length)),
                  total: formatNumber(filtered.length)
                })}
              </span>
              {filtered.length > PAGE_SIZE && (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    icon={<ChevronLeft size={13} />}
                    disabled={currentPage === 0}
                    data-testid="import-previous"
                    onClick={() => {
                      changePage(currentPage - 1)
                    }}
                  >
                    {t('Previous page')}
                  </Button>
                  <Button
                    size="sm"
                    icon={<ChevronRight size={13} />}
                    disabled={offset + PAGE_SIZE >= filtered.length}
                    data-testid="import-next"
                    onClick={() => {
                      changePage(currentPage + 1)
                    }}
                  >
                    {t('Next page')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
        {candidates && candidates.length > 0 && !result && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="import-options">
            {source !== 'rdp' && (
              <Field
                label={t('User')}
                hint={
                  userError ? (
                    <span className="text-danger">{userError}</span>
                  ) : missingUser > 0 ? (
                    <span className="text-warning" data-testid="import-user-needed">
                      {tn(
                        missingUser,
                        '{n} selected host has no user in the file.',
                        '{n} selected hosts have no user in the file.'
                      )}
                    </span>
                  ) : undefined
                }
              >
                <Input
                  mono
                  data-testid="import-option-user"
                  placeholder={t('As in the file')}
                  aria-invalid={userError !== null}
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value)
                  }}
                />
              </Field>
            )}
            {source !== 'rdp' && (
              <>
                <Field label={t('SSH key')}>
                  <div className="flex gap-1.5">
                    <Select
                      className="min-w-0 flex-1"
                      data-testid="import-option-key"
                      value={keyId}
                      onChange={(e) => {
                        setKeyId(e.target.value)
                      }}
                    >
                      <option value="">{t('As in the file')}</option>
                      {tree.keys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      data-testid="import-option-key-import"
                      title={t('Import SSH key…')}
                      onClick={() => {
                        void importKey().then(async (id) => {
                          if (!id) return
                          await useHosts.getState().reload()
                          setKeyId(id)
                        })
                      }}
                    >
                      {t('Import…')}
                    </Button>
                  </div>
                </Field>
                <Field label={t('Jump host')}>
                  <Select
                    data-testid="import-option-jump"
                    value={jumpHostId}
                    onChange={(e) => {
                      setJumpHostId(e.target.value)
                    }}
                  >
                    <option value="">{t('As in the file')}</option>
                    {tree.hosts
                      .filter((h) => h.protocol === 'ssh')
                      .map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.label}
                        </option>
                      ))}
                  </Select>
                </Field>
              </>
            )}
          </div>
        )}
        {result && (
          <Notice tone="success" testId="import-result">
            {result}
          </Notice>
        )}
      </fieldset>
    </Modal>
  )
}
