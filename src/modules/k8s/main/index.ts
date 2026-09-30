import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MainModule, MainModuleContext } from '../../registry/main-types'
import { k8sManifest } from '../manifest'
import { K8sIpc, type ContextEntry, type ContextList, type ContextSettings } from '../shared/ipc'
import { ContextRef, contextKey, type ContextInfo } from '../shared/ops'
import m0001 from '../migrations/0001_contexts.sql?raw'
import { listContexts, parseKubeconfig, resolveContext, type KubeconfigDoc } from './kubeconfig'

interface SettingsRow {
  key: string
  bastion_host_id: string | null
  namespace: string | null
  read_only: number
  color: string | null
}

const DEFAULTS: ContextSettings = {
  bastionHostId: null,
  namespace: null,
  readOnly: false,
  color: null
}

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

  private imported(): { id: string; name: string; yaml_enc: Buffer }[] {
    return this.ctx.db
      .prepare('SELECT id, name, yaml_enc FROM k8s_kubeconfigs ORDER BY added_at')
      .all() as { id: string; name: string; yaml_enc: Buffer }[]
  }

  private settings(): Map<string, ContextSettings> {
    const rows = this.ctx.db
      .prepare('SELECT key, bastion_host_id, namespace, read_only, color FROM k8s_contexts')
      .all() as SettingsRow[]
    return new Map(
      rows.map((r) => [
        r.key,
        {
          bastionHostId: r.bastion_host_id,
          namespace: r.namespace,
          readOnly: r.read_only === 1,
          color: (['red', 'orange', 'green', 'blue'] as const).find((c) => c === r.color) ?? null
        }
      ])
    )
  }

  async list(): Promise<ContextList> {
    const errors: string[] = []
    const infos: ContextInfo[] = []
    for (const file of kubeconfigFiles()) {
      try {
        const doc = await this.loadFile(file)
        if (doc) infos.push(...listContexts(doc, `file:${file}`, label(file)))
      } catch (error) {
        errors.push(`${label(file)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const imported = this.imported()
    for (const row of imported) {
      try {
        const doc = parseKubeconfig(this.open(row))
        infos.push(...listContexts(doc, `imported:${row.id}`, `Imported: ${row.name}`))
      } catch (error) {
        errors.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const settings = this.settings()
    const contexts: ContextEntry[] = infos.map((c) => {
      const key = contextKey(c.ref)
      return { ...c, key, settings: settings.get(key) ?? DEFAULTS }
    })
    return { contexts, errors, imported: imported.map((r) => ({ id: r.id, name: r.name })) }
  }

  private open(row: { id: string; yaml_enc: Buffer }): string {
    return this.ctx.secrets.open('k8s_kubeconfigs', row.id, 'yaml_enc', row.yaml_enc)
  }

  setContext(ref: ContextRef, patch: Partial<ContextSettings>): void {
    const key = contextKey(ref)
    const next = { ...(this.settings().get(key) ?? DEFAULTS), ...patch }
    this.ctx.db
      .prepare(
        `INSERT INTO k8s_contexts (key, bastion_host_id, namespace, read_only, color, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET bastion_host_id = excluded.bastion_host_id,
           namespace = excluded.namespace, read_only = excluded.read_only, color = excluded.color,
           updated_at = excluded.updated_at`
      )
      .run(key, next.bastionHostId, next.namespace, next.readOnly ? 1 : 0, next.color, Date.now())
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

  removeImported(id: string): void {
    this.ctx.db.prepare('DELETE FROM k8s_kubeconfigs WHERE id = ?').run(id)
  }

  /** Phân giải context cho Session Host (đọc file tham chiếu, giải mã bản import). */
  async resolve(ref: ContextRef): Promise<unknown> {
    if (ref.source.startsWith('file:')) {
      const path = ref.source.slice('file:'.length)
      if (!kubeconfigFiles().includes(path))
        throw new Error('This kubeconfig is no longer in KUBECONFIG / ~/.kube/config')
      const doc = await this.loadFile(path)
      if (!doc) throw new Error(`${label(path)} was not found`)
      return resolveContext(
        doc,
        ref,
        path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path,
        (p) => this.ctx.readFile(p)
      )
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
  migrations: [{ version: 1, name: 'contexts', sql: m0001 }],
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
