import { useState } from 'react'
import { t } from '@shared/i18n'
import { isProxyUrl, type NetworkSettings } from '@shared/proxy'
import { useSettings } from '../../stores/settings'
import { Checkbox, Field, Input, SectionTitle, Segmented } from '../ui'

/**
 * Proxy cho kết nối ra ngoài (S3, Kubernetes API, cập nhật) + bỏ qua lỗi chứng chỉ khi cập nhật.
 * Ô nhập lưu khi rời ô (URL sai thì giữ lại để sửa, không lưu).
 */
export function NetworkSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const network = settings.network
  const [url, setUrl] = useState(network.proxyUrl)
  const [noProxy, setNoProxy] = useState(network.noProxy)
  const urlInvalid = url.trim() !== '' && !isProxyUrl(url.trim())
  const save = (patch: Partial<NetworkSettings>): void => void update({ network: patch })

  return (
    <div className="flex flex-col gap-4" data-testid="settings-network">
      <SectionTitle
        description={t(
          'Used for S3, the Kubernetes API and update checks. SSH and Telnet use jump hosts instead. A proxy-url in a kubeconfig always wins for that cluster.'
        )}
      >
        {t('Proxy')}
      </SectionTitle>
      <Segmented
        value={network.proxyMode}
        testIdPrefix="setting-proxy-mode"
        options={[
          {
            value: 'system',
            label: t('System'),
            hint: t('HTTPS_PROXY / HTTP_PROXY / NO_PROXY variables; the system proxy for updates')
          },
          { value: 'manual', label: t('Manual') },
          { value: 'none', label: t('No proxy') }
        ]}
        onChange={(proxyMode) => {
          save({ proxyMode })
        }}
      />
      {network.proxyMode === 'manual' && (
        <Field
          label={t('Proxy address')}
          hint={
            urlInvalid ? (
              <span className="text-danger">
                {t('Use http://host:port, https://host:port or socks5://host:port')}
              </span>
            ) : (
              t(
                'http://, https:// or socks5:// — with user:password@ if the proxy needs a login. Empty = connect directly.'
              )
            )
          }
        >
          <Input
            mono
            className="max-w-md"
            data-testid="setting-proxy-url"
            placeholder="http://proxy.corp.local:3128"
            aria-invalid={urlInvalid}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
            }}
            onBlur={() => {
              if (!urlInvalid && url.trim() !== network.proxyUrl) save({ proxyUrl: url.trim() })
            }}
          />
        </Field>
      )}
      {network.proxyMode !== 'none' && (
        <Field
          label={t('Bypass the proxy for')}
          hint={t(
            'Comma-separated: host names, domain suffixes (.corp.local), IP addresses, CIDR ranges (10.0.0.0/8), host:port.'
          )}
        >
          <Input
            mono
            className="max-w-md"
            data-testid="setting-no-proxy"
            value={noProxy}
            onChange={(e) => {
              setNoProxy(e.target.value)
            }}
            onBlur={() => {
              if (noProxy.trim() !== network.noProxy) save({ noProxy: noProxy.trim() })
            }}
          />
        </Field>
      )}
      <SectionTitle>{t('Certificates')}</SectionTitle>
      <Checkbox
        label={t('Ignore certificate errors for updates')}
        description={t(
          'For company proxies that inspect TLS with their own certificate. Downloaded installers are still checked against the release signature. S3 accounts and Kubernetes contexts have their own “Skip certificate verification” option.'
        )}
        data-testid="setting-updates-insecure"
        checked={network.updatesInsecure}
        onChange={(e) => {
          save({ updatesInsecure: e.target.checked })
        }}
      />
    </div>
  )
}
