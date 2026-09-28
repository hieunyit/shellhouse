import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '@shared/settings'

interface SettingsStore {
  settings: AppSettings
  loaded: boolean
  update: (patch: SettingsPatch) => Promise<void>
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  update: async (patch) => {
    set({ settings: await window.shellhouse.updateSettings(patch) })
  }
}))

void window.shellhouse.getSettings().then((settings) => {
  useSettings.setState({ settings, loaded: true })
})
window.shellhouse.onSettingsChanged((settings) => {
  useSettings.setState({ settings })
})
