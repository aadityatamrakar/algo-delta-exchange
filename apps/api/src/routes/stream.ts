/**
 * `POST /v1/desk/stream/notify` — how a LIVE order event reaches the socket.
 *
 * Paper needs nothing like this: paper fills are journalled INSIDE this process
 * (`PaperRail.route`, `SubmitService`), so the API knows about them at the
 * moment of the write. Live orders are placed by `apps/order-gateway`, a
 * different process, and production Mongo is a standalone — there are no change
 * streams to watch. So the gateway tells us, over one HTTP call, at the point it
 * journals.
 *
 * MACHINE PRINCIPALS ONLY. A session cookie must not be able to inject an order
 * event: every operator with a dashboard open would see a fill that never
 * happened, attributed to a strategy, and nothing in the journal would explain
 * it. The gateway holds `DESK_API_TOKEN`, which is exactly what a `machine`
 * principal is.
 *
 * THE MODE IS STATED, AND BOTH ARE NOW LEGITIMATE (D14). This endpoint used to
 * refuse anything but `'live'`, on the premise that the gateway reads only the
 * live rail — so a paper event arriving from it was a bug worth a loud 400.
 * That premise ended when the engine's PAPER orders started being worked
 * through the same queue: the gateway journals a rehearsal's every
 * PLANNED/ACK/STATUS and, while this refused them, sent them all as `'live'`
 * instead — putting a rehearsal's steps in front of an operator watching real
 * money, which is the failure the refusal existed to prevent, arriving through
 * the other door.
 *
 * So the field is still STATED rather than assumed, and still validated against
 * its literal set: a body with no mode, or a mode that is neither, is a caller
 * bug and fails with a 400 rather than landing on a tab by default. What
 * changed is only which values are accepted.
 *
 * THIS IS HTTP, NOT THE SOCKET. The socket carries nothing inbound but a mode
 * filter (see `stream.ts`); a notify that fails has to fail visibly to its
 * caller, which is what a status code is for.
 */

import type { Route, RouteCtx, StreamPublisher } from './kit.ts'
import { isObject } from './kit.ts'

export const NOTIFY_PATH = '/v1/desk/stream/notify'

/**
 * Takes the stream and nothing else, rather than the whole `ApiDeps` bag: this
 * endpoint touches no database and no service, and a dependency it does not use
 * is a dependency a test has to build.
 */
export function streamRoutes(deps: { readonly stream: StreamPublisher }): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, send, principal } = ctx
    if (path !== NOTIFY_PATH || method !== 'POST') return false

    if (principal.kind !== 'machine') {
      send(403, { error: 'only a machine principal may push order events' })
      return true
    }

    const body = await ctx.readJson()
    if (!isObject(body)) {
      send(400, { error: 'body must be a JSON object' })
      return true
    }
    const mode = body['mode']
    if (mode !== 'live' && mode !== 'paper') {
      send(400, {
        error:
          "mode must be stated explicitly as 'paper' or 'live' — the frame is scoped by rail " +
          'and a default would put an event on a tab nobody chose',
      })
      return true
    }
    const event = body['event']
    if (!isObject(event)) {
      send(400, { error: 'event must be a JSON object' })
      return true
    }

    // Normalisation, null discipline included, belongs to `DeskStream.publish`
    // so every producer gets the same treatment. `publish` never throws.
    deps.stream.publish(mode, event)
    send(200, { ok: true, subscribers: deps.stream.subscriberCount(mode) })
    return true
  }
}
