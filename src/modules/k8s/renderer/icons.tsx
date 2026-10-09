import {
  siApache,
  siApachecassandra,
  siApachekafka,
  siArgo,
  siCaddy,
  siCilium,
  siClickhouse,
  siCockroachlabs,
  siCouchbase,
  siDocker,
  siDotnet,
  siElasticsearch,
  siEnvoyproxy,
  siEtcd,
  siFlux,
  siFluentbit,
  siGitlab,
  siGo,
  siGrafana,
  siHarbor,
  siHelm,
  siInfluxdb,
  siIstio,
  siJaeger,
  siJenkins,
  siKeycloak,
  siKibana,
  siKong,
  siKubernetes,
  siLinkerd,
  siLonghorn,
  siMariadb,
  siMinio,
  siMongodb,
  siMysql,
  siNatsdotio,
  siNeo4j,
  siNextcloud,
  siNginx,
  siNodedotjs,
  siOpensearch,
  siOpentelemetry,
  siPhp,
  siPostgresql,
  siPrometheus,
  siPython,
  siRabbitmq,
  siRancher,
  siRedis,
  siRuby,
  siSonatype,
  siSpring,
  siThanos,
  siTraefikproxy,
  siVault,
  siVictoriametrics,
  siWordpress,
  type SimpleIcon
} from 'simple-icons'
import { cx } from '../../../renderer/src/components/ui'
import { TECH } from '../shared/map'
import { t } from '../../registry/renderer-kit'
import cm from './icons/k8s/cm.svg'
import cronjob from './icons/k8s/cronjob.svg'
import crb from './icons/k8s/crb.svg'
import cRole from './icons/k8s/c-role.svg'
import deploy from './icons/k8s/deploy.svg'
import ds from './icons/k8s/ds.svg'
import ep from './icons/k8s/ep.svg'
import hpa from './icons/k8s/hpa.svg'
import ing from './icons/k8s/ing.svg'
import job from './icons/k8s/job.svg'
import netpol from './icons/k8s/netpol.svg'
import node from './icons/k8s/node.svg'
import ns from './icons/k8s/ns.svg'
import pod from './icons/k8s/pod.svg'
import pv from './icons/k8s/pv.svg'
import pvc from './icons/k8s/pvc.svg'
import quota from './icons/k8s/quota.svg'
import rb from './icons/k8s/rb.svg'
import role from './icons/k8s/role.svg'
import rs from './icons/k8s/rs.svg'
import sa from './icons/k8s/sa.svg'
import sc from './icons/k8s/sc.svg'
import secret from './icons/k8s/secret.svg'
import sts from './icons/k8s/sts.svg'
import svc from './icons/k8s/svc.svg'

/**
 * Icon: biểu tượng chính thức của Kubernetes theo loại tài nguyên (Apache-2.0, xem
 * icons/k8s/NOTICE.md) và logo ứng dụng (simple-icons, CC0) theo công nghệ nhận ra.
 */

const KIND_ICON: Record<string, string> = {
  pods: pod,
  'deployments.apps': deploy,
  'statefulsets.apps': sts,
  'daemonsets.apps': ds,
  'replicasets.apps': rs,
  'jobs.batch': job,
  'cronjobs.batch': cronjob,
  services: svc,
  endpoints: ep,
  'ingresses.networking.k8s.io': ing,
  // Gateway API chưa có icon riêng trong bộ chính thức — dùng icon ingress.
  'gateways.gateway.networking.k8s.io': ing,
  'httproutes.gateway.networking.k8s.io': ing,
  'grpcroutes.gateway.networking.k8s.io': ing,
  configmaps: cm,
  secrets: secret,
  persistentvolumeclaims: pvc,
  persistentvolumes: pv,
  'storageclasses.storage.k8s.io': sc,
  nodes: node,
  namespaces: ns,
  serviceaccounts: sa,
  'roles.rbac.authorization.k8s.io': role,
  'clusterroles.rbac.authorization.k8s.io': cRole,
  'rolebindings.rbac.authorization.k8s.io': rb,
  'clusterrolebindings.rbac.authorization.k8s.io': crb,
  'horizontalpodautoscalers.autoscaling': hpa,
  'networkpolicies.networking.k8s.io': netpol,
  'poddisruptionbudgets.policy': quota,
  resourcequotas: quota
}

