import { t } from '@shared/i18n'
import { choose } from '../../stores/confirm'

/**
 * Hỏi ghi đè cho một lượt tải lên / tải về nhiều mục: "Replace all" / "Skip all" áp dụng cho các mục
 * còn lại của lượt đó. Đóng hộp thoại (Esc) = bỏ qua mọi mục còn lại.
 *
 *   const ask = overwriteAsker(total)
 *   if (exists && !(await ask(t('“{name}” already exists on the server.', { name })))) continue
 */
export function overwriteAsker(
  total: number,
  title?: string
): (message: string) => Promise<boolean> {
  let all: boolean | null = null
  let asked = 0
  return async (message) => {
    asked++
    if (all !== null) return all
    // Còn mục khác phía sau (có thể cũng trùng) → có "… all".
    const more = total - asked > 0
    const choice = await choose({
      title: title ?? t('Replace existing item?'),
      message,
      testId: 'overwrite-dialog',
      width: 'max-w-md',
      choices: [
        ...(more
          ? [{ value: 'skip-all', label: t('Skip all'), testId: 'overwrite-skip-all' }]
          : []),
        { value: 'skip', label: t('Skip'), testId: 'overwrite-skip' },
        ...(more
          ? [{ value: 'replace-all', label: t('Replace all'), testId: 'overwrite-replace-all' }]
          : []),
        {
          value: 'replace',
          label: t('Replace'),
          variant: 'primary' as const,
          autoFocus: true,
          testId: 'overwrite-replace'
        }
      ]
    })
    if (choice === 'replace-all') all = true
    if (choice === 'skip-all' || choice === null) all = false
    return choice === 'replace' || choice === 'replace-all'
  }
}
