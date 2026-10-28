import { expect, it } from 'vitest'
import { scanShellhouseYaml } from '../../src/main/hosts/yaml-import'
const scan = (text: string) =>
  scanShellhouseYaml(text, { existingLabels: ['WEB'], defaultUser: 'localuser' })
it('does not guess a username for shared accounts; lets the user supply it during import', () => {
  const result = scan(
    'shellhouse: 1\nhosts:\n  - { label: web, hostname: web.example.com, account: ops }'
  )
  expect(result.candidates[0]).toMatchObject({
    username: null,
    problem: null,
    duplicate: true
  })
  expect(result.candidates[0]?.warning).toContain('ops')
})
it('rejects malformed structures and recursive YAML group aliases without stack overflow', () => {
  for (const body of [
    'shellhouse: 2',
    'shellhouse: 1\nhosts: [null]',
    'shellhouse: 1\ngroups: [null]',
    'shellhouse: 1\nhosts: {a: b}',
    'shellhouse: 1\ngroups: [&g {name: loop, groups: [*g]}]'
  ]) {
    expect(() => scan(body)).toThrow()
  }
})
it('marks invalid explicit and inherited ports instead of silently changing them to port 22', () => {
  const result = scan(
    'shellhouse: 1\ngroups:\n  - name: Prod\n    defaults: {port: invalid}\n    hosts:\n      - {hostname: inherited.example.com}\n      - {hostname: explicit.example.com, port: 22.5}'
  )
  expect(result.candidates.map((c) => c.problem)).toEqual([
    'The port must be between 1 and 65535',
    'The port must be between 1 and 65535'
  ])
})
it('missing user is editable; inherited connection settings are retained without recreating groups', () => {
  const result = scanShellhouseYaml(
    'shellhouse: 1\ngroups:\n  - name: Prod\n    defaults: {port: 2222}\n    hosts:\n      - {hostname: web.example.com}',
    { existingLabels: [], defaultUser: null }
  )
  expect(result.candidates[0]).toMatchObject({ username: null, port: 2222, problem: null })
})

it('shows exported jump-host references that need selecting explicitly when flattening groups', () => {
  const result = scan(
    'shellhouse: 1\ngroups:\n  - name: Prod\n    defaults: {jump: [bastion]}\n    hosts:\n      - {hostname: web.example.com}'
  )
  expect(result.candidates[0]?.warning).toContain('bastion')
  expect(result.candidates[0]?.problem).toBeNull()
})
