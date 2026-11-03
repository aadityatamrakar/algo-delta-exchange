/**
 * Catch the bridge in the act.
 *
 * On 2026-09-15 desk-api stalled EPISODICALLY: the main thread pinned at 100%
 * and the HTTP port stopped answering for up to eight minutes at a stretch,
 * then recovered on its own. A profile taken after recovery shows an idle
 * process and proves nothing, which is exactly what happened the first time.
 *
 * So this probes /health, and the moment the bridge misses enough probes in a
 * row it opens the inspector (SIGUSR1) and takes a CPU profile WHILE THE STALL
 * IS STILL HAPPENING. The .cpuprofile drops in OUT_DIR — open it in Chrome
 * DevTools (Performance -> Load profile) and the hot stack is the answer.
 *
 * Read-only apart from the signal, which does not restart or reconfigure the
 * process: it only opens a localhost debug port that a restart closes again.
 */
const URL_HEALTH = process.env['WATCH_URL'] ?? 'http://127.0.0.1:8890/health'
const PROBE_MS = Number(process.env['WATCH_PROBE_MS'] ?? 5_000)
const SLOW_MS = Number(process.env['WATCH_SLOW_MS'] ?? 2_000)
const STRIKES = Number(process.env['WATCH_STRIKES'] ?? 3)
const PROFILE_MS = Number(process.env['WATCH_PROFILE_MS'] ?? 20_000)
const OUT_DIR = process.env['WATCH_OUT'] ?? '/opt/algomaker-delta/logs'
const PID = Number(process.env['WATCH_PID'] ?? 0)

const fs = await import('node:fs')
const log = (m, c) => console.log(`[stall-watch] ${new Date().toISOString()} ${m}${c ? ' ' + JSON.stringify(c) : ''}`)

let strikes = 0
let capturing = false

async function probe() {
  const t0 = Date.now()
  try {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), SLOW_MS)
    const r = await fetch(URL_HEALTH, { signal: ac.signal })
    clearTimeout(to)
    await r.text()
    return Date.now() - t0
  } catch { return Number.POSITIVE_INFINITY }
}

async function capture() {
  capturing = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    if (PID > 0) { process.kill(PID, 'SIGUSR1'); await new Promise(r => setTimeout(r, 1500)) }
    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json()
    const ws = new WebSocket(list[0].webSocketDebuggerUrl)
    let id = 0; const pend = new Map()
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pend.set(i, { res, rej })
      ws.send(JSON.stringify({ id: i, method, params }))
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('cdp timeout ' + method)) } }, 30_000)
    })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
    }
    await new Promise((r) => (ws.onopen = r))
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: 100 })
    await send('Profiler.start')
    log('PROFILING A LIVE STALL', { ms: PROFILE_MS })
    await new Promise((r) => setTimeout(r, PROFILE_MS))
    const { profile } = await send('Profiler.stop')
    const file = `${OUT_DIR}/stall-${stamp}.cpuprofile`
    fs.writeFileSync(file, JSON.stringify(profile))

    // Self time per frame, so the answer is in the log even without DevTools.
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const self = new Map()
    for (const s of profile.samples ?? []) self.set(s, (self.get(s) ?? 0) + 1)
    const total = (profile.samples ?? []).length || 1
    const top = [...self.entries()]
      .map(([nid, c]) => {
        const f = byId.get(nid)?.callFrame ?? {}
        return { pct: (c * 100) / total, fn: f.functionName || '(anon)', at: `${(f.url ?? '').replace('file:///opt/algomaker-delta/', '')}:${f.lineNumber}` }
      })
      .sort((a, b) => b.pct - a.pct).slice(0, 15)
    log('stall profile saved', { file, samples: (profile.samples ?? []).length })
    for (const t of top) log(`  ${t.pct.toFixed(1)}%  ${t.fn}  ${t.at}`)
    ws.close()
  } catch (err) {
    log('capture failed', { error: err instanceof Error ? err.message : String(err) })
  }
  capturing = false
  strikes = 0
}

log('watching', { url: URL_HEALTH, probeMs: PROBE_MS, slowMs: SLOW_MS, strikes: STRIKES, pid: PID })
setInterval(async () => {
  if (capturing) return
  const ms = await probe()
  if (ms > SLOW_MS) {
    strikes++
    log('slow/no answer', { ms: Number.isFinite(ms) ? ms : 'timeout', strikes })
    if (strikes >= STRIKES) await capture()
  } else if (strikes > 0) {
    log('recovered', { ms }); strikes = 0
  }
}, PROBE_MS)
