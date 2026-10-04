import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip'

/**
 * Gốc của design system: nơi các lớp nổi (menu, popover, tooltip, dialog) được portal tới, mật độ
 * hiện hành, và TooltipProvider dùng chung (di chuột từ tooltip này sang tooltip kế bên không phải
 * chờ lại 450 ms).
 *
 * Portal mặc định vào <body> (theo theme của <html>). Design kit đặt mỗi cột sáng / tối một
 * DsProvider với `portal` riêng nằm trong cột → menu mở từ cột sáng cũng sáng.
 */

export type Density = 'comfortable' | 'compact'

interface DsContext {
  portal: HTMLElement | null
  density: Density
  hasTooltipProvider: boolean
}

const Context = createContext<DsContext>({
  portal: null,
  density: 'comfortable',
  hasTooltipProvider: false
})

export function DsProvider({
  children,
  portal = null,
  density
}: {
  children: ReactNode
  /** Phần tử chứa lớp nổi (null = <body>). */
  portal?: HTMLElement | null
  /** Không truyền = theo data-ds-density của <html> (Settings → Appearance). */
  density?: Density
}): React.JSX.Element {
  const rootDensity = useRootDensity()
  return (
    <Context.Provider value={{ portal, density: density ?? rootDensity, hasTooltipProvider: true }}>
      <TooltipProvider delayDuration={450} skipDelayDuration={300}>
        {children}
      </TooltipProvider>
    </Context.Provider>
  )
}

export function useDs(): DsContext {
  return useContext(Context)
}

/** Nơi portal lớp nổi; undefined = mặc định của Radix (<body>). */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(Context).portal ?? undefined
}

export function useDensity(): Density {
  return useContext(Context).density
}

function readRootDensity(): Density {
  return document.documentElement.dataset['dsDensity'] === 'compact' ? 'compact' : 'comfortable'
}

function useRootDensity(): Density {
  const [density, setDensity] = useState(readRootDensity)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDensity(readRootDensity())
    })
    observer.observe(document.documentElement, { attributeFilter: ['data-ds-density'] })
    return () => {
      observer.disconnect()
    }
  }, [])
  return density
}
