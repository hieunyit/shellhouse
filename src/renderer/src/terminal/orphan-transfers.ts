import { baseName, type TransferStatus } from '@shared/sftp'

/**
 * Lượt truyền của một phiên đã đóng (đứt kết nối, kết nối lại). Phiên mới có hàng đợi riêng, không
 * biết gì về chúng: nếu cứ giữ nguyên "đang chạy 39%" thì nó đứng im mãi và nút Huỷ chẳng làm gì
 * (lượt truyền ma). Chuyển chúng thành lỗi, xử lý tại chỗ (huỷ / bỏ / chạy lại như lượt mới).
 */
export function orphanize(list: readonly TransferStatus[], message: string): TransferStatus[] {
  return list.map((x) =>
    x.state === 'running' || x.state === 'queued'
      ? {
          ...x,
          state: 'error' as const,
          error: message,
          bytesPerSecond: 0,
          // Tải xuống dở còn file part trên máy → tải lại cùng file sẽ tiếp tục.
          ...(x.direction === 'download' && x.transferred > 0 ? { resumable: true } : {})
        }
      : { ...x }
  )
}

/** Tách đường dẫn máy này thành thư mục + tên (cả `/` lẫn `\`). */
export function splitLocal(path: string): { dir: string; name: string } {
  const name = baseName(path)
  const dir = path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]+$/, '')
  return { dir: dir || path.slice(0, 1), name }
}

/** Lượt (đã kết thúc) có thể bỏ khỏi danh sách khi "Clear finished". */
export const isFinished = (x: TransferStatus): boolean =>
  x.state === 'done' || x.state === 'error' || x.state === 'cancelled'
