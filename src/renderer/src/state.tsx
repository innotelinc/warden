import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppState } from '@shared/types'

export type ToastKind = 'ok' | 'err' | 'info'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
}

interface WardenContextValue {
  state: AppState | null
  toasts: Toast[]
  notify: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

const WardenContext = createContext<WardenContextValue | null>(null)

let toastId = 0

export function WardenProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    let alive = true
    const unsubscribe = window.warden.onState((next) => {
      if (alive) setState(next)
    })
    window.warden
      .bootstrap()
      .then((initial) => {
        if (alive) setState(initial)
      })
      .catch((error: Error) => {
        if (alive) setState(null)
        console.error('bootstrap failed', error)
      })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++toastId
      setToasts((current) => [...current.slice(-3), { id, message, kind }])
      setTimeout(() => dismiss(id), kind === 'err' ? 7000 : 4200)
    },
    [dismiss]
  )

  return (
    <WardenContext.Provider value={{ state, toasts, notify, dismiss }}>
      {children}
    </WardenContext.Provider>
  )
}

export function useWarden(): WardenContextValue {
  const context = useContext(WardenContext)
  if (!context) throw new Error('useWarden must be used inside WardenProvider')
  return context
}

/**
 * Measure an element and keep its viewport rect up to date.
 *
 * The element is tracked in state via a callback ref rather than read from a
 * ref inside a mount-only effect. Native surfaces are positioned from this
 * rect, and the shell renders a boot screen until state arrives, so the measured
 * element can be absent on the first render and appear afterwards; a mount-only
 * effect would capture null and never measure again, leaving the tab view 0x0.
 */
export function useElementRect<T extends HTMLElement>(): [
  (element: T | null) => void,
  { x: number; y: number; width: number; height: number } | null
] {
  const [element, setElement] = useState<T | null>(null)
  const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null)

  useEffect(() => {
    if (!element) {
      setRect(null)
      return
    }
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      setRect((current) => {
        if (
          current &&
          Math.abs(current.x - box.left) < 0.5 &&
          Math.abs(current.y - box.top) < 0.5 &&
          Math.abs(current.width - box.width) < 0.5 &&
          Math.abs(current.height - box.height) < 0.5
        ) {
          return current
        }
        return { x: box.left, y: box.top, width: box.width, height: box.height }
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [element])

  const ref = useCallback((node: T | null) => setElement(node), [])
  return [ref, rect]
}

/** Animate a number toward its target; used to keep native view bounds in step with CSS. */
export function useAnimatedNumber(target: number, duration = 220): number {
  const [value, setValue] = useState(target)
  const valueRef = useRef(target)
  const frame = useRef(0)
  const first = useRef(true)

  valueRef.current = value

  useEffect(() => {
    if (first.current) {
      first.current = false
      setValue(target)
      return
    }
    const from = valueRef.current
    if (Math.abs(from - target) < 0.5) {
      setValue(target)
      return
    }
    const start = performance.now()
    cancelAnimationFrame(frame.current)
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(from + (target - from) * eased)
      if (progress < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [target, duration])

  return value
}

export function useHost(url: string | undefined): string {
  return useMemo(() => {
    if (!url) return ''
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      if (url.startsWith('warden://')) return 'warden'
      return url
    }
  }, [url])
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

export function timeAgo(iso: string | number): string {
  const stamp = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(stamp)) return ''
  const delta = Date.now() - stamp
  if (delta < 60_000) return 'now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`
  return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