/** Icon Kubernetes theo id loại (pods, deployments.apps…); loại lạ → icon pod mờ. */
export function KindIcon({
  kind,
  size = 18,
  className
}: {
  kind: string
  size?: number
  className?: string
}): React.JSX.Element {
  const src = KIND_ICON[kind]
  return (
    <img
      src={src ?? pod}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={cx('shrink-0 select-none', !src && 'opacity-40 grayscale', className)}
    />
  )
}

/** Công nghệ (TECH) → logo; không có logo → huy hiệu chữ màu thương hiệu. */
const TECH_LOGO: Record<string, SimpleIcon> = {
  alertmanager: siPrometheus,
  'node-exporter': siPrometheus,
  'kube-state-metrics': siKubernetes,
  prometheus: siPrometheus,
  loki: siGrafana,
  promtail: siGrafana,
  tempo: siGrafana,
  grafana: siGrafana,
  jaeger: siJaeger,
  otel: siOpentelemetry,
  fluent: siFluentbit,
  elasticsearch: siElasticsearch,
  opensearch: siOpensearch,
  kibana: siKibana,
  argocd: siArgo,
  argo: siArgo,
  flux: siFlux,
  coredns: siKubernetes,
  'ingress-nginx': siNginx,
  traefik: siTraefikproxy,
  istio: siIstio,
  linkerd: siLinkerd,
  envoy: siEnvoyproxy,
  cilium: siCilium,
  'kube-proxy': siKubernetes,
  'metrics-server': siKubernetes,
  etcd: siEtcd,
  vault: siVault,
  longhorn: siLonghorn,
  minio: siMinio,
  rancher: siRancher,
  harbor: siHarbor,
  postgres: siPostgresql,
  mysql: siMysql,
  mariadb: siMariadb,
  mongodb: siMongodb,
  redis: siRedis,
  kafka: siApachekafka,
  zookeeper: siApache,
  rabbitmq: siRabbitmq,
  nats: siNatsdotio,
  keycloak: siKeycloak,
  jenkins: siJenkins,
  gitlab: siGitlab,
  victoriametrics: siVictoriametrics,
  thanos: siThanos,
  clickhouse: siClickhouse,
  cassandra: siApachecassandra,
  couchbase: siCouchbase,
  cockroachdb: siCockroachlabs,
  neo4j: siNeo4j,
  influxdb: siInfluxdb,
  kong: siKong,
  caddy: siCaddy,
  nexus: siSonatype,
  wordpress: siWordpress,
  nextcloud: siNextcloud,
  registry: siDocker,
  nginx: siNginx,
  httpd: siApache,
  nodejs: siNodedotjs,
  python: siPython,
  go: siGo,
  java: siSpring,
  php: siPhp,
  dotnet: siDotnet,
  ruby: siRuby
}

export const HELM_LOGO = siHelm

/** Màu chữ trắng / đen đọc được trên nền màu thương hiệu. */
function onColor(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1a1d21' : '#ffffff'
}

/** Logo công nghệ trong ô vuông bo góc màu thương hiệu. */
export function TechIcon({
  tech,
  size = 20,
  className
}: {
  tech: string
  size?: number
  className?: string
}): React.JSX.Element | null {
  const info = TECH[tech]
  if (!info) return null
  const logo = TECH_LOGO[tech]
  const bg = logo ? `#${logo.hex}` : info.color
  const fg = onColor(bg)
  return (
    <span
      title={info.label}
      data-tech={tech}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-md', className)}
      style={{ width: size, height: size, background: bg }}
    >
      {logo ? (
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden>
          <path d={logo.path} fill={fg} />
        </svg>
      ) : (
        <span className="font-bold" style={{ color: fg, fontSize: size * 0.42 }}>
          {info.short}
        </span>
      )}
    </span>
  )
}

/** Logo Helm nhỏ (workload cài bằng Helm). */
export function HelmBadge({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-label="Helm" role="img">
      <title>{t('Installed with Helm')}</title>
      <path d={HELM_LOGO.path} fill={`#${HELM_LOGO.hex}`} />
    </svg>
  )
}
