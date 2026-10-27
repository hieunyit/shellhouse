import { t } from '@shared/i18n'
import {
  mapKnown,
  selectorMatches,
  type MapData,
  type MapRoute,
  type MapRouteRule,
  type MapService
} from './map'

export interface DiagnosticRef {
  kind: string
  ns: string
  name: string
}
export interface DiagnosticStep {
  title: string
  status: 'ok' | 'bad' | 'warn' | 'unknown'
  detail: string
  refs: DiagnosticRef[]
}
export type DiagnosticTarget =
  | { kind: 'url'; url: string }
  | { kind: 'service'; ns: string; name: string }
  | { kind: 'ingress'; ns: string; name: string }

/** Ingress wildcard matches exactly one DNS label. */
export function ingressHostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase().replace(/\.$/, '')
  const h = host.toLowerCase().replace(/\.$/, '')
  return (
    !p ||
    (p.startsWith('*.')
      ? h.endsWith(p.slice(1)) && h.split('.').length === p.split('.').length
      : p === h)
  )
}

function pathMatches(rule: MapRouteRule, path: string): boolean {
  if (rule.pathType === 'Exact') return path === rule.path
  const prefix = rule.path.replace(/\/$/, '')
  return !prefix || path === prefix || path.startsWith(`${prefix}/`)
}

