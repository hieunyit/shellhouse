import { useEffect } from 'react'
import { useShell } from './store'

/**
 * Tab module báo môi trường của nguồn đang xem (cluster, Docker endpoint, tài khoản S3) cho khung
 * app: vạch trên cùng của vùng chính theo quy tắc "Top line" của môi trường.
 */
export function useReportEnvironment(tabId: string, env: string | null | undefined): void {
  const value = env ?? null
  useEffect(() => {
    useShell.getState().reportEnvironment(tabId, value)
  }, [tabId, value])
  useEffect(
    () => () => {
      useShell.setState((s) => ({
        envByTab: Object.fromEntries(Object.entries(s.envByTab).filter(([id]) => id !== tabId))
      }))
    },
    [tabId]
  )
}
