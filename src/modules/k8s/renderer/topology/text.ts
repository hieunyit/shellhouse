import { t } from '../../../registry/renderer-kit'
import type { TopoLane } from '../../shared/appTopology'
import { formatRate } from '../../shared/traffic'

/** Tốc độ traffic theo locale; dưới 1 B/s ghi "idle". */
export const trafficText = formatRate

/** Tên làn (dịch lúc render). */
export function laneTitle(lane: TopoLane): string {
  switch (lane) {
    case 'entry':
      return t('Entry')
    case 'route':
      return t('Routes')
    case 'service':
      return t('Services')
    case 'workload':
      return t('Workloads')
    case 'pods':
      return t('Pods')
    case 'deps':
      return t('Config & storage')
    case 'egress':
      return t('Outbound')
  }
}

/** Giải thích một làn (chú thích khi rê chuột lên tiêu đề). */
export function laneHint(lane: TopoLane): string {
  switch (lane) {
    case 'entry':
      return t(
        'Where traffic enters the cluster: Gateways (their routes nested below), Ingresses, LoadBalancer and NodePort Services'
      )
    case 'route':
      return t('Gateway API routes (HTTPRoute, GRPCRoute)')
    case 'service':
      return t('Services: port → targetPort and how many endpoints are ready')
    case 'workload':
      return t('Deployments, StatefulSets, DaemonSets, Jobs and CronJobs')
    case 'pods':
      return t('Pods of each workload — failing ones first')
    case 'deps':
      return t('ConfigMaps, Secrets and volumes the pods need to start')
    case 'egress':
      return t(
        'Where the workloads are configured to connect (hosts and ports found in env, args, ConfigMaps and Secrets) — declared, not observed traffic'
      )
  }
}
