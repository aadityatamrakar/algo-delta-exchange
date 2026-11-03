/*
 * The traders page's service worker (spec 2026-10-23-traders-gaps G7), served at /traders/sw.js with scope /traders/.
 * It does two things: shows a pushed alert, and on a tap focuses an open traders page (or opens one) at the alert's
 * link. It has no fetch handler and caches nothing: every page load is the server's, as without it.
 *
 * A payload is the server's JSON { title, body, url, tag }; the link is only ever a path under /traders/.
 */

const HOME = '/traders/'

function safeUrl(url) {
  return typeof url === 'string' && url.startsWith(HOME) && !url.startsWith('//') ? url : HOME
}

self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : 'Delta Desk'
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    data: { url: safeUrl(data.url) },
    icon: `${HOME}icon-192.png`,
    badge: `${HOME}icon-192.png`,
  }
  if (typeof data.tag === 'string' && data.tag !== '') {
    options.tag = data.tag
    options.renotify = true
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(safeUrl(event.notification.data && event.notification.data.url), self.location.origin).href
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of open) {
      if (!new URL(client.url).pathname.startsWith(HOME)) continue
      await client.focus()
      if ('navigate' in client) await client.navigate(url).catch(() => undefined)
      return
    }
    await self.clients.openWindow(url)
  })())
})
