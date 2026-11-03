/**
 * Phone alerts' plumbing (gaps G7): the endpoint guard (the server POSTs to what a browser hands it), the VAPID keys
 * made once and kept, the subscriptions and their cap, and the Pusher's handling of a push service's answers. The
 * sender is always a fake: no test makes a real push.
 */
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { parse as parseUrl } from 'node:url'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import {
  PushStore, Pusher, SUBSCRIPTIONS_PER_USER, VapidStore, parseSubscription, phoneId, pushEndpointProblem,
  type PushSender, type PushTarget, type Vapid, type VapidKeys,
} from '../src/alerts/push.ts'
import { generateVapidKeys } from '../src/alerts/web-push.ts'
import { DEFAULT_PUSH_SUBJECT, configFromEnv } from '../src/config.ts'
import type { TraderUser } from '../src/types.ts'
import { connectSuite, wipe } from './mongo.ts'

const s = await connectSuite('alerts_push')
// the app's indexes, as start() makes them: R1's unique { kind, trader } is what settles two first uses of the keys
if (s !== null) await s.db.ensureIndexes()
after(async () => { await s?.handle.close() })
beforeEach(async () => { if (s !== null) await wipe(s.handle) })

const p256dh = (): string => Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url')
const auth = (): string => randomBytes(16).toString('base64url')
const target = (endpoint: string): PushTarget => ({ endpoint, keys: { p256dh: p256dh(), auth: auth() } })
const FCM = (id: string): string => `https://fcm.googleapis.com/fcm/send/secret-${id}`

// ---- the endpoint guard ------------------------------------------------------------------

test('the endpoint guard: https on the push services browsers use, nothing else', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://fcm.googleapis.com/wp/abc',
    'https://web.push.apple.com/QGxyz',
    'https://api.push.apple.com/3/device/x',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA%2b',
    'https://FCM.googleapis.com:443/fcm/send/x',   // the default port is no port
  ]) assert.equal(pushEndpointProblem(ok), null, ok)
  for (const [bad, why] of [
    ['http://fcm.googleapis.com/fcm/send/x', /https/],
    ['https://fcm.googleapis.com:8443/fcm/send/x', /port/],
    ['https://user:pw@fcm.googleapis.com/fcm/send/x', /push service URL|credentials/],
    ['https://127.0.0.1/fcm/send/x', /known push service/],
    ['https://localhost/x', /known push service/],
    ['https://169.254.169.254/latest/meta-data', /known push service/],
    ['https://fcm.googleapis.com.evil.example/x', /known push service/],
    ['https://evilfcm.googleapis.com/x', /known push service/],
    ['https://push.apple.com/x', /known push service/],   // a suffix needs a label before it
    ['https://notpush.apple.com.example/x', /known push service/],
    ['https://fcm.googleapis.com./x', /plain DNS name/],
    ['https://evil.example\\@fcm.googleapis.com/x', /push service URL/],
    ['https://evil.example#@fcm.googleapis.com/x', /push service URL/],
    ['https://fcm.googleapis.com/x y', /push service URL/],
    ['file:///etc/passwd', /https/],
    ['not a url', /push service URL|not a URL/],
    [`https://fcm.googleapis.com/${'x'.repeat(1100)}`, /at most/],
  ] as const) assert.match(pushEndpointProblem(bad) ?? '', why, bad)
  for (const bad of [undefined, null, 42, '', {}]) assert.notEqual(pushEndpointProblem(bad), null)
})

