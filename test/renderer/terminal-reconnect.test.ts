// @vitest-environment jsdom
import './ds-dom'
import { Terminal } from '@xterm/xterm'
import { expect, it } from 'vitest'
import { sessionBoundary } from '../../src/renderer/src/terminal/session-boundary'

it('keeps scrollback and session markers after the next ConPTY clears and homes its screen', async () => {
  const term = new Terminal({
    cols: 40,
    rows: 5,
    scrollback: 100,
    scrollOnEraseInDisplay: false,
    allowProposedApi: true
  })
  const write = (s: string): Promise<void> =>
    new Promise((resolve) => {
      term.write(s, resolve)
    })
  try {
    await write('before-42\r\nold prompt> ')
    await write(sessionBoundary('new session', term.rows, term.buffer.active.cursorX, true))
    await write('\x1b[2J\x1b[Hnew prompt> after-42')
    const buffer = term.buffer.active
    const text = Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true) ?? ''
    ).join('\n')
    expect(text).toContain('before-42')
    expect(text).toContain('— new session —')
    expect(text).toContain('after-42')
  } finally {
    term.dispose()
  }
})
