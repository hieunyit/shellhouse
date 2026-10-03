-- Hệ điều hành server nhận ra lúc kết nối SSH (JSON: {"id","name","version"}) — icon distro trên host.
ALTER TABLE hosts ADD COLUMN os TEXT;
