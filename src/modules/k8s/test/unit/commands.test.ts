import { describe, expect, it } from 'vitest'
import { contextFlags, listCommands, logsCommands, resourceCommands } from '../../shared/commands'

/** "Copy as command": lệnh kubectl đúng context / namespace / kubeconfig. */
describe('k8s: copy as command', () => {
  const ref = { source: 'file:/home/u/.kube/config', context: 'prod-cluster' }

  it('context mặc định chỉ cần --context; file khác thêm --kubeconfig (có trích dẫn)', () => {
    expect(contextFlags(ref)).toBe('--context prod-cluster')
    expect(contextFlags({ source: 'file:/tmp/my kube/cfg', context: 'a' })).toBe(
      "--context a --kubeconfig '/tmp/my kube/cfg'"
    )
  })

  it('pod: get / describe / logs / previous / exec / delete', () => {
    const lines = resourceCommands({
      ref,
      kindId: 'pods',
      name: 'web-1',
      namespace: 'shop',
      containers: ['app', 'istio-proxy']
    })
    const byId = Object.fromEntries(lines.map((l) => [l.id, l.command]))
    expect(byId['get']).toBe('kubectl get pod web-1 -n shop --context prod-cluster -o yaml')
    expect(byId['logs']).toBe('kubectl logs web-1 -c app -n shop --context prod-cluster -f')
    expect(byId['logs-previous']).toContain('--previous')
    expect(byId['exec']).toBe('kubectl exec -it web-1 -c app -n shop --context prod-cluster -- sh')
    expect(byId['delete']).toBe('kubectl delete pod web-1 -n shop --context prod-cluster')
  })

  it('deployment: rollout, scale theo số replica hiện tại; node: cordon / drain không có -n', () => {
    const deploy = resourceCommands({
      ref,
      kindId: 'deployments.apps',
      name: 'web',
      namespace: 'shop',
      replicas: 3
    }).map((l) => l.command)
    expect(deploy).toContain(
      'kubectl rollout restart deployment/web -n shop --context prod-cluster'
    )
    expect(deploy).toContain(
      'kubectl scale deployment/web -n shop --context prod-cluster --replicas=3'
    )
    const node = resourceCommands({ ref, kindId: 'nodes', name: 'node-1' }).map((l) => l.command)
    expect(node).toContain('kubectl cordon node-1 --context prod-cluster')
    expect(node[0]).toBe('kubectl get node node-1 --context prod-cluster -o yaml')
  })

  it('danh sách: mỗi namespace một lệnh, selector giữ nguyên, Failing → grep', () => {
    expect(
      listCommands({ ref, kindId: 'pods', namespaces: ['shop', 'payments'], selector: 'app=web' })
    ).toEqual([
      'kubectl get pod -l app=web -n shop --context prod-cluster',
      'kubectl get pod -l app=web -n payments --context prod-cluster'
    ])
    expect(listCommands({ ref, kindId: 'pods', namespaces: null, failing: true })).toEqual([
      "kubectl get pod -A --context prod-cluster | grep -vE 'Running|Completed'"
    ])
  })

  it('log nhiều pod: selector một lệnh; pod rời mỗi pod một lệnh', () => {
    expect(
      logsCommands({ ref, namespace: 'shop', selector: 'app=web', since: '15m', follow: true })
    ).toEqual([
      'kubectl logs -l app=web --all-containers --prefix --since=15m -f -n shop --context prod-cluster'
    ])
    expect(logsCommands({ ref, namespace: 'shop', pods: ['a', 'b'], previous: true })).toHaveLength(
      2
    )
  })
})
