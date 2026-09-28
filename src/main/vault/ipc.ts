import type { VaultResult } from '@shared/ipc'
import { Secret } from '../../node-shared/secret'
import {
  PasswordTooShortError,
  VaultBusyError,
  VaultExistsError,
  WrongPasswordError
} from './vault'

/** Chạy thao tác vault với password từ renderer; luôn xoá password khỏi bộ nhớ sau đó. */
export async function runVaultOp(
  password: string,
  op: (password: Secret) => Promise<void>
): Promise<VaultResult> {
  const secret = Secret.fromString(password)
  try {
    await op(secret)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof WrongPasswordError) return { ok: false, code: 'wrong-password', message }
    if (error instanceof PasswordTooShortError) return { ok: false, code: 'too-short', message }
    if (error instanceof VaultBusyError) return { ok: false, code: 'busy', message }
    if (error instanceof VaultExistsError) return { ok: false, code: 'exists', message }
    return { ok: false, code: 'failed', message }
  } finally {
    secret.dispose()
  }
}
