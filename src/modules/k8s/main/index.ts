import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MainModule, MainModuleContext } from '../../registry/main-types'
import { k8sManifest } from '../manifest'
import {
  K8sIpc,
  type ContextEntry,
  type ContextList,
  type ContextSettings,
  type ImportResult
} from '../shared/ipc'
import { ContextRef, contextKey, type ContextInfo } from '../shared/ops'
import m0001 from '../migrations/0001_contexts.sql?raw'
import m0002 from '../migrations/0002_hidden.sql?raw'
import {
  deleteContextFromYaml,
  embedReferences,
  listContexts,
  parseKubeconfig,
  resolveContext,
  type KubeconfigDoc
} from './kubeconfig'

interface SettingsRow {
  key: string
  bastion_host_id: string | null
  namespace: string | null
  read_only: number
  color: string | null
  hidden: number
}

const DEFAULTS: ContextSettings = {
  bastionHostId: null,
  namespace: null,
  readOnly: false,
  color: null,
  hidden: false
}

/** File trong ~/.kube không phải kubeconfig (khoá, cache…). */
const SKIP = /\.(lock|bak|swp|tmp|log|json|pem|crt|key)$|^\./i

/** File kubeconfig như kubectl: KUBECONFIG (nhiều file) hoặc ~/.kube/config. */
export function kubeconfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env['KUBECONFIG'] ?? '')
    .split(process.platform === 'win32' ? ';' : delimiter)
    .filter(Boolean)
  return list.length ? list : ['~/.kube/config']
}

