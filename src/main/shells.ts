import { detectShells, type ShellProfile } from '../node-shared/shells'

/** Danh sách shell dò một lần (dò WSL mất ~1 giây), dùng cho menu "New terminal" và mở phiên. */
export class ShellService {
  private cache: Promise<ShellProfile[]> | null = null

  constructor(private readonly detect: () => Promise<ShellProfile[]> = () => detectShells()) {}

  list(): Promise<ShellProfile[]> {
    this.cache ??= this.detect().catch(() => [])
    return this.cache
  }

  /** Dò lại (ví dụ vừa cài thêm bản WSL). */
  refresh(): Promise<ShellProfile[]> {
    this.cache = null
    return this.list()
  }

  /** Shell theo id; không có id / id không còn → shell mặc định trong cài đặt → shell đầu tiên. */
  async resolve(id: string | undefined, preferred: string): Promise<ShellProfile | undefined> {
    const shells = await this.list()
    return shells.find((s) => s.id === id) ?? shells.find((s) => s.id === preferred) ?? shells[0]
  }
}
