import type { Migration } from './migrate'
import m0001 from '../../../migrations/0001_init.sql?raw'
import m0002 from '../../../migrations/0002_keys_encrypted.sql?raw'
import m0003 from '../../../migrations/0003_vault_dek_check.sql?raw'

/** Thứ tự phát hành. Chỉ thêm vào cuối. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: m0001 },
  { version: 2, name: 'keys_encrypted', sql: m0002 },
  { version: 3, name: 'vault_dek_check', sql: m0003 }
]
