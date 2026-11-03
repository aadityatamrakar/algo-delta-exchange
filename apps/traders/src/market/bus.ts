import { WsTransportClient } from '@algomaker/bus'

/**
 * The desk bus client, with its socket opened. WsTransportClient connects only on `ready()`: a client nobody calls
 * it on never opens a socket, so it never receives a tick (health showed `busConnected: false` for good). Not
 * awaited, as in desk-api: the client reconnects by itself, and the pages serve last-known prices meanwhile.
 */
export function openBus(url: string, log: (msg: string, ctx?: Record<string, unknown>) => void): WsTransportClient {
  const bus = new WsTransportClient({ url })
  void bus.ready().then(
    () => log('bus connected', { url }),
    (err: unknown) => log('bus not reachable yet, will retry', { url, error: String(err) }),
  )
  return bus
}
