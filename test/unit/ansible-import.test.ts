import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandRange, scanAnsibleInventory } from '../../src/main/hosts/ansible-import'

const scan = (text: string, existingLabels: string[] = []) =>
  scanAnsibleInventory(text, { existingLabels, defaultUser: 'me' })

const INI = `
# Inventory production
bastion.example.com ansible_user=jump

[web]
web[01:03].example.com
web-canary.example.com ansible_host=10.0.0.9 ansible_port=2222

[db]
db1 ansible_host=10.0.1.10 ansible_user=postgres ansible_password=s3cret
win1 ansible_connection=winrm

[web:vars]
ansible_user=deploy
ansible_ssh_private_key_file=~/.ssh/nope_ansible_test

[prod:children]
web
db

[prod:vars]
ansible_user=ubuntu
ansible_ssh_common_args='-o ProxyJump=jump@bastion.example.com'

[all:vars]
ansible_port=22
ansible_become_pass=x
`

describe('Ansible inventory', () => {
  it('dải tên: số có số 0 đầu, chữ cái, bước', () => {
    expect(expandRange('web[01:03].x')).toEqual(['web01.x', 'web02.x', 'web03.x'])
    expect(expandRange('db-[a:c]')).toEqual(['db-a', 'db-b', 'db-c'])
    expect(expandRange('n[1:9:4]')).toEqual(['n1', 'n5', 'n9'])
    expect(expandRange('plain')).toEqual(['plain'])
  })

  it('INI: nhóm lồng theo children, biến theo ưu tiên host > nhóm con > cha > all, ProxyJump, bỏ WinRM và bí mật', () => {
    const r = scan(INI, ['db1'])
    const by = new Map(r.candidates.map((c) => [c.label, c]))
    expect([...by.keys()]).toEqual([
      'bastion.example.com',
      'web01.example.com',
      'web02.example.com',
      'web03.example.com',
      'web-canary.example.com',
      'db1'
    ])
    expect(by.get('bastion.example.com')).toMatchObject({
      group: [],
      hostname: 'bastion.example.com',
      username: 'jump',
      port: 22,
      proxyJump: null
    })
    // Nhóm web nằm trong prod; ansible_user của web (con) thắng prod (cha).
    expect(by.get('web02.example.com')).toMatchObject({
      alias: 'prod\\web\\web02.example.com',
      group: ['prod', 'web'],
      username: 'deploy',
      proxyJump: 'jump@bastion.example.com',
      // Key không có trên máy này: vẫn nhập được (chọn key lúc nhập) — chỉ cảnh báo.
      keyFile: null,
      problem: null
    })
    expect(by.get('web02.example.com')?.warning).toContain(
      join(homedir(), '.ssh/nope_ansible_test')
    )
    // Biến của host thắng mọi nhóm.
    expect(by.get('web-canary.example.com')).toMatchObject({ hostname: '10.0.0.9', port: 2222 })
    expect(by.get('db1')).toMatchObject({
      group: ['prod', 'db'],
      hostname: '10.0.1.10',
      username: 'postgres',
      duplicate: true,
      problem: null
    })
    expect(r.ignored).toEqual({ WinRM: 1 })
    expect(r.secretColumns).toEqual(['ansible_become_pass', 'ansible_password'])
  })

  it('YAML: all → children lồng nhau, vars, host thuộc nhiều nhóm → nhóm sâu nhất + tag, vault không đọc', () => {
    const yaml = `
all:
  vars:
    ansible_user: admin
  children:
    k8s:
      children:
        masters:
          hosts:
            m1: { ansible_host: 192.168.1.11 }
        workers:
          hosts:
            w[1:2]:
          vars:
            ansible_port: 2200
    monitoring:
      hosts:
        m1:
      vars:
        ansible_become_password: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          6162
`
    const r = scan(yaml)
    const by = new Map(r.candidates.map((c) => [c.label, c]))
    expect(by.get('m1')).toMatchObject({
      group: ['k8s', 'masters'],
      hostname: '192.168.1.11',
      username: 'admin',
      tags: ['monitoring']
    })
    expect(by.get('w1')).toMatchObject({ group: ['k8s', 'workers'], port: 2200, hostname: 'w1' })
    expect(by.get('w2')?.port).toBe(2200)
    expect(r.secretColumns).toEqual(['ansible_become_password'])
  })

  it('biến dùng template Jinja → báo, không nhập sai; file không có host → lỗi rõ ràng', () => {
    const r = scan("[app]\napp1 ansible_host=\"{{ lookup('env', 'IP') }}\"\n")
    expect(r.candidates[0]?.problem).toContain('Ansible template')
    expect(() => scan('# empty\n[web:vars]\nansible_user=x\n')).toThrow('No hosts found')
  })

  it('không có ansible_user và không có user mặc định → user để trống (điền lúc nhập), không phải lỗi', () => {
    const r = scanAnsibleInventory('[db]\ndb1 ansible_host=10.0.0.5\n', {
      existingLabels: [],
      defaultUser: null
    })
    expect(r.candidates[0]).toMatchObject({ hostname: '10.0.0.5', username: null, problem: null })
  })
})