function label(path: string): string {
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function expand(path: string): string {
  return path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
}

class Kubeconfigs {
  constructor(private readonly ctx: MainModuleContext) {}

  private async loadFile(path: string): Promise<KubeconfigDoc | null> {
    try {
      return parseKubeconfig(await this.ctx.readFile(path))
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Mọi file kubeconfig đọc tự động (như Lens): KUBECONFIG / ~/.kube/config, cộng các file khác
   * trong ~/.kube (kubeconfig của từng cluster mà nhiều công cụ ghi vào đó).
   */
  async files(): Promise<string[]> {
    const primary = kubeconfigFiles().map(expand)
    const extra = await this.ctx
      .readDir('~/.kube')
      .then((list) =>
        list
          .filter((f) => f.size > 0 && f.size <= 1024 * 1024 && !SKIP.test(f.name))
          .map((f) => f.path)
      )
      .catch(() => [] as string[])
    return [...new Set([...primary, ...extra])]
  }

  private imported(): { id: string; name: string; yaml_enc: Buffer }[] {
    return this.ctx.db
      .prepare('SELECT id, name, yaml_enc FROM k8s_kubeconfigs ORDER BY added_at')
      .all() as { id: string; name: string; yaml_enc: Buffer }[]
  }

  private settings(): Map<string, ContextSettings> {
    const rows = this.ctx.db
      .prepare('SELECT key, bastion_host_id, namespace, read_only, color, hidden FROM k8s_contexts')
      .all() as SettingsRow[]
    return new Map(
      rows.map((r) => [
        r.key,
        {
          bastionHostId: r.bastion_host_id,
          namespace: r.namespace,
          readOnly: r.read_only === 1,
          color: (['red', 'orange', 'green', 'blue'] as const).find((c) => c === r.color) ?? null,
          hidden: r.hidden === 1
        }
      ])
    )
  }

  async list(): Promise<ContextList> {
    const errors: string[] = []
    const infos: ContextInfo[] = []
    const files: ContextList['files'] = []
    const explicit = new Set(kubeconfigFiles().map(expand))
    for (const file of await this.files()) {
      try {
        const doc = await this.loadFile(file)
        if (!doc) continue
        // File phụ trong ~/.kube không có context → không phải kubeconfig, bỏ qua im lặng.
        if (doc.contexts.length === 0 && !explicit.has(file)) continue
        const contexts = listContexts(doc, `file:${file}`, label(file))
        files.push({ path: file, label: label(file), contexts: contexts.length })
        infos.push(...contexts)
      } catch (error) {
        if (explicit.has(file))
          errors.push(`${label(file)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const imported = this.imported()
    const importedInfo: ContextList['imported'] = []
    for (const row of imported) {
      try {
        const doc = parseKubeconfig(this.open(row))
        const contexts = listContexts(doc, `imported:${row.id}`, `Imported: ${row.name}`)
        importedInfo.push({ id: row.id, name: row.name, contexts: contexts.length })
        infos.push(...contexts)
      } catch (error) {
        importedInfo.push({ id: row.id, name: row.name, contexts: 0 })
        errors.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const settings = this.settings()
    const contexts: ContextEntry[] = infos.map((c) => {
      const key = contextKey(c.ref)
      return { ...c, key, settings: settings.get(key) ?? DEFAULTS }
    })
    return { contexts, errors, imported: importedInfo, files }
  }

  private open(row: { id: string; yaml_enc: Buffer }): string {
    return this.ctx.secrets.open('k8s_kubeconfigs', row.id, 'yaml_enc', row.yaml_enc)
  }

  setContext(ref: ContextRef, patch: Partial<ContextSettings>): void {
    const key = contextKey(ref)
    const next = { ...(this.settings().get(key) ?? DEFAULTS), ...patch }
    this.ctx.db
      .prepare(
        `INSERT INTO k8s_contexts (key, bastion_host_id, namespace, read_only, color, hidden, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET bastion_host_id = excluded.bastion_host_id,
           namespace = excluded.namespace, read_only = excluded.read_only, color = excluded.color,
           hidden = excluded.hidden, updated_at = excluded.updated_at`
      )
      .run(
        key,
        next.bastionHostId,
        next.namespace,
        next.readOnly ? 1 : 0,
        next.color,
        next.hidden ? 1 : 0,
        Date.now()
      )
  }

  importYaml(name: string, yaml: string): string {
    const doc = parseKubeconfig(yaml)
    if (doc.contexts.length === 0) throw new Error('This kubeconfig has no contexts')
    const id = randomUUID()
    const sealed = this.ctx.secrets.seal('k8s_kubeconfigs', id, 'yaml_enc', yaml)
    this.ctx.db
      .prepare('INSERT INTO k8s_kubeconfigs (id, name, yaml_enc, added_at) VALUES (?, ?, ?, ?)')
      .run(id, name, sealed, Date.now())
    return id
  }

  /** Chọn file kubeconfig, nhúng chứng chỉ tham chiếu, lưu vào vault. */
  async importFiles(): Promise<ImportResult> {
    const picked = await this.ctx.pickFiles({
      title: 'Import kubeconfig files',
      multiple: true
    })
    const result: ImportResult = { imported: [], errors: [] }
    for (const file of picked) {
      try {
        const doc = parseKubeconfig(file.content)
        if (doc.contexts.length === 0) throw new Error('no contexts — is this a kubeconfig?')
        const embedded = await embedReferences(file.content, (p) => file.readReferenced(p))
        const name = file.name.replace(/\.(ya?ml|conf|config)$/i, '') || file.name
        this.importYaml(name, embedded)
        result.imported.push({ name, contexts: doc.contexts.length })
      } catch (error) {
        result.errors.push(
          `${file.name}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    return result
  }

  renameImported(id: string, name: string): void {
    this.ctx.db.prepare('UPDATE k8s_kubeconfigs SET name = ? WHERE id = ?').run(name, id)
  }

  removeImported(id: string): void {
    this.ctx.db.prepare('DELETE FROM k8s_kubeconfigs WHERE id = ?').run(id)
  }

  /**
   * Xoá một context: bản import → sửa bản trong vault (hết context thì xoá cả bản import); file
   * trong ~/.kube / KUBECONFIG → sửa file như `kubectl config delete-context`, giữ bản sao
   * `<file>.bak` (nội dung trước khi xoá). Cài đặt riêng của context cũng bị xoá.
   */
  async deleteContext(ref: ContextRef): Promise<{ backup: string | null }> {
    let backup: string | null = null
    if (ref.source.startsWith('imported:')) {
      const id = ref.source.slice('imported:'.length)
      const row = this.imported().find((r) => r.id === id)
      if (!row) throw new Error('This imported kubeconfig was removed')
      const { text, left } = deleteContextFromYaml(this.open(row), ref.context)
      if (left === 0) this.removeImported(id)
      else
        this.ctx.db
          .prepare('UPDATE k8s_kubeconfigs SET yaml_enc = ? WHERE id = ?')
          .run(this.ctx.secrets.seal('k8s_kubeconfigs', id, 'yaml_enc', text), id)
    } else if (ref.source.startsWith('file:')) {
      const path = expand(ref.source.slice('file:'.length))
      if (!(await this.files()).includes(path))
        throw new Error('This kubeconfig is no longer in KUBECONFIG or ~/.kube')
      const original = await this.ctx.readFile(path)
      const { text } = deleteContextFromYaml(original, ref.context)
      // Bản sao cạnh file (trong ~/.kube); file ở chỗ khác (KUBECONFIG) chỉ được ghi chính nó.
      backup = await this.ctx.writeFile(`${path}.bak`, original).then(
        () => `${path}.bak`,
        () => null
      )
      await this.ctx.writeFile(path, text)
    } else throw new Error('Unknown kubeconfig source')
    this.ctx.db.prepare('DELETE FROM k8s_contexts WHERE key = ?').run(contextKey(ref))
    return { backup }
  }

  /** Phân giải context cho Session Host (đọc file tham chiếu, giải mã bản import). */
  async resolve(ref: ContextRef): Promise<unknown> {
    if (ref.source.startsWith('file:')) {
      const path = expand(ref.source.slice('file:'.length))
      if (!(await this.files()).includes(path))
        throw new Error('This kubeconfig is no longer in KUBECONFIG or ~/.kube')
      const doc = await this.loadFile(path)
      if (!doc) throw new Error(`${label(path)} was not found`)
      return resolveContext(doc, ref, path, (p) => this.ctx.readFile(p))
    }
    if (ref.source.startsWith('imported:')) {
      const id = ref.source.slice('imported:'.length)
      const row = this.imported().find((r) => r.id === id)
      if (!row) throw new Error('This imported kubeconfig was removed')
      return resolveContext(parseKubeconfig(this.open(row)), ref, null, () =>
        Promise.reject(new Error('Imported kubeconfigs cannot reference files'))
      )
    }
    throw new Error('Unknown kubeconfig source')
  }
}

/** Phần main của Kubernetes. */
export const k8sMain: MainModule = {
  manifest: k8sManifest,
  migrations: [
    { version: 1, name: 'contexts', sql: m0001 },
    { version: 2, name: 'hidden', sql: m0002 }
  ],
  activate(ctx) {
    const configs = new Kubeconfigs(ctx)
    const changed = (): void => {
      ctx.events.emit('changed', null)
    }
    ctx.ipc.handle('contexts', K8sIpc.contexts, () => configs.list())
    ctx.ipc.handle('setContext', K8sIpc.setContext, (ref, patch) => {
      configs.setContext(ref, patch)
      changed()
    })
    ctx.ipc.handle('importKubeconfig', K8sIpc.importKubeconfig, (name, yaml) => {
      try {
        const id = configs.importYaml(name, yaml)
        changed()
        return { ok: true, id }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
    ctx.ipc.handle('importFiles', K8sIpc.importFiles, async () => {
      const r = await configs.importFiles()
      if (r.imported.length) changed()
      return r
    })
    ctx.ipc.handle('renameImported', K8sIpc.renameImported, (id, name) => {
      configs.renameImported(id, name)
      changed()
    })
    ctx.ipc.handle('deleteContext', K8sIpc.deleteContext, async (ref) => {
      try {
        const r = await configs.deleteContext(ref)
        return { ok: true, backup: r.backup }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      } finally {
        changed()
      }
    })
    ctx.ipc.handle('removeImported', K8sIpc.removeImported, (id) => {
      configs.removeImported(id)
      changed()
    })
    return {
      resolveSession: () => ({}),
      // Session Host xin thông tin kết nối của một context (có secret) — không qua renderer.
      onHostRequest: (name, params) => {
        if (name !== 'resolve') throw new Error(`Unknown request ${name}`)
        return configs.resolve(ContextRef.parse(params))
      }
    }
  }
}
