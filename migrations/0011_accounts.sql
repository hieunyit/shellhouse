-- Tài khoản dùng chung (Settings → Accounts): identity có shared = 1 hiện trong danh sách tài khoản,
-- nhiều host trỏ tới qua hosts.identity_id (liên kết, không sao chép). Identity riêng của từng host
-- (shared = 0) giữ nguyên như cũ.
--
-- split_secrets = 1: secret_enc LUÔN là mật khẩu, passphrase_enc là passphrase của key_id — một
-- identity có thể có cả key lẫn mật khẩu (khi kết nối: thử key trước rồi tới mật khẩu). Mọi tài
-- khoản dùng chung đều ở dạng này. split_secrets = 0 (dữ liệu cũ): secret_enc là mật khẩu khi
-- auth_type = 'password', là passphrase khi auth_type = 'key'.
ALTER TABLE identities ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE identities ADD COLUMN split_secrets INTEGER NOT NULL DEFAULT 0;
ALTER TABLE identities ADD COLUMN passphrase_enc BLOB;
-- Domain Windows cho Remote Desktop ('' / NULL = không có) và ghi chú tự do.
ALTER TABLE identities ADD COLUMN domain TEXT;
ALTER TABLE identities ADD COLUMN notes TEXT;
CREATE INDEX identities_shared ON identities(shared) WHERE deleted_at IS NULL;
