import { create } from 'zustand'
import { resolveTheme } from '@shared/themes'
import { useSettings } from './settings'

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

interface AppearanceStore {
  /** Giao diện app đang tối? (sau khi xét System / Light / Dark). */
  dark: boolean
}

export const useAppearance = create<AppearanceStore>(() => ({ dark: systemDark.matches }))

function apply(): void {
  const { settings } = useSettings.getState()
  const mode = settings.appearance.theme
  const dark = mode === 'dark' || (mode === 'system' && systemDark.matches)
  const root = document.documentElement
  root.dataset['theme'] = dark ? 'dark' : 'light'
  // Nền quanh terminal = nền của theme terminal đang dùng, để khung và terminal liền mạch.
  const terminal = resolveTheme(settings.terminal, settings.customThemes, dark)
  root.style.setProperty('--sh-terminal', terminal.colors.background)
  if (useAppearance.getState().dark !== dark) useAppearance.setState({ dark })
}

apply()
useSettings.subscribe(apply)
systemDark.addEventListener('change', apply)
