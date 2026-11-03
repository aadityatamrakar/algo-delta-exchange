/**
 * A placement failure that KNOWS WHAT IT IS — venue-neutral.
 *
 * `klass` is not decoration: `unknown` and `fatal` are both thrown without a
 * retry, and only this field tells them apart afterwards. The gateway books a
 * fatal tranche as failed (terminal, zero fill) and an unknown one as
 * AMBIGUOUS — non-terminal until the broker's own book answers. Re-classifying
 * the message at the catch site would work today and drift tomorrow, so the
 * class travels with the error.
 *
 * (Was `XtsOrderError` in `xts.ts`; the XTS adapter is gone from the Delta desk
 * and the class is the part every adapter shares.)
 */
export type BrokerErrorClass =
  /** Broker-side hiccup that provably did not place. Retry the SAME request unchanged. */
  | 'transient'
  /** Session died. Re-authenticate, then retry. */
  | 'session'
  /**
   * THE REQUEST MAY HAVE REACHED THE VENUE: a timeout, an abort, a dropped
   * connection. Retrying can place the same tranche twice; asserting failure
   * un-books a position that may be live. Held non-terminal until the broker
   * sweep finds its trace or times it out.
   */
  | 'unknown'
  /** Retrying will not help. Surface it. */
  | 'fatal'

export class BrokerOrderError extends Error {
  readonly klass: BrokerErrorClass
  constructor(message: string, klass: BrokerErrorClass) {
    super(message)
    this.name = 'BrokerOrderError'
    this.klass = klass
  }
}

/**
 * Classify an error that did NOT arrive as a `BrokerOrderError` (an adapter
 * that threw something else, or a fault before the adapter was reached).
 *
 * Only a transport fault is `unknown` — the request may be out there. Anything
 * else is `fatal`: a real refusal, which must not be resent.
 */
export function classifyBrokerError(message: string | undefined | null): BrokerErrorClass {
  if (message === undefined || message === null || message === '') return 'fatal'
  const m = message.toLowerCase()
  if (/timed out|timeout|abort|network|fetch failed|socket hang up|econnreset|etimedout|eai_again/.test(m)) {
    return 'unknown'
  }
  return 'fatal'
}
