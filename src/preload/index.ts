import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { DROPPED_PATH_CHANNEL, PORT_MESSAGE_TYPE, SESSION_PORT_CHANNEL } from '@shared/constants'
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

/** `--shellhouse-lang=vi` do main thêm vào argv (webPreferences.additionalArguments). */
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}
const language = argValue('shellhouse-lang') === 'vi' ? 'vi' : 'en'
const locale = argValue('shellhouse-locale')?.slice(0, 35) ?? 'en-US'

// Chỉ phơi ra các hàm cụ thể — không bao giờ phơi ipcRenderer.
const api: ShellhouseApi = {
  language,
  locale,
  relaunch: () => invoke('app:relaunch'),
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
  moveGroup: (id, parentId) => invoke('groups:move', id, parentId),
  listShells: (refresh) => invoke('shells:list', refresh ?? false),
  moveHosts: (ids, groupId) => invoke('hosts:moveMany', ids, groupId),
  deleteHosts: (ids) => invoke('hosts:deleteMany', ids),
  setFavorite: (ids, favorite) => invoke('hosts:setFavorite', ids, favorite),
  tagHosts: (ids, add, remove) => invoke('hosts:tag', ids, add, remove),
  reorderHosts: (groupId, ids) => invoke('hosts:reorder', groupId, ids),
  duplicateHost: (id) => invoke('hosts:duplicate', id),
  setHostPassword: (id, password) => invoke('hosts:setPassword', id, password),
  reorderGroups: (parentId, ids) => invoke('groups:reorder', parentId, ids),
  pickKeyFile: () => invoke('keys:pick'),
  importPickedKey: (token, name, passphrase, remember) =>
    invoke('keys:importPicked', token, name, passphrase, remember),
  deleteKey: (id) => invoke('keys:delete', id),
  saveAccount: (input) => invoke('accounts:save', input),
  duplicateAccount: (id) => invoke('accounts:duplicate', id),
  deleteAccount: (id, resolution) => invoke('accounts:delete', id, resolution),
  scanSshConfig: () => invoke('sshConfig:scan'),
  importSshConfig: (aliases, options) => invoke('sshConfig:import', aliases, options ?? {}),
  scanMobaXterm: (pick) => invoke('mobaxterm:scan', pick),
  importMobaXterm: (aliases, options) => invoke('mobaxterm:import', aliases, options ?? {}),
  scanAnsible: () => invoke('ansible:scan'),
  importAnsible: (aliases, options) => invoke('ansible:import', aliases, options ?? {}),
  scanCsv: () => invoke('csv:scan'),
  importCsv: (aliases, options) => invoke('csv:import', aliases, options ?? {}),
  scanShellhouseYaml: () => invoke('yaml:scan'),
  importShellhouseYaml: (aliases, options) => invoke('yaml:import', aliases, options ?? {}),
  onHostsChanged: (listener) =>
    subscribe('hosts:changed', () => {
      listener()
    }),
  listForwards: (hostId) => invoke('forwards:list', hostId),
  saveForward: (input) => invoke('forwards:save', input),
  deleteForward: (id) => invoke('forwards:delete', id),
  pickFilesToUpload: () => invoke('dialog:openFiles'),
  pickSaveLocation: (defaultName) => invoke('dialog:saveFile', defaultName),
  saveTextFile: (defaultName, text) => invoke('dialog:saveText', defaultName, text),
  writeChosenFile: (path, text) => invoke('dialog:writeChosen', path, text),
  chooseEditor: () => invoke('files:chooseEditor'),
  resetEditor: () => invoke('files:resetEditor'),
  chooseLogFolder: () => invoke('logs:chooseFolder'),
  setUpdatesInsecure: (enabled) => invoke('updates:setInsecure', enabled),
  listLocal: (path) => invoke('local:list', path),
  trashLocal: (paths) => invoke('local:trash', paths),
  listSerialPorts: () => invoke('serial:list'),
  commandHistory: (target) => invoke('history:list', target),
  modules: () => invoke('modules:list'),
  setModuleEnabled: (id, enabled) => invoke('modules:setEnabled', id, enabled),
  removeModuleData: (id) => invoke('modules:removeData', id),
  invokeModule: (id, name, args) => invoke('modules:invoke', id, name, args),
  detectLocalModules: () => invoke('modules:detectLocal'),
  onModulesChanged: (listener) => subscribe('modules:changed', listener),
  onModuleEvent: (listener) => subscribe('modules:event', listener),
  recordCommand: (target, command) => invoke('history:record', target, command),
  clearCommandHistory: (target) => invoke('history:clear', target),
  pickFolder: (title, start) => invoke('dialog:pickFolder', title, start),
  openLogFolder: () => invoke('logs:openFolder'),
  prepareRemoteEdit: (remoteName) => invoke('files:prepareEdit', remoteName),
  openInEditor: (localPath) => invoke('files:openInEditor', localPath),
  pathForFile: (file) => {
    // Chỉ File thật (kéo thả / chọn file) mới có đường dẫn — báo main để module (S3, Docker) được
    // đọc đường dẫn đó. Trang bị chiếm không tạo được File mang đường dẫn tuỳ ý. Gửi đồng bộ: main
    // ghi nhận xong trước khi renderer gửi đường dẫn sang Session Host.
    const path = webUtils.getPathForFile(file)
    if (path) ipcRenderer.sendSync(DROPPED_PATH_CHANNEL, path)
    return path
  },
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
  setRememberOnDevice: (enabled, password) => invoke('vault:setRemember', enabled, password),
  exportBackup: () => invoke('vault:exportBackup'),
  restoreBackup: (password) => invoke('vault:restoreBackup', password),
  onVaultState: (listener) => subscribe('vault:state', listener),
  readClipboard: () => invoke('clipboard:readText'),
  writeClipboard: (text) => invoke('clipboard:writeText', text),
  rdpCheck: (hostId) => invoke('rdp:check', hostId),
  rdpLaunch: (request) => invoke('rdp:launch', request),
  rdpStop: (launchId) => invoke('rdp:stop', launchId),
  onRdpStatus: (listener) => subscribe('rdp:status', listener),
  scanRdpFiles: () => invoke('rdp:scan'),
  importRdpFiles: (aliases) => invoke('rdp:import', aliases),
  rdpViewPrepare: (hostId) => invoke('rdpView:prepare', hostId),
  rdpViewProbe: (request) => invoke('rdpView:probe', request),
  rdpViewTrust: (hostId, fingerprint) => invoke('rdpView:trust', hostId, fingerprint),
  rdpViewOpen: (request) => invoke('rdpView:open', request)
}

// MessagePort không đi qua contextBridge được → chuyển vào main world bằng window.postMessage.
ipcRenderer.on(SESSION_PORT_CHANNEL, (event, payload: { sessionId: string }) => {
  window.postMessage({ type: PORT_MESSAGE_TYPE, sessionId: payload.sessionId }, '*', event.ports)
})

contextBridge.exposeInMainWorld('shellhouse', api)
