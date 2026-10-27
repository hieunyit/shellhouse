/** Preserve the previous viewport before a new local ConPTY clears its screen. */
export function sessionBoundary(
  label: string,
  rows: number,
  cursorX: number,
  preserveScreen: boolean
): string {
  const separator = `${cursorX > 0 ? '\r\n' : ''}\x1b[2m— ${label} —\x1b[0m\r\n`
  return separator + (preserveScreen ? '\r\n'.repeat(rows) : '')
}
