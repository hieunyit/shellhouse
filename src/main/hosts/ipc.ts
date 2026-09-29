import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import type { ImportCandidate, MutationResult } from '@shared/hosts'
import { handle } from '../ipc/router'
import { decodeMobaIni, scanMobaXterm } from './mobaxterm-import'
import type { HostService } from './service'
import { scanSshConfig } from './ssh-config-import'

/** MobaXterm.ini thật chỉ vài trăm KB; giới hạn để không đọc nhầm file khổng lồ. */
const MAX_MOBA_INI_BYTES = 16 * 1024 * 1024

const MAX_KEY_FILE_BYTES = 64 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mutation(fn: () => string): MutationResult {
  try {
    return { ok: true, id: fn() }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

function readSshConfig(): string {
  try {
    return readFileSync(join(app.getPath('home'), '.ssh', 'config'), 'utf8')
  } catch {
    return ''
  }
}

/** Vị trí mặc định của bản cài đặt; bản portable để file cạnh exe → người dùng tự chọn. */
function defaultMobaIni(): string | null {
  const appData = process.env['APPDATA']
  if (!appData) return null
  const file = join(appData, 'MobaXterm', 'MobaXterm.ini')
  return existsSync(file) ? file : null
}

function readMobaIni(file: string): string {
  if (statSync(file).size > MAX_MOBA_INI_BYTES) throw new Error('The file is too large')
  return decodeMobaIni(readFileSync(file))
}

/** Nhóm theo đường dẫn tên (tạo nếu chưa có, so tên không phân biệt hoa thường như service). */
function ensureGroupPath(service: HostService, path: readonly string[]): string | null {
  let parentId: string | null = null
  for (const name of path) {
    const found = service
      .tree()
      .groups.find(
        (g) =>
          g.parentId === parentId &&
          g.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
      )
    parentId = found ? found.id : service.saveGroup({ parentId, name })
  }
  return parentId
}

function importCandidates(
  service: HostService,
  candidates: readonly ImportCandidate[],
  aliases: readonly string[],
  tag: string
): { imported: number; skipped: string[] } {
  const wanted = new Set(aliases)
  let imported = 0
  const skipped: string[] = []
  for (const c of candidates) {
    if (!wanted.has(c.alias)) continue
    if (c.problem || !c.username) {
      skipped.push(c.alias)
      continue
    }
    try {
      service.saveHost({
        groupId: ensureGroupPath(service, c.group ?? []),
        label: c.label ?? c.alias,
        hostname: c.hostname,
        port: c.port,
        username: c.username,
        auth: 'auto',
        keyId: null,
        keyFile: c.keyFile,
        proxyJump: c.proxyJump,
        jumpHostIds: [],
        mode: 'builtin',
        tags: [tag],
        color: null
      })
      imported++
    } catch (error) {
      log.warn(`Skipping ${c.alias}: ${errorMessage(error)}`)
      skipped.push(c.alias)
    }
  }
  return { imported, skipped }
}

function currentUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'root'
}

export function registerHostIpc(
  service: HostService,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  getWindow: () => BrowserWindow | null,
  notifyChanged: () => void
): void {
  const changing = <T>(fn: () => T): T => {
    const result = fn()
    notifyChanged()
    return result
  }

  handle('hosts:tree', isTrustedSender, () => service.tree())
  handle('hosts:save', isTrustedSender, (input) =>
    changing(() => mutation(() => service.saveHost(input)))
  )
  handle('hosts:delete', isTrustedSender, (id) => {
    changing(() => {
      service.deleteHost(id)
    })
  })
  handle('hosts:move', isTrustedSender, (id, groupId) => {
    changing(() => {
      service.moveHost(id, groupId)
    })
  })
  handle('groups:save', isTrustedSender, (input) =>
    changing(() => mutation(() => service.saveGroup(input)))
  )
  handle('groups:delete', isTrustedSender, (id) => {
    changing(() => {
      service.deleteGroup(id)
    })
  })
  const done = (fn: () => void): MutationResult =>
    mutation(() => {
      fn()
      return ''
    })
  handle('hosts:moveMany', isTrustedSender, (ids, groupId) =>
    changing(() =>
      done(() => {
        service.moveHosts(ids, groupId)
      })
    )
  )
  handle('hosts:deleteMany', isTrustedSender, (ids) => {
    changing(() => {
      service.deleteHosts(ids)
    })
  })
  handle('hosts:setFavorite', isTrustedSender, (ids, favorite) => {
    changing(() => {
      service.setFavorite(ids, favorite)
    })
  })
  handle('hosts:tag', isTrustedSender, (ids, add, remove) =>
    changing(() =>
      done(() => {
        service.tagHosts(ids, add, remove)
      })
    )
  )
  handle('hosts:reorder', isTrustedSender, (groupId, ids) =>
    changing(() =>
      done(() => {
        service.reorderHosts(groupId, ids)
      })
    )
  )
  handle('hosts:duplicate', isTrustedSender, (id) =>
    changing(() => mutation(() => service.duplicateHost(id)))
  )
  handle('groups:reorder', isTrustedSender, (parentId, ids) =>
    changing(() =>
      done(() => {
        service.reorderGroups(parentId, ids)
      })
    )
  )
  handle('groups:move', isTrustedSender, (id, parentId) =>
    changing(() =>
      mutation(() => {
        service.moveGroup(id, parentId)
        return id
      })
    )
  )

  handle('forwards:list', isTrustedSender, (hostId) => service.listForwards(hostId))
  handle('forwards:save', isTrustedSender, (input) => mutation(() => service.saveForward(input)))
  handle('forwards:delete', isTrustedSender, (id) => {
    service.deleteForward(id)
  })

  handle('keys:importFromFile', isTrustedSender, async () => {
    const window = getWindow()
    const options = {
      title: 'Choose a private key',
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'] as ('openFile' | 'showHiddenFiles')[]
    }
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    return changing(() =>
      mutation(() => {
        if (statSync(file).size > MAX_KEY_FILE_BYTES)
          throw new Error('The file is too large to be a private key')
        const key = service.importKey(basename(file), readFileSync(file, 'utf8'))
        log.info(`Imported key ${key.name} (${key.fingerprint})`)
        return key.id
      })
    )
  })
  handle('keys:generate', isTrustedSender, (options) =>
    changing(() =>
      mutation(
        () =>
          service.generateKey({
            name: options.name,
            type: options.type,
            ...(options.bits ? { bits: options.bits } : {}),
            ...(options.passphrase ? { passphrase: options.passphrase } : {}),
            comment: `${options.name.replace(/\s+/g, '-')}@shellhouse`
          }).id
      )
    )
  )
  handle('keys:publicKey', isTrustedSender, (id) => service.publicKeyLine(id))
  handle('keys:exportPrivate', isTrustedSender, async (id) => {
    const window = getWindow()
    const options = {
      title: 'Save private key',
      defaultPath: join(app.getPath('home'), '.ssh', 'id_shellhouse'),
      showsTagField: false
    }
    const picked = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    const pem = service.privateKeyPem(id)
    try {
      // 0600: OpenSSH từ chối key có quyền rộng hơn.
      writeFileSync(picked.filePath, pem.reveal(), { mode: 0o600 })
      writeFileSync(`${picked.filePath}.pub`, `${service.publicKeyLine(id)}\n`, { mode: 0o644 })
      return { ok: true, path: picked.filePath }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    } finally {
      pem.dispose()
    }
  })
  handle('keys:delete', isTrustedSender, (id) =>
    changing(() =>
      mutation(() => {
        service.deleteKey(id)
        return id
      })
    )
  )

  handle('sshConfig:scan', isTrustedSender, () =>
    scanSshConfig(readSshConfig(), {
      home: app.getPath('home'),
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
  )
  handle('sshConfig:import', isTrustedSender, (aliases) => {
    const candidates = scanSshConfig(readSshConfig(), {
      home: app.getPath('home'),
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
    const result = importCandidates(service, candidates, aliases, 'ssh-config')
    notifyChanged()
    return result
  })

  // File MobaXterm vừa quét — lần nhập đọc lại chính file này (renderer không chọn đường dẫn).
  let mobaFile: string | null = null
  const scanMoba = (file: string) =>
    scanMobaXterm(readMobaIni(file), {
      home: app.getPath('home'),
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
  handle('mobaxterm:scan', isTrustedSender, async (pick) => {
    let file = pick ? null : defaultMobaIni()
    if (pick) {
      const window = getWindow()
      const options = {
        title: 'Choose MobaXterm.ini',
        ...(process.env['APPDATA']
          ? { defaultPath: join(process.env['APPDATA'], 'MobaXterm') }
          : {}),
        filters: [
          { name: 'MobaXterm configuration', extensions: ['ini', 'mxtsessions'] },
          { name: 'All files', extensions: ['*'] }
        ],
        properties: ['openFile'] as 'openFile'[]
      }
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      file = picked.canceled ? null : (picked.filePaths[0] ?? null)
    }
    mobaFile = file
    if (!file) return { file: null, candidates: [], ignored: {} }
    return { file, ...scanMoba(file) }
  })
  handle('mobaxterm:import', isTrustedSender, (aliases) => {
    if (!mobaFile) throw new Error('Choose a MobaXterm file first')
    const result = importCandidates(service, scanMoba(mobaFile).candidates, aliases, 'mobaxterm')
    notifyChanged()
    return result
  })
}
