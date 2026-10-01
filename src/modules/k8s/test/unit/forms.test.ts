import { describe, expect, it } from 'vitest'
import {
  emptyContainer,
  emptyWorkload,
  hpaManifest,
  ingressManifest,
  secretManifest,
  splitArgs,
  validateHpa,
  validateIngress,
  validateWorkload,
  workloadManifests,
  type SecretForm
} from '../../shared/forms'

describe('Form tạo tài nguyên → manifest', () => {
  it('Deployment + Service: nhãn chọn pod, container, env từ Secret, probe, volume, port', () => {
    const f = emptyWorkload('Deployment', 'shop')
    f.name = 'api'
    f.replicas = '3'
    f.expose = true
    f.service = {
      type: 'ClusterIP',
      ports: [{ name: '', port: '80', targetPort: '8080', nodePort: '', protocol: 'TCP' }]
    }
    f.volumes = [{ name: 'data', type: 'pvc', source: 'api-data' }]
    f.containers = [
      {
        ...emptyContainer('api'),
        image: 'ghcr.io/acme/api:1.2',
        command: `sh -c "echo hi && run"`,
        ports: [{ name: 'http', port: '8080', protocol: 'TCP' }],
        env: [
          { name: 'MODE', source: 'value', value: 'prod', ref: '', key: '' },
          { name: 'DB_PASS', source: 'secret', value: '', ref: 'db', key: 'password' }
        ],
        readiness: {
          type: 'http',
          path: '/healthz',
          port: 'http',
          command: '',
          initialDelay: '5',
          period: ''
        },
        mounts: [{ volume: 'data', path: '/data', readOnly: false, subPath: '' }]
      }
    ]
    expect(validateWorkload(f)).toEqual({})
    const [deploy, svc] = workloadManifests(f)
    expect(deploy).toMatchObject({
      kind: 'Deployment',
      metadata: { name: 'api', namespace: 'shop', labels: { app: 'api' } },
      spec: {
        replicas: 3,
        selector: { matchLabels: { app: 'api' } },
        template: {
          metadata: { labels: { app: 'api' } },
          spec: {
            containers: [
              {
                name: 'api',
                image: 'ghcr.io/acme/api:1.2',
                command: ['sh', '-c', 'echo hi && run'],
                ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
                env: [
                  { name: 'MODE', value: 'prod' },
                  { name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } }
                ],
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { memory: '256Mi' }
                },
                readinessProbe: {
                  httpGet: { path: '/healthz', port: 'http' },
                  initialDelaySeconds: 5
                },
                volumeMounts: [{ name: 'data', mountPath: '/data' }]
              }
            ],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'api-data' } }]
          }
        }
      }
    })
    expect(svc).toMatchObject({
      kind: 'Service',
      metadata: { name: 'api', namespace: 'shop' },
      spec: { type: 'ClusterIP', selector: { app: 'api' }, ports: [{ port: 80, targetPort: 8080 }] }
    })
  })

  it('kiểm tra: tên sai, thiếu image, cron sai, port ngoài khoảng, mount không có volume', () => {
    const f = emptyWorkload('CronJob', 'shop')
    f.name = 'Nightly_Backup'
    f.schedule = 'every day'
    f.containers[0] = {
      ...emptyContainer('job'),
      ports: [{ name: '', port: '70000', protocol: 'TCP' }],
      mounts: [{ volume: 'nope', path: 'data', readOnly: false, subPath: '' }],
      memoryLimit: '1 GB'
    }
    const e = validateWorkload(f)
    expect(Object.keys(e).sort()).toEqual(
      [
        'name',
        'schedule',
        'containers.0.image',
        'containers.0.ports.0.port',
        'containers.0.mounts.0.volume',
        'containers.0.mounts.0.path',
        'containers.0.memoryLimit'
      ].sort()
    )
  })

  it('CronJob → jobTemplate; Job không có Service dù bật expose', () => {
    const f = emptyWorkload('CronJob', 'ops')
    f.name = 'backup'
    f.schedule = '0 2 * * *'
    f.expose = true
    f.containers[0] = { ...emptyContainer('job'), image: 'busybox' }
    const docs = workloadManifests(f)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      spec: {
        schedule: '0 2 * * *',
        concurrencyPolicy: 'Forbid',
        jobTemplate: {
          spec: { backoffLimit: 6, template: { spec: { restartPolicy: 'OnFailure' } } }
        }
      }
    })
  })

  it('Ingress gom theo host, TLS, port theo số / tên', () => {
    const ing = ingressManifest({
      name: 'web',
      namespace: 'shop',
      labels: [],
      annotations: [],
      className: 'nginx',
      rules: [
        { host: 'shop.example.com', path: '/', pathType: 'Prefix', service: 'web', port: '80' },
        { host: 'shop.example.com', path: '/api', pathType: 'Prefix', service: 'api', port: 'http' }
      ],
      tls: [{ secret: 'shop-tls', hosts: 'shop.example.com' }]
    })
    expect(ing).toMatchObject({
      spec: {
        ingressClassName: 'nginx',
        tls: [{ secretName: 'shop-tls', hosts: ['shop.example.com'] }],
        rules: [
          {
            host: 'shop.example.com',
            http: {
              paths: [
                { path: '/', backend: { service: { name: 'web', port: { number: 80 } } } },
                { path: '/api', backend: { service: { name: 'api', port: { name: 'http' } } } }
              ]
            }
          }
        ]
      }
    })
    const errs = validateIngress({
      name: 'web',
      namespace: 'shop',
      labels: [],
      annotations: [],
      className: '',
      rules: [{ host: 'Bad Host', path: 'x', pathType: 'Prefix', service: '', port: '' }],
      tls: []
    })
    expect(Object.keys(errs).sort()).toEqual(
      ['rules.0.host', 'rules.0.path', 'rules.0.port', 'rules.0.service'].sort()
    )
  })

  it('Secret registry: .dockerconfigjson có auth base64(user:pass); HPA min ≤ max', () => {
    const f: SecretForm = {
      name: 'regcred',
      namespace: 'shop',
      labels: [],
      type: 'kubernetes.io/dockerconfigjson',
      data: [],
      tlsCert: '',
      tlsKey: '',
      registry: { server: 'ghcr.io', username: 'bob', password: 'pw', email: '' },
      basic: { username: '', password: '' }
    }
    const s = secretManifest(f) as { stringData: Record<string, string> }
    const cfg = JSON.parse(s.stringData['.dockerconfigjson'] ?? '{}') as {
      auths: Record<string, { auth: string }>
    }
    expect(cfg.auths['ghcr.io']?.auth).toBe(Buffer.from('bob:pw').toString('base64'))
    const hpa = {
      name: 'api',
      namespace: 'shop',
      targetKind: 'Deployment' as const,
      target: 'api',
      min: '3',
      max: '2',
      cpu: '70',
      memory: ''
    }
    expect(validateHpa(hpa)).toHaveProperty('max')
    expect(hpaManifest({ ...hpa, max: '6' })).toMatchObject({
      spec: {
        minReplicas: 3,
        maxReplicas: 6,
        metrics: [{ resource: { name: 'cpu', target: { averageUtilization: 70 } } }]
      }
    })
  })

  it('tách lệnh theo khoảng trắng, giữ chuỗi trong nháy', () => {
    expect(splitArgs(`python -m http.server '8000'`)).toEqual([
      'python',
      '-m',
      'http.server',
      '8000'
    ])
    expect(splitArgs(`sh -c "a \\"b\\" c"`)).toEqual(['sh', '-c', 'a "b" c'])
  })
})
