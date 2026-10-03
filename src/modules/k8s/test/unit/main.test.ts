import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { tempDir } from '../../../../../test/unit/helpers'
import { Secret } from '../../../../node-shared/secret'
import { openDatabase } from '../../../../main/store/db'
import { migrate } from '../../../../main/store/migrate'
import { MIGRATIONS } from '../../../../main/store/migrations'
import { SettingsService } from '../../../../main/settings'
import { TEST_KDF } from '../../../../main/vault/crypto'
import { Vault } from '../../../../main/vault/vault'
import { MainModuleRegistry } from '../../../registry/main'
import { k8sMain } from '../../main'

/** Phần main của Kubernetes: resolve (kèm chỉ đọc), file sửa, lưu token OIDC, xoá context. */

const kubeconfig = (contexts: string[]): string => `apiVersion: v1
clusters:
  - name: c
    cluster: { server: https://k8s.example:6443 }
contexts:
${contexts.map((n) => `  - name: ${n}\n    context: { cluster: c, user: alice }`).join('\n')}
users:
  - name: alice
    user:
      auth-provider:
        name: oidc
        config:
          id-token: old
          refresh-token: rt-1
          idp-issuer-url: https://idp.example
          client-id: kube
`

async function setup(owns: (path: string) => boolean = () => false) {
  const home = tempDir()
  mkdirSync(join(home, '.kube'))
  const file = join(home, '.kube', 'config')
  writeFileSync(file, kubeconfig(['dev', 'old']))
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  const vault = new Vault(db, TEST_KDF)
  await vault.create(Secret.fromString('master-password'))
  const settings = new SettingsService(db)
  const registry = new MainModuleRegistry([k8sMain], {
    db,
    vault,
    settings,
    emit: () => undefined,
    onStatesChanged: () => undefined,
    log: () => undefined,
    home,
    env: {},
    ownsEditFile: owns
  })
  registry.start()
  registry.setEnabled('k8s', true)
  const ref = { source: `file:${file}`, context: 'dev' }
  return { registry, file, ref }
}

describe('k8s main', () => {
  it('resolve trả chế độ chỉ đọc lưu trong main (Session Host chặn theo đó)', async () => {
    const { registry, ref } = await setup()
    expect(await registry.hostRequest('k8s', 'resolve', ref)).toMatchObject({
      server: 'https://k8s.example:6443',
      readOnly: false
    })
    await registry.invoke('k8s', 'setContext', [ref, { readOnly: true }])
    expect(await registry.hostRequest('k8s', 'resolve', ref)).toMatchObject({ readOnly: true })
  })

  it('editFile: chỉ đường dẫn main cấp (files:prepareEdit)', async () => {
    const { registry } = await setup((p) => p.startsWith('/tmp/edits/'))
    expect(await registry.hostRequest('k8s', 'editFile', '/tmp/edits/x/web.yaml')).toBe(true)
    expect(await registry.hostRequest('k8s', 'editFile', '/home/me/.bashrc')).toBe(false)
  })

  it('persistOidc: ghi id-token / refresh-token mới vào kubeconfig của context', async () => {
    const { registry, file, ref } = await setup()
    await registry.hostRequest('k8s', 'persistOidc', {
      ref,
      idToken: 'new-id',
      refreshToken: 'rt-2'
    })
    const doc = parse(readFileSync(file, 'utf8')) as {
      users: { user: { 'auth-provider': { config: Record<string, string> } } }[]
    }
    expect(doc.users[0]?.user['auth-provider'].config).toMatchObject({
      'id-token': 'new-id',
      'refresh-token': 'rt-2',
      'client-id': 'kube'
    })
  })

  it('xoá context: bản sao .bak, lần sau không đè bản sao cũ', async () => {
    const { registry, file, ref } = await setup()
    writeFileSync(file, kubeconfig(['dev', 'old', 'older']))
    const first = (await registry.invoke('k8s', 'deleteContext', [{ ...ref, context: 'old' }])) as {
      ok: boolean
      backup: string
    }
    expect(first).toEqual({ ok: true, backup: `${file}.bak` })
    const second = (await registry.invoke('k8s', 'deleteContext', [
      { ...ref, context: 'older' }
    ])) as { ok: boolean; backup: string }
    expect(second.backup).toMatch(/config\.\d{8}-\d{6}\.bak$/)
    expect(readFileSync(`${file}.bak`, 'utf8')).toContain('name: old')
    expect(readFileSync(second.backup, 'utf8')).toContain('name: older')
    expect(readFileSync(file, 'utf8')).not.toContain('name: old')
    expect(existsSync(second.backup)).toBe(true)
  })
})
