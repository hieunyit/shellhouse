import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { t } from '@shared/i18n'
import {
  Username,
  type ImportCandidate,
  type ImportOptions,
  type MutationResult
} from '@shared/hosts'
import { showOpenDialog, showSaveDialog } from '../dialogs'
import { writePrivateFile } from '../private-file'
import { handle } from '../ipc/router'
import { scanCsv } from './csv-import'
import { scanAnsibleInventory } from './ansible-import'
import { scanShellhouseYaml } from './yaml-import'
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
function groupPathResolver(
  service: HostService
): (path: readonly string[], base?: string | null) => string | null {
  const children = new Map<string | null, { id: string; name: string }[]>()
  for (const g of service.groups()) {
    const list = children.get(g.parentId) ?? []
    list.push({ id: g.id, name: g.name })
    children.set(g.parentId, list)
  }
  return (path, base = null) => {
    let parentId: string | null = base
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
  tag: string,
  options: ImportOptions = {}
): { imported: number; skipped: string[] } {
  const wanted = new Set(aliases)
  let imported = 0
  const skipped: string[] = []
  // Một transaction cho cả lượt (mỗi host là một savepoint lồng bên trong: host lỗi chỉ bỏ host đó).
  return service.batch(() => {
    const ensureGroupPath = groupPathResolver(service)
    for (const c of candidates) {
      if (!wanted.has(c.alias)) continue
      // User nhập lúc nhập thay user của file (và điền cho host file không ghi user).
      const username = options.username ?? c.username
      if (c.problem || !username) {
        skipped.push(c.alias)
        continue
      }
      try {
        service.saveHost({
          groupId: ensureGroupPath(c.group ?? [], options.groupId ?? null),
          label: c.label ?? c.alias,
          hostname: c.hostname,
          port: c.port,
          username,
          // Key chọn lúc nhập (trong vault) thay IdentityFile của file.
          ...(options.keyId
            ? { auth: 'key' as const, keyId: options.keyId, keyFile: null }
            : { auth: 'auto' as const, keyId: null, keyFile: c.keyFile }),
          // Jump host chọn lúc nhập thay ProxyJump của file.
          ...(options.jumpHostId
            ? { proxyJump: null, jumpHostIds: [options.jumpHostId] }
            : { proxyJump: c.proxyJump, jumpHostIds: [] }),
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

/**
 * User của máy này làm user mặc định khi file không ghi (như OpenSSH). Tên không dùng được cho SSH
 * (Windows: có dấu cách, "DOMAIN\\user"…) → null: người dùng nhập ở ô User lúc nhập.
 */
function currentUser(): string | null {
  const user = process.env['USER'] ?? process.env['USERNAME'] ?? null
  return user !== null && Username.safeParse(user).success ? user : null
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

  // Import key hai bước: main giữ nội dung file vừa chọn (theo token), renderer hỏi tên / passphrase.
  const pickedKeys = new Map<string, { pem: string; file: string }>()
  handle('keys:pick', isTrustedSender, async () => {
    const picked = await showOpenDialog(getWindow(), {
      title: t('Choose a private key'),
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    if (statSync(file).size > MAX_KEY_FILE_BYTES)
      throw new Error(t('The file is too large to be a private key'))
    const pem = readFileSync(file, 'utf8')
    const info = service.inspectKey(pem)
    const token = randomUUID()
    // Chỉ giữ lần chọn gần nhất (không tích tụ private key trong bộ nhớ).
    pickedKeys.clear()
    pickedKeys.set(token, { pem, file })
    return {
      token,
      file: basename(file),
      suggestedName: info.comment.trim() || basename(file),
      type: info.type,
      fingerprint: info.fingerprint,
      encrypted: info.encrypted
    }
  })
  handle('keys:importPicked', isTrustedSender, (token, name, passphrase, remember) =>
    changing(() =>
      mutation(() => {
        const picked = pickedKeys.get(token)
        if (!picked) throw new Error(t('Choose the key file again'))
        const key = service.importKey(name, picked.pem, passphrase ?? undefined, remember)
        pickedKeys.delete(token)
        log.info(`Imported key ${key.name} (${key.fingerprint})`)
        return key.id
      })
    )
  )
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

  handle('accounts:save', isTrustedSender, (input) =>
    changing(() => mutation(() => service.saveAccount(input)))
  )
  handle('accounts:duplicate', isTrustedSender, (id) =>
    changing(() => mutation(() => service.duplicateAccount(id)))
  )
  handle('accounts:delete', isTrustedSender, (id, resolution) =>
    changing(() =>
      mutation(() => {
        service.deleteAccount(id, resolution)
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
  handle('sshConfig:import', isTrustedSender, (aliases, options) => {
    const candidates = scanSshConfig(readSshConfig(), {
      home: app.getPath('home'),
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
    const result = importCandidates(service, candidates, aliases, 'ssh-config', options)
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
  handle('mobaxterm:import', isTrustedSender, (aliases, options) => {
    if (!mobaFile) throw new Error(t('Choose a MobaXterm file first'))
    const result = importCandidates(
      service,
      scanMoba(mobaFile).candidates,
      aliases,
      'mobaxterm',
      options
    )
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
  handle('csv:import', isTrustedSender, (aliases, options) => {
    if (!csvFile) throw new Error(t('Choose a CSV file first'))
    const result = importCandidates(
      service,
      scanCsvFile(csvFile).candidates,
      aliases,
      'csv',
      options
    )
    notifyChanged()
    return result
  })
  // Inventory Ansible (INI / YAML): main giữ đường dẫn file đã chọn, như CSV.
  let ansibleFile: string | null = null
  const scanAnsibleFile = (file: string) => {
    if (statSync(file).size > MAX_MOBA_INI_BYTES) throw new Error(t('The file is too large'))
    return scanAnsibleInventory(readFileSync(file, 'utf8'), {
      existingLabels: service.tree().hosts.map((h) => h.label),
      // Inventory không ghi ansible_user: không đoán bằng user của máy này — hỏi ở ô User.
      defaultUser: null
    })
  }
  handle('ansible:scan', isTrustedSender, async () => {
    const picked = await showOpenDialog(getWindow(), {
      title: t('Choose an Ansible inventory'),
      filters: [
        { name: t('Ansible inventory'), extensions: ['ini', 'yml', 'yaml', 'cfg', 'txt'] },
        { name: t('All files'), extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    ansibleFile = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (!ansibleFile) return { file: null, candidates: [], ignored: {} }
    return { file: ansibleFile, ...scanAnsibleFile(ansibleFile) }
  })
  handle('ansible:import', isTrustedSender, (aliases, options) => {
    if (!ansibleFile) throw new Error(t('Choose an Ansible inventory first'))
    const result = importCandidates(
      service,
      scanAnsibleFile(ansibleFile).candidates,
      aliases,
      'ansible',
      options
    )
    notifyChanged()
    return result
  })
  // Shellhouse YAML (Export hosts) — main giữ đường dẫn, renderer chỉ gửi danh sách đã chọn.
  let yamlFile: string | null = null
  const scanYamlFile = (file: string) => {
    if (statSync(file).size > MAX_MOBA_INI_BYTES) throw new Error(t('The file is too large'))
    return scanShellhouseYaml(readFileSync(file, 'utf8'), {
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
  }
  handle('yaml:scan', isTrustedSender, async () => {
    const picked = await showOpenDialog(getWindow(), {
      title: t('Choose a Shellhouse hosts file'),
      filters: [
        { name: 'YAML', extensions: ['yaml', 'yml'] },
        { name: t('All files'), extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    yamlFile = picked.canceled ? null : (picked.filePaths[0] ?? null)
    if (!yamlFile) return { file: null, candidates: [], ignored: {} }
    return { file: yamlFile, ...scanYamlFile(yamlFile) }
  })
  handle('yaml:import', isTrustedSender, (aliases, options) => {
    if (!yamlFile) throw new Error(t('Choose a file first'))
    const result = importCandidates(
      service,
      scanYamlFile(yamlFile).candidates,
      aliases,
      'imported',
      options
    )
    notifyChanged()
    return result
  })
}
