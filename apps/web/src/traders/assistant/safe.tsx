/**
 * What keeps a malformed card or stored turn from taking the page down: tolerant readers for the wire's arrays,
 * numbers and strings (a server a deploy ahead or behind can send any of them missing), and a boundary that turns
 * a card that still throws into one line of text.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

/** The array, or empty when it is missing or not an array. */
export function arr<T>(x: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(x) ? x : []
}

/** A finite number, else null. */
export function numOr(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

/** A string, else ''. */
export function str(x: unknown): string {
  return typeof x === 'string' ? x : ''
}

interface State { readonly error: Error | null }

/** One card that fails to render becomes one line; the answer, the drawer and the page carry on. */
export class CardBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[assistant card]', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return <div className="traders-ai-error traders-ai-card-failed">{`This card could not be shown (${error.message})`}</div>
  }
}
