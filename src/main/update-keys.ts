/**
 * Public key ed25519 dùng để xác minh file kênh cập nhật Linux (ADR-0008).
 * Tạo bằng `node scripts/sign-update.mjs --generate`; khoá riêng chỉ nằm trong secret của CI.
 * Để xoay vòng khoá: thêm key mới vào đây, phát hành một bản, rồi mới đổi khoá ký trên CI.
 *
 * Danh sách rỗng = chưa cấu hình: bản build Linux sẽ từ chối cập nhật tự động (xem Updater).
 */
export const UPDATE_PUBLIC_KEYS: readonly string[] = [
  // Key #1 — tạo 2026-09-29. Khoá riêng: secret UPDATE_SIGNING_KEY (bản gốc cất ngoài repo).
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAN6uq8pvjILmyW2EO4B71mQh8EDw1FfTBpz0h6Bly/HY=
-----END PUBLIC KEY-----`
]
