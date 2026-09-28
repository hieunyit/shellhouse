-- Schema v1. KHÔNG sửa file này sau khi đã phát hành; thay đổi schema = thêm file mới.
-- Trường *_enc: nonce(24) || ciphertext || tag(16), mã hoá bằng DEK, AD = "table|id|field|v1".
-- Thời gian: Unix ms. ID: UUIDv7.

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ed25519', 'rsa', 'ecdsa')),
  public_key TEXT NOT NULL,
  private_key_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key', 'agent')),
  secret_enc BLOB,
  key_id TEXT REFERENCES keys(id),
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  jump_host_ids TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'builtin' CHECK (mode IN ('builtin', 'system')),
  options TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  color TEXT,
  last_used_at INTEGER,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX hosts_group ON hosts(group_id) WHERE deleted_at IS NULL;

CREATE TABLE forwards (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('L', 'R', 'D')),
  bind_addr TEXT NOT NULL DEFAULT '127.0.0.1',
  bind_port INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
  dest_host TEXT,
  dest_port INTEGER CHECK (dest_port BETWEEN 1 AND 65535),
  auto_start INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE known_hosts (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (host, port, key_type)
);

CREATE TABLE vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  kdf TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  salt BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
