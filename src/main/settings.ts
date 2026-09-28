import { applyPatch, parseSettings, type AppSettings, type SettingsPatch } from '@shared/settings'
import type { Db } from './store/db'

const KEY = 'app'

export class SettingsService {
  private cache: AppSettings
  private readonly listeners = new Set<(s: AppSettings) => void>()

  constructor(private readonly db: Db) {
    this.cache = this.read()
  }

  get(): AppSettings {
    return this.cache
  }

  update(patch: SettingsPatch): AppSettings {
    const next = applyPatch(this.cache, patch)
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(KEY, JSON.stringify(next))
    this.cache = next
    for (const l of this.listeners) l(next)
    return next
  }

  onChange(listener: (s: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private read(): AppSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as
      { value: string } | undefined
    if (!row) return parseSettings({})
    try {
      return parseSettings(JSON.parse(row.value))
    } catch {
      return parseSettings({})
    }
  }
}
