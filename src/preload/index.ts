import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { PORT_MESSAGE_TYPE, SESSION_PORT_CHANNEL } from '@shared/constants'
import type {
  EventChannel,
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  ShellhouseApi
} from '@shared/ipc'

function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<C>>
}

function subscribe<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: EventPayload<C>): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

// Chỉ phơi ra các hàm cụ thể — không bao giờ phơi ipcRenderer.
const api: ShellhouseApi = {
  getInfo: () => invoke('app:getInfo'),
  getSessionHostStatus: () => invoke('sessionHost:getStatus'),
  checkNativeModules: () => invoke('diagnostics:nativeModules'),
  crashSessionHostForTest: () => invoke('test:crashSessionHost'),
  onSessionHostStatus: (listener) => subscribe('sessionHost:status', listener),
  openSession: (spec) => invoke('session:open', spec),
  closeSession: (sessionId) => invoke('session:close', sessionId),
  hostTree: () => invoke('hosts:tree'),
  saveHost: (input) => invoke('hosts:save', input),
  deleteHost: (id) => invoke('hosts:delete', id),
  moveHost: (id, groupId) => invoke('hosts:move', id, groupId),
  saveGroup: (input) => invoke('groups:save', input),
  deleteGroup: (id) => invoke('groups:delete', id),
  importKeyFromFile: () => invoke('keys:importFromFile'),
  deleteKey: (id) => invoke('keys:delete', id),
  scanSshConfig: () => invoke('sshConfig:scan'),
  importSshConfig: (aliases) => invoke('sshConfig:import', aliases),
  onHostsChanged: (listener) =>
    subscribe('hosts:changed', () => {
      listener()
    }),
  listForwards: (hostId) => invoke('forwards:list', hostId),
  saveForward: (input) => invoke('forwards:save', input),
  deleteForward: (id) => invoke('forwards:delete', id),
  pickFilesToUpload: () => invoke('dialog:openFiles'),
  pickSaveLocation: (defaultName) => invoke('dialog:saveFile', defaultName),
  pathForFile: (file) => webUtils.getPathForFile(file),
  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  onSettingsChanged: (listener) => subscribe('settings:changed', listener),
  listSnippets: () => invoke('snippets:list'),
  saveSnippet: (input) => invoke('snippets:save', input),
  deleteSnippet: (id) => invoke('snippets:delete', id),
  generateKey: (options) => invoke('keys:generate', options),
  publicKey: (id) => invoke('keys:publicKey', id),
  exportPrivateKey: (id) => invoke('keys:exportPrivate', id),
  updateStatus: () => invoke('updates:status'),
  checkForUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  installUpdate: () => invoke('updates:install'),
  onUpdateStatus: (listener) => subscribe('updates:status', listener),
  vaultState: () => invoke('vault:getState'),
  createVault: (password) => invoke('vault:create', password),
  unlockVault: (password) => invoke('vault:unlock', password),
  lockVault: () => invoke('vault:lock'),
  vaultSecurity: () => invoke('vault:security'),
  changeMasterPassword: (current, next) => invoke('vault:changePassword', current, next),
  setRememberOnDevice: (enabled) => invoke('vault:setRemember', enabled),
  exportBackup: () => invoke('vault:exportBackup'),
  restoreBackup: (password) => invoke('vault:restoreBackup', password),
  onVaultState: (listener) => subscribe('vault:state', listener),
  readClipboard: () => invoke('clipboard:readText'),
  writeClipboard: (text) => invoke('clipboard:writeText', text)
}

// MessagePort không đi qua contextBridge được → chuyển vào main world bằng window.postMessage.
ipcRenderer.on(SESSION_PORT_CHANNEL, (event, payload: { sessionId: string }) => {
  window.postMessage({ type: PORT_MESSAGE_TYPE, sessionId: payload.sessionId }, '*', event.ports)
})

contextBridge.exposeInMainWorld('shellhouse', api)