/** Configuration diagnosis only: never equate a matching spec with a successful network request. */
export function diagnoseMap(
  data: MapData,
  target: DiagnosticTarget,
  now = Date.now()
): DiagnosticStep[] {
  const steps: DiagnosticStep[] = []
  const add = (
    title: string,
    status: DiagnosticStep['status'],
    detail: string,
    refs: DiagnosticRef[] = []
  ): void => {
    steps.push({ title, status, detail, refs })
  }
  const svcRef = (svc: MapService): DiagnosticRef => ({
    kind: 'services',
    ns: svc.ns,
    name: svc.name
  })
  const service = (ns: string, name: string, requestedPort?: string): void => {
    const svc = data.services.find((s) => s.ns === ns && s.name === name)
    if (!svc) {
      add(
        'Service',
        mapKnown(data, 'services', ns) ? 'bad' : 'unknown',
        mapKnown(data, 'services', ns)
          ? t('Service {name} was not found in {ns}.', { name, ns })
          : t('Service data is incomplete in {ns}.', { ns })
      )
      return
    }
    const refs = [svcRef(svc)]
    add('Service', 'ok', `${ns}/${name} · ${svc.type}`, refs)
    if (svc.type === 'ExternalName') {
      add(
        t('DNS'),
        'unknown',
        t('ExternalName points to {host}; DNS resolution and connectivity have not been tested.', {
          host: svc.externalName ?? ''
        }),
        refs
      )
      return
    }
    const ports = (svc.portList ?? []).filter(
      (p) => !requestedPort || p.name === requestedPort || String(p.port) === requestedPort
    )
    add(
      t('Service port'),
      ports.length ? 'ok' : svc.portList === undefined ? 'unknown' : 'bad',
      ports.length
        ? ports
            .map(
              (p) =>
                `${p.name ?? p.port}: ${String(p.port)} → ${p.targetPort}/${p.protocol ?? 'TCP'}`
            )
            .join(', ')
        : t('The requested Service port is not present: {port}', { port: requestedPort ?? '—' }),
      refs
    )
    const selector = Object.entries(svc.selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    const pods = selector
      ? data.pods.filter((p) => p.ns === ns && selectorMatches(svc.selector, p.labels ?? {}))
      : []
    const podsKnown =
      mapKnown(data, 'pods', ns) &&
      data.pods.filter((p) => p.ns === ns).every((p) => p.labels !== undefined)
    if (!selector)
      add(
        t('Pod selector'),
        'unknown',
        t('This Service has no selector; EndpointSlices are managed separately.'),
        refs
      )
    else
      add(
        t('Pod selector'),
        podsKnown ? (pods.length ? 'ok' : 'bad') : 'unknown',
        `${selector} · ${t('{n} matching pods', { n: pods.length })}${podsKnown ? '' : ` · ${t('Pod data is incomplete')}`}`,
        refs
      )
    const podRefs = pods.slice(0, 30).map((p) => ({ kind: 'pods', ns, name: p.name }))
    const ready = pods.filter((p) => p.ready === true && !p.terminating)
    if (pods.length)
      add(
        t('Pod readiness'),
        podsKnown && pods.every((p) => p.ready !== undefined)
          ? ready.length
            ? ready.length === pods.length
              ? 'ok'
              : 'warn'
            : 'bad'
          : 'unknown',
        t('{ready}/{total} selected pods are ready and not terminating.', {
          ready: ready.length,
          total: pods.length
        }),
        podRefs
      )
    if (svc.endpoints)
      add(
        'EndpointSlice',
        svc.endpoints.ready ? 'ok' : 'bad',
        t('{ready} ready endpoints, {notReady} not ready.', svc.endpoints),
        svc.endpointSlices?.length
          ? svc.endpointSlices
              .slice(0, 30)
              .map((name) => ({ kind: 'endpointslices.discovery.k8s.io', ns, name }))
          : refs
      )
    else
      add(
        'EndpointSlice',
        'unknown',
        t('EndpointSlice data could not be read completely; endpoint health is unknown.'),
        refs
      )
    for (const port of ports) {
      const named = !/^\d+$/.test(port.targetPort)
      const unresolved = pods.filter(
        (p) =>
          !(p.ports ?? []).some(
            (cp) =>
              (named ? cp.name === port.targetPort : cp.port === Number(port.targetPort)) &&
              (cp.protocol ?? 'TCP') === (port.protocol ?? 'TCP')
          )
      )
      const known = pods.length > 0 && pods.every((p) => p.ports !== undefined)
      add(
        t('Target port'),
        !known ? 'unknown' : unresolved.length ? (named ? 'bad' : 'unknown') : 'ok',
        !known
          ? t('No complete Pod port declarations are available.')
          : unresolved.length
            ? named
              ? t('Named targetPort {port} is absent from Pods: {pods}', {
                  port: port.targetPort,
                  pods: unresolved.map((p) => p.name).join(', ')
                })
              : t(
                  'Numeric targetPort {port} is not declared on every selected Pod. A process may still listen on that port; a network test is required.',
                  { port: port.targetPort }
                )
            : t(
                'targetPort {port} matches the selected Pod declarations; listening sockets have not been tested.',
                { port: port.targetPort }
              ),
        podRefs
      )
    }
  }
  const route = (r: MapRoute, rules: MapRouteRule[], url?: URL): void => {
    const refs = [{ kind: r.kind, ns: r.ns, name: r.name }]
    add(
      'Ingress',
      'ok',
      `${r.ns}/${r.name} · ${r.className ?? t('No ingress class')} · ${(r.address ?? []).join(', ') || t('No published address')}`,
      refs
    )
    const classes = data.ingressClasses
    const cls = r.className
      ? classes?.find((c) => c.name === r.className)
      : classes?.find((c) => c.default)
    add(
      'IngressClass',
      cls ? 'ok' : !classes ? 'unknown' : r.className ? 'bad' : 'unknown',
      cls
        ? `${cls.name} · ${t('Controller availability has not been tested.')}`
        : t('IngressClass or controller could not be confirmed.'),
      refs
    )
    if (url?.protocol === 'https:' || r.tls?.length) {
      const tls = (r.tls ?? []).filter(
        (x) => !url || x.hosts.some((h) => ingressHostMatches(h, url.hostname))
      )
      if (!tls.length)
        add(
          'TLS',
          'unknown',
          t('No matching TLS entry; the controller may use a default certificate.'),
          refs
        )
      for (const entry of tls) {
        const key = `${r.ns}/${entry.secret}`
        const present = data.secrets?.includes(key)
        const expiry = data.tlsExpiry?.[key]
        const expires = expiry ? Date.parse(expiry) : NaN
        const missing =
          Boolean(entry.secret) &&
          data.secrets !== undefined &&
          !present &&
          mapKnown(data, 'secrets', r.ns)
        add(
          'TLS',
          missing || (Number.isFinite(expires) && expires <= now)
            ? 'bad'
            : Number.isFinite(expires)
              ? expires - now < 30 * 86400000
                ? 'warn'
                : 'ok'
              : 'unknown',
          missing
            ? t('TLS Secret {name} is missing.', { name: entry.secret })
            : `${entry.secret || t('Default certificate')} · ${expiry ? t('Expires {date}', { date: expiry }) : t('Certificate expiry is unknown')} · ${t('Certificate hostname, trust chain and handshake have not been tested.')}`,
          entry.secret ? [{ kind: 'secrets', ns: r.ns, name: entry.secret }] : refs
        )
      }
    }
    for (const rule of rules) {
      add(
        t('Route'),
        'ok',
        `${rule.default ? t('default backend') : `${rule.host || '*'}${rule.path}`} → ${rule.service}:${rule.port ?? '—'}`,
        refs
      )
      service(rule.namespace ?? r.ns, rule.service, rule.port)
    }
  }
  if (target.kind === 'service') service(target.ns, target.name)
  else if (target.kind === 'ingress') {
    const r = data.routes.find(
      (r) =>
        r.kind === 'ingresses.networking.k8s.io' && r.ns === target.ns && r.name === target.name
    )
    if (r) route(r, r.rules ?? [])
    else
      add(
        'Ingress',
        mapKnown(data, 'ingresses.networking.k8s.io', target.ns) ? 'bad' : 'unknown',
        t('Ingress could not be found in the current scope.')
      )
  } else {
    let url: URL
    try {
      url = new URL(target.url)
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('protocol')
    } catch {
      add(t('URL'), 'bad', t('Enter an absolute HTTP or HTTPS URL.'))
      return steps
    }
    // Match all Ingress classes; equal precedence across resources is controller dependent.
    const candidates = data.routes
      .filter((r) => r.kind === 'ingresses.networking.k8s.io')
      .flatMap((r) =>
        (r.rules ?? [])
          .filter(
            (rule) =>
              !rule.default &&
              ingressHostMatches(rule.host, url.hostname) &&
              pathMatches(rule, url.pathname)
          )
          .map((rule) => ({ r, rule }))
      )
    const hostRank = (rule: MapRouteRule): number =>
      !rule.host ? 0 : rule.host.startsWith('*.') ? 1 : 2
    candidates.sort(
      (a, b) =>
        hostRank(b.rule) - hostRank(a.rule) ||
        b.rule.path.length - a.rule.path.length ||
        Number(b.rule.pathType === 'Exact') - Number(a.rule.pathType === 'Exact')
    )
    const first = candidates[0]
    if (!first) {
      // A default backend is per controller, never select one arbitrarily across classes.
      const defaults = data.routes
        .filter((r) => r.kind === 'ingresses.networking.k8s.io')
        .flatMap((r) => (r.rules ?? []).filter((rule) => rule.default).map((rule) => ({ r, rule })))
      add(
        'Ingress',
        'unknown',
        t(
          'No matching Ingress rule in this scope. Check other namespaces, Gateway API routes and controller defaults.'
        )
      )
      for (const c of defaults) route(c.r, [c.rule], url)
    } else {
      const matches = candidates.filter(
        (c) =>
          hostRank(c.rule) === hostRank(first.rule) &&
          c.rule.path.length === first.rule.path.length &&
          (c.rule.pathType === 'Exact') === (first.rule.pathType === 'Exact')
      )
      if (matches.length > 1)
        add(
          t('Route selection'),
          'unknown',
          t(
            'Several rules match with equal precedence; controller and IngressClass determine the active route.'
          )
        )
      if (
        data.routes.some(
          (r) =>
            r.kind === 'ingresses.networking.k8s.io' &&
            (r.rules ?? []).some(
              (rule) =>
                !rule.default &&
                ingressHostMatches(rule.host, url.hostname) &&
                rule.pathType !== 'Exact' &&
                rule.pathType !== 'Prefix'
            )
        )
      )
        add(
          t('Path matching'),
          'unknown',
          t('ImplementationSpecific path matching depends on the ingress controller.')
        )
      for (const c of matches) {
        if (c.rule.pathType !== 'Prefix' && c.rule.pathType !== 'Exact')
          add(
            t('Path matching'),
            'unknown',
            t('ImplementationSpecific path matching depends on the ingress controller.')
          )
        route(c.r, [c.rule], url)
      }
    }
  }
  add(
    t('Network reachability'),
    'unknown',
    t(
      'This checks configuration and reported readiness. DNS, NetworkPolicy enforcement, ingress controller, TLS handshake and application responses require a real network test.'
    )
  )
  return steps
}
