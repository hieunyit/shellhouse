import { t } from '../../registry/renderer-kit'
import type { TrafficState } from './useTraffic'

export function TrafficQualityNote({
  traffic
}: {
  traffic: TrafficState
}): React.JSX.Element | null {
  if (!traffic.quality?.partial && traffic.unit !== 'observations' && traffic.unit !== 'syns')
    return null
  return (
    <p className="border-b border-line px-3 py-1.5 text-xs text-warning" role="status">
      {traffic.unit === 'observations' &&
        t(
          'Hubble counts TCP SYN and UDP observations, not successful connections or bytes. A packet can appear at multiple observation points.'
        )}
      {traffic.unit === 'syns' &&
        t(
          'Prometheus Hubble history counts TCP SYN flags only; it is not equivalent to live TCP/UDP observations or successful connections.'
        )}
      {traffic.quality?.partial && (
        <>
          {' '}
          {t(
            'Partial traffic data: absence of an observation does not prove absence of traffic.'
          )}{' '}
          {traffic.quality.reasons.map((r) => t(r)).join(' · ')}
          {traffic.quality.lostEvents
            ? ` · ${t('{n} lost events', { n: traffic.quality.lostEvents })}`
            : ''}
          {traffic.quality.expectedAgents !== undefined
            ? ` · ${String(traffic.agents)}/${String(traffic.quality.expectedAgents)} ${t('agents')}`
            : ''}
        </>
      )}
    </p>
  )
}
