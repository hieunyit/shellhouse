/**
 * Bí danh Host cho OpenSSH config: chữ thường, không dấu cách. File riêng, không phụ thuộc gì: Quick
 * Connect (nạp lúc khởi động) dùng hàm này — import từ host-export sẽ kéo cả thư viện `yaml` (~100 KB)
 * vào chunk khởi động.
 */
export function sshAlias(label: string): string {
  return (
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/gi, 'd')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'host'
  )
}
