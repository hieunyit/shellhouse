import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { t } from '@shared/i18n'
import type { ImportCandidate, MutationResult } from '@shared/hosts'
import { showOpenDialog, showSaveDialog } from '../dialogs'
import { writePrivateFile } from '../private-file'
import { handle } from '../ipc/router'
import { scanCsv } from './csv-import'
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
  if (statSync(file).size > MAX_MOBA_INI_BYTES) throw new Error(t('The file is too large'))
  return decodeMobaIni(readFileSync(file))
}

/**
 * Nhóm theo đường dẫn tên (tạo nếu chưa có, so tên không phân biệt hoa thường như service). Đọc
 * danh sách nhóm MỘT lần cho cả lượt nhập (trước đây mỗi cấp của mỗi host đọc lại cả cây → O(n²)).
 */
function groupPathResolver(service: HostService): (path: readonly string[]) => string | null {
  const children = new Map<string | null, { id: string; name: string }[]>()
  for (const g of service.groups()) {
    const list = children.get(g.parentId) ?? []
    list.push({ id: g.id, name: g.name })
    children.set(g.parentId, list)
  }
  return (path) => {
    let parentId: string | null = null
    for (const name of path) {
      const siblings: { id: string; name: string }[] = children.get(parentId) ?? []
      const found = siblings.find(
        (g) => g.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0
      )
      if (found) {
        parentId = found.id
        continue
      }
      const id = service.saveGroup({ parentId, name })
      siblings.push({ id, name: name.trim() })
      children.set(parentId, siblings)
      parentId = id
    }
    return parentId
  }
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
  // Một transaction cho cả lượt (mỗi host là một savepoint lồng bên trong: host lỗi chỉ bỏ host đó).
  return service.batch(() => {
    const ensureGroupPath = groupPathResolver(service)
    for (const c of candidates) {
      if (!wanted.has(c.alias)) continue
      if (c.problem || !c.username) {
        skipped.push(c.alias)
        continue
      }
      try {
        service.saveHost({
          groupId: ensureGroupPath(c.group ?? []),
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
          tags: [...new Set([tag, ...(c.tags ?? [])])],
          color: null
        })
        imported++
      } catch (error) {
        log.warn(`Skipping ${c.alias}: ${errorMessage(error)}`)
        skipped.push(c.alias)
      }
    }
    return { imported, skipped }
  })
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
  handle('hosts:setPassword', isTrustedSender, (id, password) =>
    changing(() =>
      mutation(() => {
        service.setHostPassword(id, password)
        return id
      })
    )
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
      title: t('Choose a private key'),
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'] as ('openFile' | 'showHiddenFiles')[]
    }
    const picked = await showOpenDialog(window, options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    return changing(() =>
      mutation(() => {
        if (statSync(file).size > MAX_KEY_FILE_BYTES)
          throw new Error(t('The file is too large to be a private key'))
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
      title: t('Save private key'),
      defaultPath: join(app.getPath('home'), '.ssh', 'id_shellhouse'),
      showsTagField: false
    }
    const picked = await showSaveDialog(window, options)
    if (picked.canceled || !picked.filePath) return null
    const pem = service.privateKeyPem(id)
    try {
      // 0600: OpenSSH từ chối key có quyền rộng hơn. `mode` chỉ áp khi TẠO file — ghi đè file có
      // sẵn (0644…) sẽ giữ quyền cũ → ghi ra file tạm mới tạo rồi đổi tên đè lên.
      writePrivateFile(picked.filePath, pem.reveal())
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
        title: t('Choose MobaXterm.ini'),
        ...(process.env['APPDATA']
          ? { defaultPath: join(process.env['APPDATA'], 'MobaXterm') }
          : {}),
        filters: [
          { name: t('MobaXterm configuration'), extensions: ['ini', 'mxtsessions'] },
          { name: t('All files'), extensions: ['*'] }
        ],
        properties: ['openFile'] as 'openFile'[]
      }
      const picked = await showOpenDialog(window, options)
      file = picked.canceled ? null : (picked.filePaths[0] ?? null)
    }
    mobaFile = file
    if (!file) return { file: null, candidates: [], ignored: {} }
    return { file, ...scanMoba(file) }
  })
  handle('mobaxterm:import', isTrustedSender, (aliases) => {
    if (!mobaFile) throw new Error(t('Choose a MobaXterm file first'))
    const result = importCandidates(service, scanMoba(mobaFile).candidates, aliases, 'mobaxterm')
    notifyChanged()
    return result
  })

  // CSV (Termius…): giống MobaXterm — main giữ đường dẫn file đã chọn.
  let csvFile: string | null = null
  const scanCsvFile = (file: string) => {
    if (statSync(file).size > MAX_MOBA_INI_BYTES) throw new Error(t('The file is too large'))
    return scanCsv(decodeMobaIni(readFileSync(file)), {
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
  }
  handle('csv:scan', isTrustedSender, async () => {
    const window = getWindow()
    const options = {
      title: t('Choose a CSV file with hosts'),
      filters: [
        { name: 'CSV', extensions: ['csv', 'txt'] },
        { name: t('All files'), extensions: ['*'] }
      ],
      properties: ['openFile'] as 'openFile'[]
    }
    const picked = await showOpenDialog(window, options)
    csvFile = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (!csvFile) return { file: null, candidates: [], ignored: {} }
    return { file: csvFile, ...scanCsvFile(csvFile) }
  })
  handle('csv:import', isTrustedSender, (aliases) => {
    if (!csvFile) throw new Error(t('Choose a CSV file first'))
    const result = importCandidates(service, scanCsvFile(csvFile).candidates, aliases, 'csv')
    notifyChanged()
    return result
  })
}