test('the endpoint guard: no host two URL parsers read differently (web-push sends with the legacy url.parse)', () => {
  // each of these is a push service's host to the WHATWG parser, or decodes to one, and somewhere else to web-push's
  const bypasses = [
    'https://evil.example;x.push.apple.com/a',          // the review's: url.parse stops at ';' and POSTs to evil.example
    'https://evil.example{x.push.apple.com/a',
    'https://evil.example}x.push.apple.com/a',
    'https://evil.example"x.push.apple.com/a',
    "https://evil.example'x.push.apple.com/a",
    'https://evil.example`x.push.apple.com/a',
    'https://evil.example%3bx.push.apple.com/a',        // % escapes: WHATWG decodes them in a host, url.parse does not
    'https://evil.example%3Bx.push.apple.com/a',
    'https://fcm%2egoogleapis.com/fcm/send/x',
    'https://web%2Epush.apple.com/x',
    'https://EVIL.EXAMPLE;X.PUSH.APPLE.COM/a',          // upper case
    'https://web.push.apple.com./x',                    // a trailing dot
    'https://web..push.apple.com/x',                    // an empty label
    'https://wéb.push.apple.com/x',                     // IDN
    'https://fcm.googleapis.com\u3002evil.example/x',   // an ideographic full stop, a dot to WHATWG
    'https://xn--wb-bja.push.apple.com/x',              // punycode
    'https://-evil.push.apple.com/x',
    'https://[::1]/x',                                  // IP literals
    'https://[::ffff:127.0.0.1]/x',
    'https://127.0.0.1/x',
    'https://0x7f.1/x',
    'https://2130706433/x',
    'https://evil.example\t.push.apple.com/a',          // a tab, which WHATWG strips
    'https://evil.example\n.push.apple.com/a',
  ]
  for (const bad of bypasses) assert.notEqual(pushEndpointProblem(bad), null, bad)
  assert.equal(parseUrl('https://evil.example;x.push.apple.com/a').hostname, 'evil.example', 'why: the library\'s parser')
  assert.equal(new URL('https://evil.example;x.push.apple.com/a').hostname, 'evil.example;x.push.apple.com')
  // the plain forms still pass, an upper-case host or the default port included
  for (const ok of ['https://WEB.push.apple.com/QGx', 'https://web.push.apple.com:443/QGx', 'https://fcm.googleapis.com/fcm/send/a%3Ab'])
    assert.equal(pushEndpointProblem(ok), null, ok)
  assert.throws(() => parseSubscription({ ...target('https://evil.example;x.push.apple.com/a') }), /plain DNS name/)
})

test('a subscription: the guarded endpoint (stored as its normal form) and well-formed keys', () => {
  const t = target('https://FCM.googleapis.com:443/fcm/send/abc')
  assert.deepEqual(parseSubscription({ ...t, expirationTime: null }), { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: t.keys })
  const bad = (body: unknown, why: RegExp) => assert.throws(() => parseSubscription(body), why)
  bad(null, /push subscription/)
  bad({ ...t, endpoint: 'https://127.0.0.1/x' }, /known push service/)
  bad({ endpoint: t.endpoint }, /keys must be/)
  bad({ ...t, keys: { ...t.keys, p256dh: Buffer.alloc(65, 4).toString('base64url').slice(1) } }, /p256dh/)
  bad({ ...t, keys: { ...t.keys, p256dh: Buffer.concat([Buffer.from([2]), randomBytes(64)]).toString('base64url') } }, /p256dh/)
  bad({ ...t, keys: { ...t.keys, auth: randomBytes(15).toString('base64url') } }, /auth/)
  bad({ ...t, keys: { ...t.keys, auth: 'not base64!' } }, /auth/)
})

test('TRADERS_PUSH_SUBJECT: https or mailto, a sane https default; never fetched', () => {
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm' }).pushSubject, DEFAULT_PUSH_SUBJECT)
  assert.match(DEFAULT_PUSH_SUBJECT, /^https:\/\//)
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_PUSH_SUBJECT: ' mailto:desk@example.com ' }).pushSubject, 'mailto:desk@example.com')
  for (const bad of ['http://example.com', 'https://localhost/', 'mailto:nobody', 'desk@example.com'])
    assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_PUSH_SUBJECT: bad }), /TRADERS_PUSH_SUBJECT/, bad)
})

// ---- VAPID keys ----------------------------------------------------------------------------

test('VAPID keys: real P-256 keys from web-push, made locally', () => {
  const k = generateVapidKeys()
  assert.equal(Buffer.from(k.publicKey, 'base64url').length, 65)
  assert.equal(Buffer.from(k.privateKey, 'base64url').length, 32)
})

test('VAPID keys: made on first use, stored in traders-settings, and the same after a restart', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  let made = 0
  const first = new VapidStore(s.db, () => 1000, () => { made++; return generateVapidKeys() })
  const [a, b] = await Promise.all([first.keys(), first.keys()])
  assert.deepEqual(a, b)
  assert.equal(made, 1, 'one process asks once')
  const docs = await s.db.collection('traders-settings').find({ kind: 'vapid' }, { projection: { _id: 0 } }).toArray()
  assert.deepEqual(docs, [{ kind: 'vapid', trader: null, publicKey: a.publicKey, privateKey: a.privateKey, createdAt: 1000 }])
  const restarted = new VapidStore(s.db, () => 2000, () => { throw new Error('a restart must not make new keys') })
  assert.deepEqual(await restarted.keys(), a)
})

