-- Giá trị kiểm tra: seal(DEK, hằng số) — để xác minh một DEK lấy từ keychain của hệ điều hành
-- ("nhớ trên máy này") mà không cần master password.
ALTER TABLE vault_meta ADD COLUMN dek_check BLOB;
