/**
 * A crash in one page must not blank the whole dashboard.
 *
 * React unmounts the ENTIRE tree when a render throws and nothing catches it.
 * On a monitoring surface for a live trading system that is the worst available
 * failure: the operator gets a blank screen at the moment they most need to see
 * the kill switch, and nothing on the page says why.
 *
 * It is not hypothetical. The Feed page white-screened because `desk-api` was
 * one deploy behind and a field the page expected was absent — `inr(undefined)`
 * threw. The formatter is fixed, but the class of bug is permanent: the types
 * describe the CURRENT API and a running process can always be older.
 *
 * So this catches the throw, shows what happened, and leaves the navigation
 * alone — every other page stays reachable, which is the whole point.
 *
 * A class component because that is the only thing React gives us:
 * `componentDidCatch` has no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { VStack } from '@astryxdesign/core/Layout'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'

interface Props {
  /** Changing this RESETS the boundary — pass the route so navigating away recovers. */
  readonly resetKey: string
  readonly children: ReactNode
}

interface State {
  readonly error: Error | null
}

export class PageBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidUpdate(prev: Props): void {
    // Navigating to another page clears the error. Without this the boundary
    // would latch and the operator would have to reload to escape a page that
    // failed once.
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept to the console rather than sent anywhere: there is no error sink in
    // this deployment, and inventing one would be a network call from a page
    // that is already failing.
    console.error('[page crashed]', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <VStack gap={3}>
        <Banner
          status="error"
          title="This page could not be displayed"
          description={
            `${error.message}. The rest of the dashboard still works — the navigation above is ` +
            `unaffected. If the desk was just redeployed, this page may be reading a field the ` +
            `running API does not send yet.`
          }
        />
        <Text size="sm" color="secondary">
          Reloading is safe. Nothing on this page has changed any state.
        </Text>
        <Button variant="secondary" label="Try again" onClick={() => this.setState({ error: null })} />
      </VStack>
    )
  }
}
