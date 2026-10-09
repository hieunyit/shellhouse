import { useState } from 'react'
import { Globe, Lock, LockOpen, Plus, SquareTerminal, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  Select,
  TextArea
} from '../../../renderer/src/components/ui'
import {
  hostEnvironmentId,
  isModuleEnabled,
  PasswordInput,
  rendererModule,
  rendererModules,
  runInModuleSession,
  t,
  toast,
  useEnabledModules,
  useSavedHosts
} from '../../registry/renderer-kit'
import type { RunbookStepKind } from '../../registry/renderer-types'
import {
  CommandParams,
  HTTP_METHODS,
  HttpParams,
  MAX_HEADERS,
  builtinSummary,
  defaultCommand,
  defaultHttp,
  evalCommand,
  evalHttp,
  type ExecResult,
  type HttpHeader,
  type HttpMethod,
  type HttpResult
} from '../shared/runbook'
import { runbookApi } from './api'
import type { KindResolver } from '../shared/runner'

/** Loại bước + cờ "có thể thay đổi gì đó" (chỉ bước lệnh) dùng cho chính sách môi trường chỉ đọc. */
export type UiKind = RunbookStepKind & { mutates: boolean }

/** Số giây còn lại, làm tròn lên (≥ 1) — đưa cho Session Host làm giới hạn thời gian. */
const secondsLeft = (remainingMs: () => number): number =>
  Math.max(1, Math.ceil(remainingMs() / 1000))

/**
 * Ô giá trị bí mật của header: gõ xong (rời ô / Enter) thì gửi vào vault, chỉ giữ id. Đã lưu thì
 * chỉ hiện "đã lưu" + "Thay" — giá trị không bao giờ quay về giao diện.
 */
