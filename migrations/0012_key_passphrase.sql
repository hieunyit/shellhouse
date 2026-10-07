-- Passphrase của SSH key (tuỳ chọn, mã hoá bằng vault): nhập lúc import key để không phải gõ lại
-- mỗi lần kết nối. Host / tài khoản có passphrase riêng thì passphrase đó được dùng trước.
ALTER TABLE keys ADD COLUMN passphrase_enc BLOB;
