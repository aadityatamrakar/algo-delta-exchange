/**
 * Where desk-runner reaches optionbhai, read from the environment.
 *
 * The defaults must stay exactly what the constants were (`https://` /
 * `wss://optionbhai.com`), so a box with none of the three variables set
 * behaves as it did before they existed. A malformed value is a refusal that
 * names the variable, never a silent fallback to the default — an operator
 * who set an origin IP and got Cloudflare anyway would have no way to tell.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeLogger, type CapturedLog } from '@algomaker/strategy-kit'
import {
  DEFAULT_BASE_URL,
  DEFAULT_SOCKET_URL,
  InvalidOptionbhaiEnv,
  isCleartext,
  optionbhaiOptionsFromEnv,
  resolveOptionbhaiOptions,
  runnerUserAgent,
} from '../src/optionbhai-env.ts'

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version

test('with nothing set, the defaults are the old constants and no Host override', () => {
  const o = optionbhaiOptionsFromEnv({})
  assert.equal(o.baseUrl, 'https://optionbhai.com')
  assert.equal(o.socketUrl, 'wss://optionbhai.com')
  assert.equal(DEFAULT_BASE_URL, 'https://optionbhai.com')
  assert.equal(DEFAULT_SOCKET_URL, 'wss://optionbhai.com')
  assert.equal(o.hostHeader, undefined)
  assert.equal(o.userAgent, `algomaker-desk-runner/${VERSION}`)
})

test('a blank variable is the same as an unset one', () => {
  const o = optionbhaiOptionsFromEnv({
    OPTIONBHAI_BASE_URL: '',
    OPTIONBHAI_SOCKET_URL: '  ',
    OPTIONBHAI_HOST_HEADER: '',
  })
  assert.equal(o.baseUrl, DEFAULT_BASE_URL)
  assert.equal(o.socketUrl, DEFAULT_SOCKET_URL)
  assert.equal(o.hostHeader, undefined)
})

test('the origin-IP configuration is read verbatim, trailing slash dropped', () => {
  const o = optionbhaiOptionsFromEnv({
    OPTIONBHAI_BASE_URL: 'http://13.202.244.113/',
    OPTIONBHAI_SOCKET_URL: 'ws://13.202.244.113',
    OPTIONBHAI_HOST_HEADER: 'optionbhai.com',
  })
  assert.deepEqual(o, {
    baseUrl: 'http://13.202.244.113',
    socketUrl: 'ws://13.202.244.113',
    hostHeader: 'optionbhai.com',
    userAgent: `algomaker-desk-runner/${VERSION}`,
  })
  assert.equal(isCleartext(o), true)
  assert.equal(isCleartext(optionbhaiOptionsFromEnv({})), false)
})

test('a base URL that is not http(s) is refused, naming the variable', () => {
  for (const bad of ['ws://13.202.244.113', 'ftp://optionbhai.com', 'optionbhai.com', 'not a url']) {
    assert.throws(
      () => optionbhaiOptionsFromEnv({ OPTIONBHAI_BASE_URL: bad }),
      (err: unknown) => err instanceof InvalidOptionbhaiEnv && /OPTIONBHAI_BASE_URL/.test(err.message),
      bad,
    )
  }
})

test('a URL carrying userinfo, a query or a fragment is refused — and the refusal does not echo a password', () => {
  const cases: [string, string][] = [
    ['OPTIONBHAI_BASE_URL', 'http://user:s3cret@13.202.244.113'],
    ['OPTIONBHAI_BASE_URL', 'http://user@13.202.244.113'],
    ['OPTIONBHAI_BASE_URL', 'http://13.202.244.113/?x=1'],
    ['OPTIONBHAI_BASE_URL', 'http://13.202.244.113/#frag'],
    ['OPTIONBHAI_SOCKET_URL', 'ws://user:s3cret@13.202.244.113'],
    ['OPTIONBHAI_SOCKET_URL', 'ws://13.202.244.113?token=abc'],
    ['OPTIONBHAI_SOCKET_URL', 'ws://13.202.244.113#x'],
  ]
  for (const [name, bad] of cases) {
    assert.throws(
      () => optionbhaiOptionsFromEnv({ [name]: bad }),
      (err: unknown) =>
        err instanceof InvalidOptionbhaiEnv && err.message.includes(name) && !err.message.includes('s3cret'),
      bad,
    )
  }
})

test('a socket URL that is not ws(s) is refused, naming the variable', () => {
  for (const bad of ['https://optionbhai.com', 'http://13.202.244.113', '13.202.244.113']) {
    assert.throws(
      () => optionbhaiOptionsFromEnv({ OPTIONBHAI_SOCKET_URL: bad }),
      (err: unknown) => err instanceof InvalidOptionbhaiEnv && /OPTIONBHAI_SOCKET_URL/.test(err.message),
      bad,
    )
  }
})

test('a Host header that is not a bare host[:port] is refused — no header injection', () => {
  for (const bad of ['optionbhai.com\r\nX-Evil: 1', 'optionbhai.com/path', 'https://optionbhai.com', 'a b']) {
    assert.throws(
      () => optionbhaiOptionsFromEnv({ OPTIONBHAI_HOST_HEADER: bad }),
      (err: unknown) => err instanceof InvalidOptionbhaiEnv && /OPTIONBHAI_HOST_HEADER/.test(err.message),
      JSON.stringify(bad),
    )
  }
  assert.equal(optionbhaiOptionsFromEnv({ OPTIONBHAI_HOST_HEADER: 'optionbhai.com:443' }).hostHeader, 'optionbhai.com:443')
})

test('the User-Agent carries the runner package version', () => {
  assert.equal(runnerUserAgent(), `algomaker-desk-runner/${VERSION}`)
})

// ------------------------------------------------------------ the boot step

test('boot: the endpoints are logged once, and a cleartext origin is a warning that says why', () => {
  const logs: CapturedLog[] = []
  const r = resolveOptionbhaiOptions(
    {
      OPTIONBHAI_BASE_URL: 'http://13.202.244.113',
      OPTIONBHAI_SOCKET_URL: 'ws://13.202.244.113',
      OPTIONBHAI_HOST_HEADER: 'optionbhai.com',
      OPTIONBHAI_1PBUY_PASS: 'not-a-real-password',
    },
    makeLogger(logs),
  )
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.options.hostHeader, 'optionbhai.com')
  const warn = logs.filter((l) => l.level === 'warn')
  assert.equal(warn.length, 1)
  assert.match(warn[0]?.msg ?? '', /unencrypted/)
  assert.deepEqual(warn[0]?.ctx, {
    baseUrl: 'http://13.202.244.113',
    socketUrl: 'ws://13.202.244.113',
    hostHeader: 'optionbhai.com',
  })
  assert.equal(JSON.stringify(logs).includes('not-a-real-password'), false)
})

test('boot: the default endpoints are an info line, not a warning', () => {
  const logs: CapturedLog[] = []
  const r = resolveOptionbhaiOptions({}, makeLogger(logs))
  assert.equal(r.ok, true)
  assert.deepEqual(
    logs.map((l) => l.level),
    ['info'],
  )
  assert.deepEqual(logs[0]?.ctx, { baseUrl: DEFAULT_BASE_URL, socketUrl: DEFAULT_SOCKET_URL, hostHeader: null })
})

test('boot: a malformed variable is NOT a crash — it is an error said once, and the reason to park the mirrors', () => {
  const logs: CapturedLog[] = []
  const r = resolveOptionbhaiOptions({ OPTIONBHAI_BASE_URL: 'ws://13.202.244.113' }, makeLogger(logs))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.error, /OPTIONBHAI_BASE_URL/)
  assert.deepEqual(
    logs.map((l) => l.level),
    ['error'],
  )
})
