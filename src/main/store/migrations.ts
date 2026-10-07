import type { Migration } from './migrate'
import m0001 from '../../../migrations/0001_init.sql?raw'
import m0002 from '../../../migrations/0002_keys_encrypted.sql?raw'
import m0003 from '../../../migrations/0003_vault_dek_check.sql?raw'
import m0004 from '../../../migrations/0004_group_defaults_favorites_sort.sql?raw'
import m0005 from '../../../migrations/0005_snippet_mode_command_history.sql?raw'
import m0006 from '../../../migrations/0006_s3_accounts.sql?raw'
import m0007 from '../../../migrations/0007_s3_pins.sql?raw'
import m0008 from '../../../migrations/0008_modules.sql?raw'
import m0009 from '../../../migrations/0009_host_os.sql?raw'
import m0010 from '../../../migrations/0010_rdp_certificates.sql?raw'
import m0011 from '../../../migrations/0011_accounts.sql?raw'
import m0012 from '../../../migrations/0012_key_passphrase.sql?raw'

/** Thứ tự phát hành. Chỉ thêm vào cuối. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: m0001 },
  { version: 2, name: 'keys_encrypted', sql: m0002 },
  { version: 3, name: 'vault_dek_check', sql: m0003 },
  { version: 4, name: 'group_defaults_favorites_sort', sql: m0004 },
  { version: 5, name: 'snippet_mode_command_history', sql: m0005 },
  { version: 6, name: 's3_accounts', sql: m0006 },
  { version: 7, name: 's3_pins', sql: m0007 },
  { version: 8, name: 'modules', sql: m0008 },
  { version: 9, name: 'host_os', sql: m0009 },
  { version: 10, name: 'rdp_certificates', sql: m0010 },
  { version: 11, name: 'accounts', sql: m0011 },
  { version: 12, name: 'key_passphrase', sql: m0012 }
]
