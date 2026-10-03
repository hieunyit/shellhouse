-- Remote Desktop trong tab: chứng chỉ TLS của server RDP người dùng đã tin (TOFU — như known_hosts
-- của SSH). Theo đích host:port; chứng chỉ khác lần trước → hỏi lại trước khi gửi mật khẩu.
CREATE TABLE rdp_certificates (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  subject TEXT NOT NULL,
  trusted_at INTEGER NOT NULL,
  PRIMARY KEY (host, port)
);
