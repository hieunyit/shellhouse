import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENVIRONMENTS,
  environmentFromColor,
  environmentId,
  Environments,
  PRODUCTION_ID,
  suggestShort
} from '../../src/shared/environments'
import { applyPatch, DEFAULT_SETTINGS, parseSettings } from '../../src/shared/settings'
import { buildGroupTree } from '../../src/shared/group-tree'
import { effectiveHost, inheritedDefaults, type GroupWithDefaults } from '../../src/shared/inherit'

/** Môi trường (thiết kế v0.6): danh sách trong cài đặt, kế thừa theo nhóm, suy từ màu cũ. */
describe('environments', () => {
  it('mặc định: Production / Staging / Development / Test; Production nổi bật + vạch + gõ tên', () => {
    expect(DEFAULT_SETTINGS.environments.map((e) => e.id)).toEqual([
      'prod',
      'staging',
      'dev',
      'test'
    ])
    expect(DEFAULT_SETTINGS.environments[0]).toMatchObject({
      highlight: true,
      topLine: true,
      confirm: 'type'
    })
  })

  it('danh sách hỏng / trùng id → bỏ mục lỗi, luôn giữ Production', () => {
    const list = Environments.parse([
      { id: 'qa', name: 'QA', short: 'QA' },
      { id: 'qa', name: 'QA 2', short: 'QA2' },
      { id: 'BAD ID', name: 'x', short: 'x' },
      { id: 'lab', name: 'Lab', short: 'TOOLONG' }
    ])
    expect(list.map((e) => e.id)).toEqual([PRODUCTION_ID, 'qa'])
    expect(list[1]).toMatchObject({ confirm: 'confirm', highlight: false })
    expect(Environments.parse('garbage').length).toBe(DEFAULT_ENVIRONMENTS.length)
  })

  it('patch: thay cả danh sách; môi trường của nguồn gộp vào, null = bỏ', () => {
    let s = applyPatch(DEFAULT_SETTINGS, {
      sourceEnvironments: { 'k8s:prod-eks': 'prod', 's3:acc1': 'dev' }
    })
    s = applyPatch(s, { sourceEnvironments: { 's3:acc1': null } })
    expect(s.sourceEnvironments).toEqual({ 'k8s:prod-eks': 'prod' })
    const custom = applyPatch(s, {
      environments: [
        {
          id: 'prod',
          name: 'Live',
          short: 'Live',
          description: '',
          highlight: true,
          topLine: true,
          confirm: 'type',
          readOnly: true
        }
      ]
    })
    expect(custom.environments).toHaveLength(1)
    expect(parseSettings(JSON.parse(JSON.stringify(custom))).environments[0]?.name).toBe('Live')
  })

  it('màu cũ → môi trường; id và nhãn ngắn gợi ý từ tên', () => {
    expect(environmentFromColor('red')).toBe('prod')
    expect(environmentFromColor('yellow')).toBe('staging')
    expect(environmentFromColor('green')).toBeUndefined()
    expect(environmentId('QA Lab', new Set(['qa-lab']))).toBe('qa-lab-2')
    expect(environmentId('Phòng thử', new Set())).toBe('phong-thu')
    expect(suggestShort('Production')).toBe('Prod')
    expect(suggestShort('QA lab')).toBe('QL')
  })

  it('host kế thừa môi trường của nhóm gần nhất; nhóm con ghi đè; không có → suy từ màu', () => {
    const groups: GroupWithDefaults[] = [
      { id: 'p', parentId: null, name: 'Production', sort: 0, defaults: { environment: 'prod' } },
      { id: 'w', parentId: 'p', name: 'Web', sort: 0, defaults: {} },
      { id: 'c', parentId: 'p', name: 'Canary', sort: 0, defaults: { environment: 'staging' } },
      { id: 'old', parentId: null, name: 'Old', sort: 0, defaults: { color: 'red' } }
    ]
    const tree = buildGroupTree(groups)
    const own = {
      username: '',
      port: null,
      jumpHostIds: [],
      proxyJump: null,
      direct: false,
      color: null
    }
    expect(effectiveHost(own, inheritedDefaults(tree, 'w'))).toMatchObject({
      environment: 'prod',
      from: { environment: 'Production' }
    })
    expect(effectiveHost(own, inheritedDefaults(tree, 'c')).environment).toBe('staging')
    expect(effectiveHost(own, inheritedDefaults(tree, 'old')).environment).toBe('prod')
    expect(effectiveHost(own, inheritedDefaults(tree, null)).environment).toBeNull()
  })
})
