import { describe, expect, it } from 'vitest'
import { parseCsv, scanCsv } from '../../src/main/hosts/csv-import'

const scan = (text: string, existingLabels: string[] = []) =>
  scanCsv(text, { existingLabels, defaultUser: 'me' })

describe('parseCsv', () => {
  it('trường có dấu phẩy, dấu nháy kép, xuống dòng; CRLF; BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['line1\nline2', 'z']
    ])
  })
  it('tự nhận dấu chấm phẩy (Excel ở locale dùng dấu phẩy thập phân)', () => {
    expect(parseCsv('Label;Hostname\nweb;10.0.0.1')).toEqual([
      ['Label', 'Hostname'],
      ['web', '10.0.0.1']
    ])
  })
})

describe('scanCsv', () => {
  it('kiểu Termius: nhóm lồng nhau, tag, bỏ Telnet; KHÔNG đọc cột mật khẩu', () => {
    const csv = [
      'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password',
      'Prod/Web,web-1,"nginx,prod",10.0.0.5,ssh,2222,deploy,SECRET-1',
      ',router,,192.0.2.1,telnet,23,admin,SECRET-2',
      'Lab,box,,box.lab.local,,,,'
    ].join('\n')
    const { candidates, ignored, secretColumns } = scan(csv, ['BOX'])
    expect(ignored).toEqual({ TELNET: 1 })
    expect(secretColumns).toEqual(['Password'])
    expect(candidates).toEqual([
      {
        alias: 'Prod\\Web\\web-1',
        label: 'web-1',
        group: ['Prod', 'Web'],
        hostname: '10.0.0.5',
        port: 2222,
        username: 'deploy',
        keyFile: null,
        proxyJump: null,
        duplicate: false,
        problem: null,
        warning: null,
        tags: ['nginx', 'prod']
      },
      {
        alias: 'Lab\\box',
        label: 'box',
        group: ['Lab'],
        hostname: 'box.lab.local',
        port: 22,
        username: 'me',
        keyFile: null,
        proxyJump: null,
        duplicate: true,
        problem: null,
        warning: null
      }
    ])
    expect(JSON.stringify(candidates)).not.toContain('SECRET')
  })

  it('tên cột khác nhau vẫn nhận; không có cột host → lỗi rõ ràng', () => {
    const { candidates } = scan('name,address,user\ndb,db.example.com,postgres')
    expect(candidates[0]).toMatchObject({
      label: 'db',
      hostname: 'db.example.com',
      username: 'postgres'
    })
    expect(() => scan('name,user\nx,y')).toThrow(/No host column/)
  })

  it('giá trị nguy hiểm bị chặn; tên trùng không đè nhau', () => {
    const { candidates } = scan(
      'Label,Host,Port\nbad,-oProxyCommand=x,22\nweb,a.example.com,99999\nweb,b.example.com,22'
    )
    expect(candidates.map((c) => c.problem)).toEqual([
      'Invalid hostname: -oProxyCommand=x',
      'Invalid port: 99999',
      null
    ])
    expect(new Set(candidates.map((c) => c.alias)).size).toBe(3)
  })
})

it('quoted semicolons in a header do not change the CSV delimiter', () => {
  expect(
    scan('"unused;;;;",Hostname,Username\nx,web.example.com,deploy').candidates[0]?.hostname
  ).toBe('web.example.com')
})
it('rejects unterminated CSV quotes instead of silently merging hosts', () => {
  expect(() => scan('Hostname,Username\n"web.example.com,deploy\nother.example.com,root')).toThrow(
    'unterminated'
  )
})
it('candidate aliases remain unique even if a label matches a generated suffix', () => {
  const rows = ['Label,Hostname', 'web,a', 'web (row 4, 2),b', 'web,c', 'web (row 4, 2),d']
  const candidates = scan(rows.join('\n')).candidates
  expect(new Set(candidates.map((c) => c.alias)).size).toBe(candidates.length)
})

it('a shared-account export asks for a user instead of guessing the local user', () => {
  expect(scan('Hostname,Username,Account\nweb.example.com,,ops').candidates[0]).toMatchObject({
    username: null,
    problem: null
  })
})
