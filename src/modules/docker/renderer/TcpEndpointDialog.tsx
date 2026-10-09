import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button, Field, Input, Modal, Notice, TextArea } from '../../../renderer/src/components/ui'
import { EnvironmentPicker, setSourceEnvironment, t } from '../../registry/renderer-kit'
import { tcpSource, type DockerTcpEndpoint, type TcpEndpointInput } from '../shared/ipc'
import { dockerApi } from './api'

type PemKind = 'ca' | 'cert' | 'key'

interface PemState {
  text: string
  /** Người dùng đã chạm vào (dán / chọn tệp) — khi sửa, chưa chạm = giữ bản đã lưu. */
  touched: boolean
  removed: boolean
}

const EMPTY: PemState = { text: '', touched: false, removed: false }

const BEGIN: Record<PemKind, string> = {
  ca: '-----BEGIN CERTIFICATE-----',
  cert: '-----BEGIN CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----'
}

function PemField({
  kind,
  label,
  hint,
  saved,
  state,
  onChange
}: {
  kind: PemKind
  label: string
  hint: string
  /** Đã có bản lưu trong vault (đang sửa). */
  saved: boolean
  state: PemState
  onChange: (next: PemState) => void
}): React.JSX.Element {
  const keeping = saved && !state.touched && !state.removed
  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-1.5">
        <TextArea
          rows={3}
          spellCheck={false}
          className="font-mono text-[11px]"
          data-testid={`docker-tcp-${kind}`}
          placeholder={keeping ? t('Saved in the vault — leave empty to keep it') : BEGIN[kind]}
          value={state.removed ? '' : state.text}
          disabled={state.removed}
          onChange={(e) => {
            onChange({ text: e.target.value, touched: true, removed: false })
          }}
        />
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            data-testid={`docker-tcp-${kind}-file`}
            onClick={() => {
              void dockerApi.pickPem(kind).then((file) => {
                if (file) onChange({ text: file.content, touched: true, removed: false })
              })
            }}
          >
            <FolderOpen size={13} /> {t('Choose file…')}
          </Button>
          {saved && !state.removed && (
            <Button
              variant="ghost"
              data-testid={`docker-tcp-${kind}-remove`}
              onClick={() => {
                onChange({ text: '', touched: true, removed: true })
              }}
            >
              {t('Remove saved')}
            </Button>
          )}
          {state.removed && (
            <span className="text-xs text-faint">{t('Will be removed when you save')}</span>
          )}
        </div>
      </div>
    </Field>
  )
}

/**
 * Thêm / sửa một engine Docker ở địa chỉ TCP + TLS (daemon `-H tcp://host:2376 --tlsverify`). CA,
 * chứng chỉ client và khoá riêng được kiểm rồi cất trong vault — giao diện không bao giờ nhận lại.
 */
export function TcpEndpointDialog({
  endpoint,
  onClose,
  onSaved
}: {
  endpoint?: DockerTcpEndpoint | undefined
  onClose: () => void
  onSaved: (id: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(endpoint?.name ?? '')
  const [host, setHost] = useState(endpoint?.host ?? '')
  const [port, setPort] = useState(String(endpoint?.port ?? 2376))
  const [ca, setCa] = useState<PemState>(EMPTY)
  const [cert, setCert] = useState<PemState>(EMPTY)
  const [key, setKey] = useState<PemState>(EMPTY)
  const [environment, setEnvironment] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const portNumber = Number(port)
  const valid =
    name.trim() !== '' &&
    host.trim() !== '' &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535

  // Chuỗi = thay, null = xoá, vắng = giữ (khi sửa) / không có (khi thêm).
  const payload = (s: PemState): string | null | undefined =>
    s.removed ? null : s.touched && s.text.trim() ? s.text : undefined

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const input: TcpEndpointInput = {
      ...(endpoint ? { id: endpoint.id } : {}),
      name: name.trim(),
      host: host.trim(),
      port: portNumber,
      ca: payload(ca),
      cert: payload(cert),
      key: payload(key)
    }
    const r = await dockerApi.saveTcp(input).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e)
    }))
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    if (environment) await setSourceEnvironment('docker', tcpSource(r.id), environment)
    onSaved(r.id)
  }

  return (
    <Modal
      title={endpoint ? t('Edit engine') : t('Add an engine by address')}
      description={t(
        'For a Docker daemon listening on a TLS port (usually 2376). Certificates are checked, then stored encrypted in your vault.'
      )}
      width="max-w-xl"
      onClose={onClose}
      testId="docker-tcp-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="docker-tcp-save"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {endpoint ? t('Save') : t('Add')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('Name')}>
          <Input
            autoFocus
            placeholder="legacy-build-server"
            data-testid="docker-tcp-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
        </Field>
        <div className="flex gap-3">
          <Field label={t('Host')} className="min-w-0 flex-1">
            <Input
              mono
              placeholder="docker.example.com"
              data-testid="docker-tcp-host"
              value={host}
              onChange={(e) => {
                setHost(e.target.value)
              }}
            />
          </Field>
          <Field label={t('Port')} className="w-24">
            <Input
              mono
              inputMode="numeric"
              data-testid="docker-tcp-port"
              value={port}
              onChange={(e) => {
                setPort(e.target.value)
              }}
            />
          </Field>
        </div>
        <PemField
          kind="ca"
          label={t('CA certificate')}
          hint={t('The CA that signed the daemon’s certificate (ca.pem). Empty = system CAs.')}
          saved={endpoint?.hasCa === true}
          state={ca}
          onChange={setCa}
        />
        <PemField
          kind="cert"
          label={t('Client certificate')}
          hint={t('cert.pem — needed when the daemon runs with --tlsverify.')}
          saved={endpoint?.hasCert === true}
          state={cert}
          onChange={setCert}
        />
        <PemField
          kind="key"
          label={t('Client private key')}
          hint={t('key.pem without a passphrase. It never leaves the vault after saving.')}
          saved={endpoint?.hasKey === true}
          state={key}
          onChange={setKey}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{t('Environment')}</span>
          <EnvironmentPicker
            value={environment}
            onChange={setEnvironment}
            testIdPrefix="docker-tcp-env"
          />
        </div>
        <Notice tone="info">
          {t(
            'Compose, image builds and opening a shell in a container need the docker command line and are not available for engines added by address.'
          )}
        </Notice>
        {error && (
          <Notice tone="danger" testId="docker-tcp-error">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
