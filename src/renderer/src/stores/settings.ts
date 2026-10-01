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
    set({ settings: await window.shellhouse.updateSettings(patch), loaded: true })
  }
}))

// Thay đổi có thể tới (onSettingsChanged / update) trước kết quả getSettings lúc mở app — khi đó
// kết quả getSettings đã cũ, không được ghi đè.
void window.shellhouse.getSettings().then((settings) => {
  if (!useSettings.getState().loaded) useSettings.setState({ settings, loaded: true })
})
window.shellhouse.onSettingsChanged((settings) => {
  useSettings.setState({ settings, loaded: true })
})
