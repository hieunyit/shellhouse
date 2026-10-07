import { useCallback, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Username, type ImportCandidate, type ImportOptions } from '@shared/hosts'
import { t, tn } from '@shared/i18n'
import { formatNumber } from '@shared/i18n/format'
import { useHosts } from '../stores/hosts'
import { importKey } from './accounts/ImportKeyDialog'
import { Button, Field, Input, Modal, Notice, Segmented, Select } from './ui'

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
        'SSH sessions and their folders are imported. Saved passwords are never read from MobaXterm.'
      )
    case 'csv':
      return t(
        'Termius or spreadsheet export. Columns are matched by name; passwords are never imported.'
      )
    case 'ansible':
      return t(
        'An Ansible inventory (INI or YAML). Groups and children become nested groups; ansible_host, ansible_port, ansible_user and the key file are used. Passwords and vault values are never read.'
      )
    case 'yaml':
      return t(
        'A file saved with Export hosts (Shellhouse YAML). Groups are recreated; passwords are never in it.'
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

export function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [source, setSource] = useState<Source>('ssh-config')
  const [scan, setScan] = useState<Scan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Tuỳ chọn áp cho mọi host đã chọn ('' = theo file). */
  const [groupId, setGroupId] = useState('')
  const [keyId, setKeyId] = useState('')
  const [jumpHostId, setJumpHostId] = useState('')
  /** User SSH cho mọi host đã chọn ('' = theo file). */
  const [username, setUsername] = useState('')
  const tree = useHosts((s) => s.tree)
  const groupTree = useHosts((s) => s.groupTree)

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
    setError(null)
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
                : window.shellhouse.scanMobaXterm(pick)
    )
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
                  ? await window.shellhouse.importRdpFiles(aliases)
                  : await window.shellhouse.importMobaXterm(aliases, options)
      setResult(
        tn(imported, 'Imported {n} host.', 'Imported {n} hosts.') +
          (skipped.length ? ' ' + t('Skipped: {names}.', { names: skipped.join(', ') }) : '')
      )
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const candidates = scan?.candidates ?? null
  const importable = (candidates ?? []).filter((c) => !c.problem)
  const user = username.trim()
  const userError = user && !Username.safeParse(user).success ? t('Invalid username') : null
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
      <Button onClick={onClose}>{t('Cancel')}</Button>
      <Button
        variant="primary"
        disabled={
          !candidates?.length || selected.size === 0 || userError !== null || missingUser > 0
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
      {!result && (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={source}
            testIdPrefix="import-source"
            options={[
              { value: 'ssh-config', label: '~/.ssh/config' },
              { value: 'mobaxterm', label: 'MobaXterm' },
              { value: 'csv', label: 'CSV / Termius' },
              { value: 'ansible', label: 'Ansible' },
              { value: 'rdp', label: 'Remote Desktop (.rdp)' },
              { value: 'yaml', label: 'Shellhouse YAML' }
            ]}
            onChange={(next) => {
              setSource(next)
              load(next, false)
            }}
          />
          {source !== 'ssh-config' && (
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
                  load(source, true)
                }}
              >
                {source === 'rdp' ? t('Choose files…') : t('Choose file…')}
              </Button>
            </>
          )}
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
                    ? t('Choose an Ansible inventory file — the hosts file (INI) or inventory.yml.')
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
            ? t('Ignored variables with secrets: {names}. Add passwords or keys after importing.', {
                names: scan?.secretColumns?.join(', ') ?? ''
              })
            : t('Ignored columns with secrets: {columns}. Add passwords or keys after importing.', {
                columns: scan?.secretColumns?.join(', ') ?? ''
              })}
        </p>
      )}
      {candidates && candidates.length > 0 && !result && (
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-subtle text-xs text-muted">
              <tr>
                <th className="w-9 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('Select all')}
                    className="accent-[var(--sh-accent)]"
                    data-testid="import-select-all"
                    checked={
                      importable.length > 0 && importable.every((c) => selected.has(c.alias))
                    }
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
                    {!c.problem && keyId && (c.warning || c.keyFile) && (
                      <span className="block text-muted" data-testid="import-key-note">
                        {t('Uses key {name}', {
                          name: tree.keys.find((k) => k.id === keyId)?.name ?? ''
                        })}
                      </span>
                    )}
                    {!c.problem && !keyId && c.warning && (
                      <span className="block text-warning" data-testid="import-warning">
                        {c.warning} — {t('choose a key below or add one later')}
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
                      <span className="text-faint">{t('via {host}', { host: c.proxyJump })}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {candidates && candidates.length > 0 && !result && source !== 'rdp' && (
        <div className="grid grid-cols-2 gap-3" data-testid="import-options">
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
          <Field label={t('Into group')}>
            <Select
              data-testid="import-option-group"
              value={groupId}
              onChange={(e) => {
                setGroupId(e.target.value)
              }}
            >
              <option value="">{t('As in the file')}</option>
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
