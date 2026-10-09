import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { safeFileName } from '@shared/file-names'
import { t } from '@shared/i18n'

/**
 * Thư mục tạm cho "sửa file trên server". Mỗi file một thư mục con ngẫu nhiên (hai file cùng tên
 * trên hai server không đè nhau). Renderer chỉ nhận đường dẫn do main cấp và chỉ mở được file
 * nằm trong thư mục này.
 */
export class RemoteEditFiles {
  constructor(private readonly root: string) {}

  /**
   * Dọn bản sửa của lần chạy trước (phiên SSH đã đóng thì không còn ai theo dõi chúng). Đổi tên
   * thư mục ngay (tức thì) rồi xoá nền — không chặn main lúc khởi động với cây file lớn, và bản sửa
   * mới tạo sau lời gọi này không bị xoá nhầm.
   */
  async cleanup(): Promise<void> {
    const parent = dirname(this.root)
    const prefix = `${basename(this.root)}.old-`
    const old = join(parent, `${prefix}${randomUUID()}`)
    try {
      renameSync(this.root, old)
    } catch (error) {
      // Không có gì để dọn; hoặc Windows không cho đổi tên (editor còn giữ file) → xoá tại chỗ.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        rmSync(this.root, { recursive: true, force: true, maxRetries: 3 })
    }
    // Kể cả thư mục .old-* sót lại từ lần chạy bị tắt ngang giữa chừng.
    const leftovers = await readdir(parent).catch(() => [] as string[])
    await Promise.all(
      leftovers
        .filter((name) => name.startsWith(prefix))
        .map((name) => rm(join(parent, name), { recursive: true, force: true, maxRetries: 3 }))
    )
  }

  prepare(remoteName: string): string {
    const safe = safeFileName(remoteName)
    const dir = join(this.root, randomUUID())
    mkdirSync(dir, { recursive: true })
    return join(dir, safe.slice(0, 200))
  }

  /** Đường dẫn nằm TRONG thư mục tạm (chống renderer mở file bất kỳ trên máy). */
  owns(path: string): boolean {
    if (!isAbsolute(path)) return false
    const rel = relative(this.root, resolve(path))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
}

export interface OpenDeps {
  /** shell.openPath của Electron: trả về '' nếu mở được, không thì thông báo lỗi. */
  openPath(path: string): Promise<string>
  platform: NodeJS.Platform
  /** Cho test; mặc định chạy chương trình tách rời, không qua shell. */
  spawn?: (program: string, args: string[]) => Promise<void>
}

/**
 * Đuôi file mà "mở bằng ứng dụng mặc định" sẽ CHẠY thay vì mở để sửa: chương trình / script /
 * shortcut / trình cài đặt của Windows, macOS, Linux. Tên do server đặt (không tin cậy) — kiểm theo
 * mọi hệ điều hành, không phân biệt hoa thường.
 */
const EXECUTABLE_EXT = new Set([
  // Windows
  'exe',
  'com',
  'bat',
  'cmd',
  'pif',
  'scr',
  'cpl',
  'msi',
  'msp',
  'mst',
  'msc',
  'hta',
  'lnk',
  'url',
  'reg',
  'inf',
  'scf',
  'chm',
  'vb',
  'vbs',
  'vbe',
  'js',
  'jse',
  'ws',
  'wsc',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'psd1',
  'appref-ms',
  'application',
  'gadget',
  'settingcontent-ms',
  'library-ms',
  'search-ms',
  'searchconnector-ms',
  'diagcab',
  'xll',
  'appx',
  'appxbundle',
  'msix',
  'msixbundle',
  'jar',
  'jnlp',
  // macOS
  'command',
  'tool',
  'terminal',
  'app',
  'pkg',
  'mpkg',
  'dmg',
  'workflow',
  'action',
  'scpt',
  'applescript',
  'webloc',
  'inetloc',
  'fileloc',
  // Linux
  'desktop',
  'appimage',
  'run',
  'flatpakref'
])

/** Tên file mà ứng dụng mặc định của hệ điều hành sẽ chạy (không phải mở để sửa). */
export function isExecutableName(path: string): boolean {
  const name = basename(path.replace(/\\/g, '/'))
  const dot = name.lastIndexOf('.')
  return dot >= 0 && EXECUTABLE_EXT.has(name.slice(dot + 1).toLowerCase())
}

/** Chạy chương trình tách rời (không qua shell — tên file do server đặt không thành lệnh). */
function spawnDetached(program: string, args: string[]): Promise<void> {
  return new Promise<void>((resolveSpawn, reject) => {
    const child = spawn(program, args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', (error) => {
      reject(new Error(t('Could not start the editor: {error}', { error: error.message })))
    })
    child.once('spawn', () => {
      child.unref()
      resolveSpawn()
    })
  })
}

/**
 * Mở file bằng editor người dùng chọn, hoặc ứng dụng mặc định. Windows: file không có ứng dụng
 * liên kết (.conf, .service…) → Notepad thay vì báo lỗi.
 *
 * Chưa chọn editor mà file là chương trình / script (`.exe`, `.bat`, `.jar`, `.command`, `.desktop`…):
 * KHÔNG đưa cho ứng dụng mặc định (sẽ chạy file do server đặt trên máy này) — Windows mở bằng
 * Notepad, macOS bằng TextEdit (`open -t`), Linux báo chọn editor.
 */
export async function openInEditor(path: string, editor: string, deps: OpenDeps): Promise<void> {
  const program = editor.trim()
  if (program) {
    if (!existsSync(program) && isAbsolute(program))
      throw new Error(t('The editor was not found: {program}', { program }))
    await (deps.spawn ?? spawnDetached)(program, [path])
    return
  }
  if (isExecutableName(path)) {
    if (deps.platform === 'win32') return (deps.spawn ?? spawnDetached)('notepad.exe', [path])
    if (deps.platform === 'darwin') return (deps.spawn ?? spawnDetached)('open', ['-t', path])
    throw new Error(
      t(
        '“{name}” is a program or script. Choose an editor in Settings › Files to open it as text.',
        { name: basename(path) }
      )
    )
  }
  const error = await deps.openPath(path)
  if (!error) return
  if (deps.platform === 'win32') {
    await (deps.spawn ?? spawnDetached)('notepad.exe', [path])
    return
  }
  throw new Error(error)
}
