# XTS integration

What the desk needs from an XTS account, and the three things about it that are not in the vendor
docs. Sources: `packages/brokers/src/xts-rest.ts`, the legacy `common/models/xts-account.js` on
`master`, and the vendored SDK at `node_modules/xts-interactive-api`.

## 1. Login is two steps, not one

```
POST <hostLookupUrl>                     { accesspassword, versionName }
  -> { result: { connectionString, uniqueKey } }

POST <connectionString>/<prefix>/user/session
     { appKey, secretKey, source, uniqueKey? }
  -> { result: { token, userID, clientCodes } }
```

**`connectionString` REPLACES the base URL.** The configured `baseUrl` is only where the lookup
lives; the real API host is whatever comes back. Hardcoding a base URL works until the broker moves
you between servers, and then fails with no obvious cause.

Host lookup is skipped entirely when `hostLookupUrl` is unset, so a deployment that talks straight
to its host pays nothing for it.

### Three details the vendor docs omit

All three came from the legacy account model, and each is the difference between logging in and not:

- **`uniqueKey` is omitted entirely when the broker issues none.** Sending `""` is rejected.
- **`prefix` varies by deployment.** The public docs host serves `/1interactive`; most live
  deployments serve `/interactive`. The wrong one 404s every call.
- **XTS invalidates the previous session on each login.** A restarting process that logs in fresh
  silently kills the session a sibling process is using. `existingToken`/`onToken` exist so a token
  can be reused and only discarded when the broker says it expired.

That last point is also why the portal's **"Test connection" logs straight back out** — otherwise
clicking Test would kill the live gateway's session.

## 2. Dealer vs investor — the part most likely to bite

An XTS account is one or the other, and they use **different endpoints for reading back state**.

Legacy derived it from a stored `clientCode` (`xts-account.js:62-75`):

```js
clientCodes = [account.clientCode ?? account.username]

isInvestorClient =
  account.clientCode === '*****' ? false                          // DEALER
                                 : account.clientCode === account.username
```

`'*****'` — five literal asterisks — is the dealer marker, compared as a string.

| | investor | dealer |
|---|---|---|
| order book | `GET /orders` | `GET /orders/dealerorderbook` |
| positions | `GET /portfolio/positions` | `GET /portfolio/dealerpositions` |

Both dealer calls take `?dayOrNet=DayWise|NetWise&clientID=<code>`. Endpoint paths are from
`node_modules/xts-interactive-api/lib/config/app/settings.json`, which is the authority available
offline.

**There is no dealer trade-book endpoint in this SDK version** — `settings.json` lists `trade:
/orders/trades` and nothing dealer-specific. Do not invent one.

### Why this matters more than it looks

Placing an order takes `clientID` on the request, so **order placement can work while reading back
does not**. The fill watcher polls the order book. A dealer account on the investor endpoint gets an
order that fills at the broker and a gateway that never sees the fill — a position the desk does not
know it holds.

### `clientID` is an override, not a fallback

The port originally derived `clientID` from the login response alone
(`clientCodes[0] ?? userID`), with nowhere to configure it. That is wrong for a dealer, whose login
need not return the code that orders must carry.

It is configurable, and a configured value **wins** over the derived one — the same reasoning as
`liveLots` overriding rather than multiplying a strategy's size: you can read the configured value
off the page and match it against the order that went out, instead of wondering which source won.

## 3. Configuration

| Where | What |
|---|---|
| Portal → Brokers → XTS | `appKey`, `secretKey`, `uniqueKey` (sealed); `baseUrl`, `prefix`, `clientCode` in `meta` |
| `.env.local` | `XTS_BASE_URL`, `XTS_APP_KEY`, `XTS_SECRET_KEY`, `XTS_HOST_LOOKUP_URL`, `XTS_PREFIX`, `XTS_UNIQUE_KEY`, `XTS_CLIENT_ID` |

`clientCode` lives in `meta` rather than the sealed blob because it is not a secret, and `meta` is
echoed back — so the card can show what is configured. Nothing in `meta` is ever a credential; the
store filters it on write *and* on read.

## 4. Order placement

`POST /orders`, with `clientID` on every request. The desk adds two things around it:

- **Freeze splitting.** NSE caps quantity per order (`VOL_FRZ_QTY`), so a large order is split into
  tranches of `floor(freezeQty / lotSize)` lots. An unknown symbol yields `null` — never an implicit
  infinity — and that case is handled explicitly rather than producing one oversized order the
  exchange rejects outright.
- **Idempotency.** Every order carries a `clientOrderId`; the same id submitted twice places once.
  A retry must reuse the SAME id — retrying under a fresh one is the duplicate-order bug.

## 5. Checking it works

The portal's Test button performs a real login and logs out again. It reports the broker's own
message on failure, and that message is redacted against every stored credential value first —
XTS echoes the request payload in some error descriptions, and the text is persisted in `lastError`
where the Brokers page returns it on every poll.

A successful test proves the credentials log in. It does **not** prove the account is the right
kind — that only shows up when a dealer account reads an empty order book.

## 6. Turning XTS off — the broker link

XTS issues **one interactive session per API key**. Logging in anywhere else kills the gateway's
session, and the gateway re-logs in the moment a call answers with a session error — which kills
the other login straight back. So using the key somewhere else for a while is not something
switching strategies off can achieve: the gateway must **let go of the key and stay off it**.

That is the **XTS session** card on the Controls page (`/v1/desk/broker-link`). *Release* makes the
order gateway:

- close the interactive order websocket and not rebuild it;
- `DELETE /user/session` and delete the stored token (`desk-broker-session`), so a restart while
  released cannot reuse a bearer;
- perform **no login of any kind** — not the adapter's relogin on a session error, not the
  snapshot loop's relogin on expiry, not the boot's `ensureSession`;
- skip every loop that calls XTS (broker snapshot, cancel drain, broker-book sweep, the live
  chaser) and **refuse every queued LIVE order, exits included** — this is the absence of a
  broker, not a rule about exposure. The bridge refuses live orders at write time for the same
  reason (`safety.ts:brokerLinkRefusal`), so nothing is folded into a book that the gateway then
  cannot place.

Paper trading and Zerodha market data are untouched. *Reconnect* is a fresh login (password-gated,
like releasing the kill switch); a failed one stays released, records why, and retries every 30s.

The switch is one `desk-safety` document (`_id: 'broker-link'`): the bridge writes the **wish**
(`desired`, `reason`, `setBy`, `setAt`) and the gateway answers with an **ack** (`applied`,
`appliedAt`, `appliedError`) within ~2s. The card and the System page show both, so "asked" and
"done" are never confused. Implementation: `apps/order-gateway/src/broker-link.ts`.
