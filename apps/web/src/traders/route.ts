/** The hash router: `#/books/TCS`, `#/orders`, `#/admin`. A hash so the static host needs no rewrite rules. */

import { useCallback, useEffect, useState } from 'react'

/** `sub` is a book's sub-tab, the optional third segment of `#/books/TCS/scenario`. */
export interface TradersRoute { readonly page: string; readonly stock: string | null; readonly sub: string | null }

export function parseRoute(hash: string): TradersRoute {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((p) => p !== '')
  const page = parts[0] ?? 'books'
  let stock: string | null = null
  if (page === 'books' && parts[1] !== undefined) {
    try { stock = decodeURIComponent(parts[1]) } catch { stock = null }
  }
  const sub = stock === null ? null : (parts[2] ?? null)
  return { page, stock, sub }
}

/** Go to `to` (`/books/TCS` or `#/books/TCS`) — the same move as `useTradersRoute`'s `go`, for code outside a component. */
export function navigate(to: string): void {
  window.location.hash = to.startsWith('#') ? to : `#${to}`
}

export function useTradersRoute(): [TradersRoute, (to: string) => void] {
  const [route, setRoute] = useState<TradersRoute>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const on = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((to: string): void => navigate(to), [])
  return [route, go]
}
