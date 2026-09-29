import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import type { MutationResult } from '@shared/hosts'
import { handle } from '../ipc/router'
import type { HostService } from './service'
import { scanSshConfig } from './ssh-config-import'

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
    const wanted = new Set(aliases)
    const candidates = scanSshConfig(readSshConfig(), {
      home: app.getPath('home'),
      existingLabels: service.tree().hosts.map((h) => h.label),
      defaultUser: currentUser()
    })
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
          groupId: null,
          label: c.alias,
          hostname: c.hostname,
          port: c.port,
          username: c.username,
          auth: 'auto',
          keyId: null,
          keyFile: c.keyFile,
          proxyJump: c.proxyJump,
          jumpHostIds: [],
          mode: 'builtin',
          tags: ['ssh-config'],
          color: null
        })
        imported++
      } catch (error) {
        log.warn(`Skipping ${c.alias}: ${errorMessage(error)}`)
        skipped.push(c.alias)
      }
    }
    notifyChanged()
    return { imported, skipped }
  })
}
