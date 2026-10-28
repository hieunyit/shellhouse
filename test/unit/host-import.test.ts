import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportCandidate } from '@shared/hosts'
import type { InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc'
import { Secret } from '../../src/node-shared/secret'
import { openDatabase, type Db } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'
import { TEST_KDF } from '../../src/main/vault/crypto'
import { Vault } from '../../src/main/vault/vault'
import { HostService } from '../../src/main/hosts/service'
import { importCandidates } from '../../src/main/hosts/import'
import { registerHostIpc } from '../../src/main/hosts/ipc'
import { tempDir } from './helpers'

const mocks = vi.hoisted(() => ({
  home: '',
  pick: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.home } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../src/main/dialogs', () => ({ showOpenDialog: mocks.pick, showSaveDialog: vi.fn() }))
vi.mock('../../src/main/ipc/router', () => ({
  handle: (channel: string, _trusted: unknown, fn: (...args: unknown[]) => unknown) => {
    mocks.handlers.set(channel, fn)
  }
}))

const databases: Db[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
beforeEach(() => {
  mocks.handlers.clear()
  mocks.pick.mockReset()
})

async function setup() {
  mocks.home = tempDir()
  const db = openDatabase(':memory:')
  databases.push(db)
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  let clock = 1000
  const service = new HostService(db, vault, () => ++clock)
  registerHostIpc(
    service,
    () => true,
    () => null,
    () => undefined
  )
  return service
}
function call<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`Missing ${channel}`)
  return Promise.resolve(fn(...args) as InvokeResult<C>)
}
function candidate(patch: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    alias: 'Prod\\DB\\web',
    label: 'web',
    hostname: 'web.example.com',
    port: 22,
    username: 'deploy',
    group: ['Prod', 'DB'],
    keyFile: null,
    proxyJump: null,
    duplicate: false,
    problem: null,
    ...patch
  }
}

describe('host import destination and validation', () => {
  it('imports directly into an existing nested group and never recreates source groups', async () => {
    const service = await setup()
    const root = service.saveGroup({ parentId: null, name: 'Existing' })
    const target = service.saveGroup({ parentId: root, name: 'Target' })
    expect(
      importCandidates(service, [candidate()], ['Prod\\DB\\web'], 'csv', { groupId: target })
    ).toEqual({ imported: 1, skipped: [] })
    expect(service.groups()).toHaveLength(2)
    expect(service.tree().hosts[0]?.groupId).toBe(target)
  })
  it('defaults to no group and reports unknown aliases without creating folders for invalid hosts', async () => {
    const service = await setup()
    const bad = candidate({ alias: 'bad', hostname: '-oProxyCommand=x' })
    expect(
      importCandidates(service, [candidate(), bad], ['Prod\\DB\\web', 'bad', 'absent'], 'csv', {
        groupId: ''
      })
    ).toEqual({ imported: 1, skipped: ['absent', 'bad'] })
    expect(service.groups()).toEqual([])
    expect(service.tree().hosts[0]?.groupId).toBeNull()
    expect(() =>
      importCandidates(service, [candidate()], ['Prod\\DB\\web'], 'csv', { groupId: 'deleted' })
    ).toThrow('group no longer exists')
    expect(service.tree().hosts).toHaveLength(1)
  })
  it('deduplicates selected aliases, validates hosts and bounds imported tags', async () => {
    const service = await setup()
    const c = candidate({
      username: null,
      tags: ['', ' csv ', ...Array.from({ length: 30 }, (_, i) => `tag${i}`), 'x'.repeat(41)]
    })
    const result = importCandidates(service, [c], [c.alias, c.alias], 'csv', { username: 'root' })
    expect(result.imported).toBe(1)
    expect(service.tree().hosts[0]).toMatchObject({
      username: 'root',
      tags: ['csv', ...Array.from({ length: 19 }, (_, i) => `tag${i}`)]
    })
  })
})

describe('preview snapshots for host imports', () => {
  it.each(['csv', 'yaml', 'ansible', 'mobaxterm', 'sshConfig'] as const)(
    '%s imports the previewed values even if the source changes or is deleted',
    async (source) => {
      const service = await setup()
      const contents = {
        csv: 'Group,Label,Hostname,Username\nProd/DB,web,original.example.com,deploy',
        yaml: 'shellhouse: 1\ngroups:\n  - name: Prod\n    groups:\n      - name: DB\n        hosts:\n          - { label: web, hostname: original.example.com, username: deploy }',
        ansible:
          '[Prod:children]\nDB\n[DB]\nweb ansible_host=original.example.com ansible_user=deploy',
        mobaxterm: '[Bookmarks]\nSubRep=Prod\\DB\nweb=#109#0%original.example.com%22%deploy',
        sshConfig: 'Host web\n HostName original.example.com\n User deploy'
      }
      const file =
        source === 'sshConfig' ? join(mocks.home, '.ssh', 'config') : join(mocks.home, 'source.txt')
      mkdirSync(join(mocks.home, '.ssh'), { recursive: true })
      writeFileSync(file, contents[source])
      mocks.pick.mockResolvedValue({ canceled: false, filePaths: [file] })
      const scan =
        source === 'sshConfig'
          ? { candidates: await call('sshConfig:scan') }
          : source === 'mobaxterm'
            ? await call('mobaxterm:scan', true)
            : await call(`${source}:scan`)
      writeFileSync(file, 'INVALID CHANGED CONTENT')
      const aliases = scan.candidates.map((c) => c.alias)
      const result = await call(`${source}:import`, aliases, {})
      expect(result).toEqual({ imported: 1, skipped: [] })
      expect(service.tree().hosts[0]).toMatchObject({
        hostname: 'original.example.com',
        username: 'deploy',
        groupId: null
      })
      expect(service.groups()).toEqual([])
      expect(() => call(`${source}:import`, aliases, {})).toThrow()
    }
  )
  it('invalidates an old preview when the next file scan fails', async () => {
    const service = await setup()
    const file = join(mocks.home, 'source.csv')
    writeFileSync(file, 'Hostname,Username\noriginal.example.com,deploy')
    mocks.pick.mockResolvedValue({ canceled: false, filePaths: [file] })
    await call('csv:scan')
    writeFileSync(file, 'No host column')
    await expect(call('csv:scan')).rejects.toThrow('No host column')
    expect(() => call('csv:import', ['original.example.com'], {})).toThrow(
      'Choose a CSV file first'
    )
    expect(service.tree().hosts).toEqual([])
  })
  it('ignores a file picker finishing after a newer scan has completed', async () => {
    const service = await setup()
    const file = join(mocks.home, 'latest.csv')
    writeFileSync(file, 'Hostname,Username\nlatest.example.com,deploy')
    let finishOld: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined
    mocks.pick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const old = call('csv:scan')
    mocks.pick.mockResolvedValue({ canceled: false, filePaths: [file] })
    const latest = await call('csv:scan')
    finishOld?.({ canceled: true, filePaths: [] })
    await old
    await call(
      'csv:import',
      latest.candidates.map((c) => c.alias),
      {}
    )
    expect(service.tree().hosts[0]?.hostname).toBe('latest.example.com')
  })
})