test('VAPID keys: two first uses at once (two processes) agree on one pair, the one stored', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  const { db, handle } = s
  for (let round = 0; round < 5; round++) {
    await wipe(handle)
    const pairs: VapidKeys[] = [generateVapidKeys(), generateVapidKeys(), generateVapidKeys()]
    const stores: VapidStore[] = pairs.map((p) => new VapidStore(db, () => 1, () => p))
    const got: VapidKeys[] = await Promise.all(stores.map((v) => v.keys()))
    const stored = await db.collection('traders-settings').find({ kind: 'vapid' }).toArray()
    assert.equal(stored.length, 1)
    for (const k of got) assert.deepEqual(k, { publicKey: stored[0]?.['publicKey'], privateKey: stored[0]?.['privateKey'] })
  }
})

test('VAPID keys: a failed first read is not remembered', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  let fail = true
  const v = new VapidStore(s.db, () => 1, () => { if (fail) throw new Error('no entropy'); return generateVapidKeys() })
  await assert.rejects(v.keys(), /no entropy/)
  fail = false
  assert.equal(Buffer.from((await v.keys()).publicKey, 'base64url').length, 65)
})

// ---- subscriptions -------------------------------------------------------------------------

test('subscriptions: one row per endpoint; a re-subscribe updates it; another user subscribing it takes it over', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  let now = 100
  const subs = new PushStore(s.db, () => now)
  await subs.ensureIndexes()
  const phone = target(FCM('a'))
  assert.equal(await subs.add('ravi', phone), 1)
  now = 200
  const rekeyed = { ...phone, keys: { p256dh: p256dh(), auth: auth() } }
  assert.equal(await subs.add('ravi', rekeyed), 1)
  assert.deepEqual(await s.db.collection('traders-push').find({}, { projection: { _id: 0 } }).toArray(), [
    { endpoint: phone.endpoint, username: 'ravi', keys: rekeyed.keys, seenAt: 200, createdAt: 100, lastOkAt: null },
  ])
  // the same browser, signed in as sita: it is hers now
  assert.equal(await subs.add('sita', rekeyed), 1)
  assert.equal(await subs.count('ravi'), 0)
  // two first subscribes of one endpoint at once: one row
  await Promise.all([subs.add('ravi', target(FCM('b'))), subs.add('ravi', target(FCM('b')))])
  assert.equal(await s.db.collection('traders-push').countDocuments({ endpoint: FCM('b') }), 1)
})

test(`subscriptions: at most ${SUBSCRIPTIONS_PER_USER} phones a user, the least recently subscribed goes; remove is own-only`, async (t) => {
  if (s === null) return skipUnlessMongo(t)
  let now = 0
  const subs = new PushStore(s.db, () => now)
  await subs.ensureIndexes()
  for (let i = 0; i < 7; i++) { now = 1000 + i; await subs.add('ravi', target(FCM(String(i)))) }
  const kept = (await subs.of(['ravi'])).map((r) => r.endpoint).sort()
  assert.deepEqual(kept, ['2', '3', '4', '5', '6'].map(FCM))
  assert.equal(await subs.add('sita', target(FCM('s'))), 1)
  assert.equal(await subs.remove('ravi', FCM('s')), false, 'not ravi\'s')
  assert.equal(await subs.count('sita'), 1)
  assert.equal(await subs.remove('sita', FCM('s')), true)
  assert.equal(await subs.count('sita'), 0)
})

// ---- sending -------------------------------------------------------------------------------

interface Sent { endpoint: string; payload: unknown; vapid: Vapid }

/** The users the Pusher reads on each send: ravi and sita enabled, gone disabled, anyone else unknown. */
const USERS = new Map<string, boolean>([['ravi', false], ['sita', false], ['gone', true]])
const users = {
  find: async (name: unknown) => {
    const disabled = USERS.get(String(name))
    return disabled === undefined ? null : ({ username: String(name), role: 'trader', disabled } as TraderUser)
  },
}

function pusherWith(answer: (endpoint: string) => number | Error) {
  const sent: Sent[] = []
  const logs: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
  const send: PushSender = async (t, payload, vapid) => {
    sent.push({ endpoint: t.endpoint, payload: JSON.parse(payload), vapid })
    const a = answer(t.endpoint)
    if (a instanceof Error) throw a
    if (a >= 300) throw Object.assign(new Error('Received unexpected response code'), { statusCode: a, endpoint: t.endpoint })
    return a
  }
  const subs = new PushStore(s!.db, () => 5)
  const keys = generateVapidKeys()
  const pusher = new Pusher({
    subs, users, vapid: { keys: async () => keys }, subject: 'https://desk.example/traders/', send, now: () => 7777,
    log: (msg, ctx) => { logs.push({ msg, ctx }) },
  })
  return { pusher, subs, sent, logs, keys }
}

