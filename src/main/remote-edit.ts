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
}

/**
 * Mở file bằng editor người dùng chọn, hoặc ứng dụng mặc định. Windows: file không có ứng dụng
 * liên kết (.conf, .service…) → Notepad thay vì báo lỗi.
 */
export async function openInEditor(path: string, editor: string, deps: OpenDeps): Promise<void> {
  const program = editor.trim()
  if (program) {
    if (!existsSync(program) && isAbsolute(program))
      throw new Error(t('The editor was not found: {program}', { program }))
    await new Promise<void>((resolveSpawn, reject) => {
      // Không qua shell: đường dẫn file (tên do server đặt) không bao giờ bị hiểu thành lệnh.
      const child = spawn(program, [path], { detached: true, stdio: 'ignore', shell: false })
      child.once('error', (error) => {
        reject(new Error(t('Could not start the editor: {error}', { error: error.message })))
      })
      child.once('spawn', () => {
        child.unref()
        resolveSpawn()
      })
    })
    return
  }
  const error = await deps.openPath(path)
  if (!error) return
  if (deps.platform === 'win32') {
    await openInEditor(path, 'notepad.exe', deps)
    return
  }
  throw new Error(error)
}