function SecretValue({
  secretId,
  onStored,
  onReplace
}: {
  secretId: string | undefined
  onStored: (id: string) => void
  onReplace: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  if (secretId)
    return (
      <div
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-ds-md border border-dashed border-line px-2 text-xs text-muted"
        data-testid="runbook-header-secret-stored"
      >
        <Lock size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('Stored encrypted in the vault')}</span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="runbook-header-secret-replace"
          onClick={onReplace}
        >
          {t('Replace')}
        </Button>
      </div>
    )
  const commit = (): void => {
    if (!text || saving) return
    setSaving(true)
    void runbookApi
      .putSecret(text)
      .then((id) => {
        setText('')
        onStored(id)
      })
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setSaving(false)
      })
  }
  return (
    <div className="min-w-0 flex-1">
      <PasswordInput
        mono
        placeholder={t('Secret value — stored encrypted')}
        data-testid="runbook-header-secret"
        value={text}
        disabled={saving}
        onChange={(e) => {
          setText(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </div>
  )
}

function HeaderRow({
  header,
  onChange,
  onRemove
}: {
  header: HttpHeader
  onChange: (next: HttpHeader) => void
  onRemove: () => void
}): React.JSX.Element {
  const toggleSecret = (): void => {
    if (header.secret) {
      // Bỏ bí mật: không lấy lại giá trị cũ (không về renderer) — gõ giá trị thường mới.
      onChange({ name: header.name, value: '', secret: false })
      return
    }
    if (!header.value) {
      onChange({ ...header, secret: true })
      return
    }
    // Giá trị đã gõ thành bí mật: đưa vào vault ngay, không giữ bản rõ trong runbook.
    void runbookApi.putSecret(header.value).then(
      (secretId) => {
        onChange({ name: header.name, value: '', secret: true, secretId })
      },
      (e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    )
  }
  return (
    <div className="flex items-start gap-2" data-testid="runbook-header">
      <Input
        mono
        className="w-48 shrink-0"
        placeholder="Authorization"
        data-testid="runbook-header-name"
        value={header.name}
        onChange={(e) => {
          onChange({ ...header, name: e.target.value })
        }}
      />
      {header.secret ? (
        <SecretValue
          secretId={header.secretId}
          onStored={(secretId) => {
            onChange({ ...header, value: '', secretId })
          }}
          onReplace={() => {
            onChange({ name: header.name, value: '', secret: true })
          }}
        />
      ) : (
        <Input
          mono
          className="min-w-0 flex-1"
          placeholder={t('Value — {{name}} allowed')}
          data-testid="runbook-header-value"
          value={header.value}
          onChange={(e) => {
            onChange({ ...header, value: e.target.value })
          }}
        />
      )}
      <IconButton
        label={header.secret ? t('Not a secret') : t('Keep this value secret')}
        size="sm"
        aria-pressed={header.secret}
        data-testid="runbook-header-secret-toggle"
        onClick={toggleSecret}
      >
        {header.secret ? <Lock size={13} /> : <LockOpen size={13} />}
      </IconButton>
      <IconButton
        label={t('Remove header')}
        size="sm"
        data-testid="runbook-header-remove"
        onClick={onRemove}
      >
        <X size={13} />
      </IconButton>
    </div>
  )
}

function HttpEditor({
  value: raw,
  onChange
}: {
  value: HttpParams
  onChange: (next: HttpParams) => void
}): React.JSX.Element {
  // Bước lưu từ bản cũ thiếu trường mới → điền mặc định (schema có `.default`).
  const value: HttpParams = { ...defaultHttp(), ...raw }
  // Ô mã trạng thái giữ chữ người dùng gõ (có thể đang dở); chỉ đẩy lên khi parse ra ≥ 1 mã hợp lệ.
  const [codes, setCodes] = useState(value.expectStatus.join(', '))
  const setHeader = (i: number, next: HttpHeader | null): void => {
    const headers = value.headers.flatMap((h, j) => (j !== i ? [h] : next ? [next] : []))
    onChange({ ...value, headers })
  }
  return (
    <div className="flex flex-col gap-3" data-testid="runbook-step-http">
      <Field label={t('Address')} hint={t('Use {{name}} for a value you type each time you run.')}>
        <div className="flex gap-2">
          <Select
            className="w-24 shrink-0"
            value={value.method}
            data-testid="runbook-http-method"
            onChange={(e) => {
              onChange({ ...value, method: e.target.value as HttpMethod })
            }}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          <Input
            mono
            className="min-w-0 flex-1"
            placeholder="https://shop.example.com/health"
            data-testid="runbook-http-url"
            value={value.url}
            onChange={(e) => {
              onChange({ ...value, url: e.target.value })
            }}
          />
        </div>
      </Field>
      <div className="flex flex-col gap-2" data-testid="runbook-http-headers">
        <span className="text-xs font-medium text-muted">{t('Headers')}</span>
        {value.headers.map((h, i) => (
          <HeaderRow
            // Hàng header không có id riêng; thứ tự chỉ đổi khi xoá.
            key={i}
            header={h}
            onChange={(next) => {
              setHeader(i, next)
            }}
            onRemove={() => {
              setHeader(i, null)
            }}
          />
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={value.headers.length >= MAX_HEADERS}
            data-testid="runbook-http-add-header"
            onClick={() => {
              onChange({
                ...value,
                headers: [...value.headers, { name: '', value: '', secret: false }]
              })
            }}
          >
            <Plus size={12} /> {t('Add header')}
          </Button>
        </div>
      </div>
      {value.method === 'POST' && (
        <Field label={t('Request body')} hint={t('Sent as is — set Content-Type in the headers')}>
          <TextArea
            rows={3}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder='{"ping": true}'
            data-testid="runbook-http-body"
            value={value.body}
            onChange={(e) => {
              onChange({ ...value, body: e.target.value })
            }}
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Accepted status codes')} hint={t('Separated by commas, like 200, 204')}>
          <Input
            mono
            data-testid="runbook-http-status"
            value={codes}
            onChange={(e) => {
              setCodes(e.target.value)
              const parsed = e.target.value
                .split(/[,\s]+/)
                .filter(Boolean)
                .map(Number)
              if (
                parsed.length > 0 &&
                parsed.every((n) => Number.isInteger(n) && n >= 100 && n <= 599)
              )
                onChange({ ...value, expectStatus: parsed })
            }}
          />
        </Field>
        <Field
          label={t('Response must contain')}
          hint={value.method === 'HEAD' ? t('HEAD has no response body') : t('Optional')}
        >
          <Input
            mono
            data-testid="runbook-http-contains"
            disabled={value.method === 'HEAD'}
            value={value.contains}
            onChange={(e) => {
              onChange({ ...value, contains: e.target.value })
            }}
          />
        </Field>
      </div>
      <Checkbox
        label={t('Skip certificate verification (self-signed internal server)')}
        checked={value.insecureTls}
        data-testid="runbook-http-insecure"
        onChange={(e) => {
          onChange({ ...value, insecureTls: e.target.checked })
        }}
      />
    </div>
  )
}

function CommandEditor({
  value,
  onChange
}: {
  value: CommandParams
  onChange: (next: CommandParams) => void
}): React.JSX.Element {
  const hosts = useSavedHosts().filter((h) => h.protocol === 'ssh')
  return (
    <div className="flex flex-col gap-3" data-testid="runbook-step-command">
      <Field label={t('SSH server')}>
        <Select
          value={value.hostId}
          data-testid="runbook-command-host"
          onChange={(e) => {
            onChange({ ...value, hostId: e.target.value })
          }}
        >
          <option value="">{t('Choose a server…')}</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {`${h.label} · ${h.address}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t('Command')}
        hint={t(
          'Runs with sh -c on the server; passes when the exit code is 0. Use {{name}} for a value you type each time.'
        )}
      >
        <TextArea
          rows={2}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="systemctl is-active shop"
          data-testid="runbook-command-text"
          value={value.command}
          onChange={(e) => {
            onChange({ ...value, command: e.target.value })
          }}
        />
      </Field>
      <Field
        label={t('Output must contain')}
        hint={t('Optional — checked in what the command prints')}
      >
        <Input
          mono
          data-testid="runbook-command-contains"
          value={value.contains}
          onChange={(e) => {
            onChange({ ...value, contains: e.target.value })
          }}
        />
      </Field>
    </div>
  )
}

const httpKind: UiKind = {
  mutates: false,
  label: () => t('HTTP check'),
  icon: Globe,
  params: HttpParams,
  defaults: defaultHttp,
  summary: (p) => builtinSummary('http', p),
  environmentOf: () => null,
  Editor: HttpEditor as UiKind['Editor'],
  run: (raw, ctx) => {
    const p = raw as HttpParams
    const secretIds = p.headers.flatMap((h) => (h.secretId ? [h.secretId] : []))
    return runInModuleSession(
      'runbook',
      // main tính proxy cho địa chỉ và giải mã bí mật thẳng sang Session Host.
      { kind: 'module', sessionKind: 'local', params: { url: p.url, secretIds } },
      ctx,
      async (client, remaining) =>
        evalHttp(
          p,
          await client.request<HttpResult>(
            {
              op: 'http',
              method: p.method,
              url: p.url,
              headers: p.headers.map((h) =>
                h.secretId
                  ? { name: h.name, value: '', secretId: h.secretId }
                  : { name: h.name, value: h.value }
              ),
              body: p.body,
              insecureTls: p.insecureTls,
              timeoutSec: secondsLeft(remaining)
            },
            ctx.signal
          )
        )
    )
  }
}

const commandKind: UiKind = {
  // Lệnh tuỳ ý: Shellhouse không biết nó có ghi gì không → môi trường chỉ đọc chặn.
  mutates: true,
  label: () => t('Command on a server'),
  icon: SquareTerminal,
  params: CommandParams,
  defaults: defaultCommand,
  summary: (p) => builtinSummary('command', p),
  environmentOf: (raw) => hostEnvironmentId((raw as CommandParams).hostId),
  Editor: CommandEditor as UiKind['Editor'],
  run: (raw, ctx) => {
    const p = raw as CommandParams
    return runInModuleSession(
      'runbook',
      { kind: 'ssh', hostId: p.hostId },
      ctx,
      async (client, remaining) =>
        evalCommand(
          p,
          await client.request<ExecResult>(
            { op: 'exec', command: p.command, timeoutSec: secondsLeft(remaining) },
            ctx.signal
          ),
          Math.round(ctx.timeoutMs / 1000)
        )
    )
  }
}

const BUILTIN: Record<string, UiKind> = { http: httpKind, command: commandKind }

/** Loại bước theo tên: dựng sẵn, hoặc `<module>.<khoá>` của module đóng góp (đang bật). */
export function resolveUiKind(type: string): UiKind | 'disabled' | undefined {
  const builtin = BUILTIN[type]
  if (builtin) return builtin
  const [moduleId, key] = type.split('.')
  if (!moduleId || !key) return undefined
  const kind = rendererModule(moduleId)?.runbookSteps?.[key]
  if (!kind) return undefined
  return isModuleEnabled(moduleId) ? { ...kind, mutates: false } : 'disabled'
}

/** Cùng loại bước dưới dạng của bộ chạy (`StepKind`). */
export const resolveKind: KindResolver = (type) => resolveUiKind(type)

export interface KindEntry {
  type: string
  kind: UiKind
}

/** Các loại bước thêm được: dựng sẵn + của module đang bật (theo dõi bật / tắt). */
export function useKindEntries(): KindEntry[] {
  const enabled = useEnabledModules()
  const contributed = enabled.flatMap((m) =>
    Object.entries(m.runbookSteps ?? {}).map(([key, kind]) => ({
      type: `${m.manifest.id}.${key}`,
      kind: { ...kind, mutates: false }
    }))
  )
  return [{ type: 'http', kind: httpKind }, { type: 'command', kind: commandKind }, ...contributed]
}

/** Có module nào (kể cả đang tắt) đóng góp loại này — để báo "module tắt" thay vì "loại lạ". */
export function knownContributedTypes(): string[] {
  return rendererModules().flatMap((m) =>
    Object.keys(m.runbookSteps ?? {}).map((key) => `${m.manifest.id}.${key}`)
  )
}
