import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../../../main/store/db'
import { createModuleDb } from '../../../registry/main-db'
import { S3TaskHistory } from '../../main/task-history'
import { S3FinishedTask, MAX_S3_TASK_HISTORY, type S3TaskRecord } from '../../shared/task-history'
import m0001 from '../../migrations/0001_accounts.sql?raw'
import m0002 from '../../migrations/0002_pins.sql?raw'
import m0003 from '../../migrations/0003_network.sql?raw'
import m0004 from '../../migrations/0004_ca_certificate.sql?raw'
import m0005 from '../../migrations/0005_task_history.sql?raw'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
const record = (id: string, overrides: Partial<S3TaskRecord> = {}): S3TaskRecord => ({
  id,
  accountId: 'account',
  accountName: 'MinIO',
  kind: 'move',
  label: 'Move 5,000 items',
  source: 's3://source/data/',
  destination: 's3://destination/data/',
  state: 'done',
  completed: 5000,
  total: 5000,
  failed: 0,
  error: null,
  startedAt: 100,
  finishedAt: 200,
  ...overrides
})
function history(db: Db = openDatabase(':memory:')) {
  db.exec(m0005)
  cleanups.push(() => {
    db.close()
  })
  return { db, history: new S3TaskHistory(createModuleDb('s3', db)) }
}

describe('S3 task history', () => {
  it('upgrades a persisted v4 account database and keeps terminal tasks across database reopens', () => {
    const directory = mkdtempSync(join(tmpdir(), 's3-history-'))
    const path = join(directory, 'vault.db')
    cleanups.push(() => {
      rmSync(directory, { recursive: true, force: true })
    })
    let db = openDatabase(path)
    db.exec(m0001 + m0002 + m0003 + m0004)
    db.prepare(
      'INSERT INTO s3_accounts (id, name, access_key_id, secret_enc, updated_at, ca_pem) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('account', 'MinIO', 'key', Buffer.from('encrypted key'), 100, 'existing CA')
    const before = db.prepare('SELECT * FROM s3_accounts').get()
    db.close()
    db = openDatabase(path)
    db.exec(m0005)
    let tasks = new S3TaskHistory(createModuleDb('s3', db))
    tasks.save(record('done'))
    tasks.save(
      record('failed', {
        state: 'error',
        completed: 4000,
        failed: 1000,
        error: 'Access denied',
        finishedAt: 300
      })
    )
    tasks.save(record('stopped', { state: 'cancelled', completed: 2000, finishedAt: 400 }))
    expect(db.prepare('SELECT * FROM s3_accounts').get()).toEqual(before)
    db.close()
    db = openDatabase(path)
    cleanups.push(() => {
      db.close()
    })
    tasks = new S3TaskHistory(createModuleDb('s3', db))
    expect(tasks.list().map((r) => r.id)).toEqual(['stopped', 'failed', 'done'])
    expect(tasks.list()[1]).toMatchObject({ completed: 4000, failed: 1000, error: 'Access denied' })
    tasks.remove(['done'])
    expect(tasks.list().map((r) => r.id)).toEqual(['stopped', 'failed'])
  })

  it('bounds retention, updates an existing record and rejects active task persistence', () => {
    const { history: tasks } = history()
    for (let i = 0; i <= MAX_S3_TASK_HISTORY; i++)
      tasks.save(record(String(i), { finishedAt: 200 + i }))
    expect(tasks.list()).toHaveLength(MAX_S3_TASK_HISTORY)
    expect(tasks.list().some((r) => r.id === '0')).toBe(false)
    tasks.save(record('1000', { finishedAt: 5000, completed: 4999, failed: 1, state: 'error' }))
    expect(tasks.list()[0]).toMatchObject({ id: '1000', completed: 4999, state: 'error' })
    expect(tasks.list()).toHaveLength(MAX_S3_TASK_HISTORY)
    expect(
      S3FinishedTask.safeParse(record('running', { state: 'running', finishedAt: null })).success
    ).toBe(false)
    expect(() => {
      tasks.save(record('running', { state: 'running', finishedAt: null }))
    }).toThrow()
    tasks.remove(tasks.list().map((r) => r.id))
    expect(tasks.list()).toEqual([])
  })
})
