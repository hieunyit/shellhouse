import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { create } from 'zustand'
import { t } from '@shared/i18n'
import { Button, IconButton, Modal } from './ui'

/**
 * "Copy as command" (thiết kế v0.7): lệnh CLI tương đương cho thứ đang chọn — `kubectl … -n shop
 * --context prod-cluster`, `docker -H ssh://… `, `aws s3 … --profile …` — để dán vào terminal,
 * runbook hay ticket. Module gọi `showCommands(title, commands)`; hộp thoại vẽ một lần trong App.
 */
export interface CommandLine {
  label: string
  command: string
}

const useSheet = create<{ open: { title: string; commands: CommandLine[] } | null }>(() => ({
  open: null
}))

export function showCommands(title: string, commands: CommandLine[]): void {
  useSheet.setState({ open: { title, commands } })
}

function Row({ line }: { line: CommandLine }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-1 py-2.5" data-testid="command-line">
      <div className="text-xs font-medium text-muted">{line.label}</div>
      <div className="flex items-start gap-2">
        <code className="sh-selectable min-w-0 flex-1 rounded-ds-md bg-subtle px-2.5 py-1.5 font-mono text-xs break-all text-fg">
          {line.command}
        </code>
        <IconButton
          label={copied ? t('Copied') : t('Copy')}
          size="sm"
          className="mt-0.5"
          data-testid="command-copy"
          onClick={() => {
            void window.shellhouse.writeClipboard(line.command).then(() => {
              setCopied(true)
              window.setTimeout(() => {
                setCopied(false)
              }, 1500)
            })
          }}
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </IconButton>
      </div>
    </div>
  )
}

export function CommandSheet(): React.JSX.Element | null {
  const open = useSheet((s) => s.open)
  if (!open) return null
  const close = (): void => {
    useSheet.setState({ open: null })
  }
  return (
    <Modal
      title={open.title}
      description={t('Equivalent commands for your own terminal, runbooks or tickets.')}
      onClose={close}
      width="max-w-2xl"
      testId="command-sheet"
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="command-copy-all"
            onClick={() =>
              void window.shellhouse.writeClipboard(open.commands.map((c) => c.command).join('\n'))
            }
          >
            {t('Copy all')}
          </Button>
          <Button variant="primary" onClick={close}>
            {t('Done')}
          </Button>
        </>
      }
    >
      <div className="divide-y divide-ds-border-subtle">
        {open.commands.map((c) => (
          <Row key={`${c.label}:${c.command}`} line={c} />
        ))}
      </div>
    </Modal>
  )
}

/** Trích dẫn an toàn cho shell POSIX (tên có dấu cách / ký tự lạ). */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}