const MSG = { title: 'TCS out of band', body: 'Out of band by 1 lot.', url: '/traders/#/books/TCS', tag: 'band-breach:TCS' }

test('a send: every phone of the users named, the payload and the VAPID subject; a phone that took it is stamped', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  const { pusher, subs, sent, keys } = pusherWith(() => 201)
  await subs.add('ravi', target(FCM('r1'))); await subs.add('ravi', target(FCM('r2'))); await subs.add('sita', target(FCM('s1')))
  assert.equal(await pusher.send(['ravi'], MSG), 2)
  assert.deepEqual(sent.map((x) => x.endpoint).sort(), [FCM('r1'), FCM('r2')])
  assert.deepEqual(sent[0]?.payload, MSG)
  assert.deepEqual(sent[0]?.vapid, { ...keys, subject: 'https://desk.example/traders/' })
  assert.deepEqual((await subs.of(['ravi'])).map((r) => r.lastOkAt), [7777, 7777])
  assert.equal(await pusher.send(['nobody'], MSG), 0)
  const long = pusherWith(() => 201)
  await long.subs.add('ravi', target(FCM('long')))
  await long.pusher.send(['ravi'], { ...MSG, body: 'x'.repeat(5000) })
  assert.ok(JSON.stringify(long.sent.at(-1)?.payload).length < 1000, 'a long body is cut')
})

test('a 404 or 410 drops the subscription; any other failure keeps it and is logged once, never the endpoint\'s path', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  const answers: Record<string, number | Error> = {
    [FCM('gone')]: 410, [FCM('missing')]: 404, [FCM('busy')]: 503,
    [FCM('reset')]: Object.assign(new Error(`connect ECONNRESET ${FCM('reset')}`), { code: 'ECONNRESET' }), [FCM('fine')]: 201,
  }
  const { pusher, subs, logs } = pusherWith((e) => answers[e] ?? 201)
  for (const e of Object.keys(answers)) await subs.add('ravi', target(e))
  assert.equal(await pusher.send(['ravi'], MSG), 1)
  assert.deepEqual((await subs.of(['ravi'])).map((r) => r.endpoint).sort(), [FCM('busy'), FCM('fine'), FCM('reset')])
  assert.equal(await pusher.send(['ravi'], MSG), 1)
  const failures = logs.filter((l) => l.msg === 'phone alert not delivered')
  assert.deepEqual(failures.map((l) => l.ctx).sort((a, b) => String(a?.['phone']).localeCompare(String(b?.['phone']))),
    [{ host: 'fcm.googleapis.com', phone: phoneId(FCM('busy')), status: 503 }, { host: 'fcm.googleapis.com', phone: phoneId(FCM('reset')), error: 'ECONNRESET' }]
      .sort((a, b) => a.phone.localeCompare(b.phone)), 'one line per phone and kind, however often it fails')
  assert.equal(logs.filter((l) => l.msg.includes('unsubscribed')).length, 2)
  for (const l of logs) assert.equal(JSON.stringify(l).includes('secret-'), false, `a log line carries an endpoint path: ${JSON.stringify(l)}`)
})

test('a stored row that is not a push service is never POSTed to, and goes', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  const { pusher, sent } = pusherWith(() => 201)
  await s.db.collection('traders-push').insertOne({ username: 'ravi', endpoint: 'https://169.254.169.254/latest', keys: target('x').keys, createdAt: 1, seenAt: 1, lastOkAt: null })
  assert.equal(await pusher.send(['ravi'], MSG), 0)
  assert.deepEqual(sent, [])
  assert.equal(await s.db.collection('traders-push').countDocuments({}), 0)
})


test('revoked access: a disabled or unknown user gets no push whatever phones are on file; forget drops a user\'s phones', async (t) => {
  if (s === null) return skipUnlessMongo(t)
  const { pusher, subs, sent } = pusherWith(() => 201)
  for (const [user, id] of [['ravi', 'r'], ['gone', 'g1'], ['gone', 'g2'], ['ghost', 'x'], ['sita', 's']] as const) await subs.add(user, target(FCM(id)))
  assert.equal(await pusher.send(['gone', 'ghost', 'ravi', 'ravi'], MSG), 1)
  assert.deepEqual(sent.map((x) => x.endpoint), [FCM('r')])
  assert.equal(await subs.forget('gone'), 2)
  assert.deepEqual((await subs.of(['gone', 'ravi', 'sita', 'ghost'])).map((r) => r.endpoint).sort(), [FCM('r'), FCM('s'), FCM('x')])
  assert.equal(await subs.forget('gone'), 0)
})
