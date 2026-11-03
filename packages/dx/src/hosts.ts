/**
 * Delta's two exchanges, and the one rule between them: a credential is only
 * ever sent to the exchange it was issued by.
 *
 * Production (`live`) is Delta Exchange India. The demo (`demo`) is Delta's
 * India testnet — separate accounts, separate keys, separate product ids. A
 * testnet key sent to production fails to authenticate at best; a production
 * key sent to testnet hands a real credential to a host it was never meant
 * for. Both directions are refused here, before any request is built, by the
 * gateway's config loaders and by the api's credential test.
 */

export const DX_PROD_REST_URL = 'https://api.india.delta.exchange'
export const DX_PROD_WS_URL = 'wss://socket.india.delta.exchange'

export const DX_DEMO_REST_URL = 'https://cdn-ind.testnet.deltaex.org'
export const DX_DEMO_WS_URL = 'wss://socket-ind.testnet.deltaex.org'
export const DX_DEMO_PUBLIC_WS_URL = 'wss://socket-ind-pub.testnet.deltaex.org'

/** Every testnet host is under this domain; nothing in production is. */
const TESTNET_DOMAIN = 'testnet.deltaex.org'

export type DxCredentialRail = 'live' | 'demo'

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Is this URL's host one of Delta's testnet hosts? A label boundary, not a substring. */
export function isDemoHost(url: string): boolean {
  const u = parse(url)
  if (u === null) return false
  const host = u.hostname.toLowerCase()
  return host === TESTNET_DOMAIN || host.endsWith(`.${TESTNET_DOMAIN}`)
}

/**
 * Throw unless `url` is a host the `rail`'s credentials may be sent to.
 *
 *   demo → a testnet host only, over TLS (`https:`/`wss:`). Allowlist: anything
 *          that is not provably testnet is refused, production included.
 *   live → anything but testnet. The production host is the operator's
 *          `baseUrl` to choose; testnet is the one place it must never be.
 */
export function assertRailHost(rail: DxCredentialRail, url: string): void {
  const u = parse(url)
  if (u === null) throw new Error(`Delta ${rail} host '${url}' is not a URL`)
  if (rail === 'demo') {
    if (!isDemoHost(url) || (u.protocol !== 'https:' && u.protocol !== 'wss:')) {
      throw new Error(
        `Delta demo credentials may only be sent to the testnet (https/wss *.${TESTNET_DOMAIN}); ` +
          `refusing '${url}'`,
      )
    }
    return
  }
  if (isDemoHost(url)) {
    throw new Error(`Delta production credentials must never be sent to the testnet; refusing '${url}'`)
  }
}
