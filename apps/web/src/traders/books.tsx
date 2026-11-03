/** The Books page: one tab per open book, each tab a `BookTab`. */

import { useContext } from 'react'
import { VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import type { BookSummary, StoredFile, WatcherStatus } from '../../../traders/src/types.ts'
import { bandBadge } from './advice.tsx'
import { tapi } from './api.ts'
import { BellAlert } from './bell.tsx'
import { BellSource } from './bell-store.tsx'
import { BookTab } from './book.tsx'
import { BOOKS_POLL_MS, BooksContext, useBooksList } from './books-list.ts'
import { useSession, usePoll } from './hooks.ts'
import { useTradersRoute } from './route.ts'
import { fileProblem, watcherState, watcherText } from './wire.ts'
import { Caveats } from './caveats.tsx'
/** Problem files named in the empty state; the rest are counted. */
const PROBLEMS_SHOWN = 5

/**
 * No open book: say whether the watcher is reporting and which files did not
 * read, so an empty page is never mistaken for an empty account.
 */
function NoBooks(): React.ReactElement {
  // Wrapped: the server answers null for a watcher that never reported, and `data` is null until loaded.
  const watcher = usePoll(async () => ({ status: await tapi.watcher() }), BOOKS_POLL_MS, [])
  const files = usePoll(() => tapi.files(), BOOKS_POLL_MS, [])
  const answer = watcher.data?.status
  const w: WatcherStatus | null = typeof answer?.lastHeartbeatAt === 'number' ? answer : null
  const list: readonly StoredFile[] = Array.isArray(files.data) ? files.data : []
  const problems = list.flatMap((f) => fileProblem(f) ?? [])
  return (
    <VStack gap={2}>
      <Text color="secondary">No open books</Text>
      {watcher.data === null ? null : (
        <Text size="sm">
          {w === null
            ? 'Watcher never connected — positions come only from manual uploads'
            : `Watcher ${watcherState(w, Date.now())} — ${watcherText(w)}`}
        </Text>
      )}
      <Caveats items={problems} kind="warning" limit={PROBLEMS_SHOWN}
        more={(n) => `and ${n} more ${n === 1 ? 'file' : 'files'} with problems — /v1/traders/files lists every file`} />
    </VStack>
  )
}

/** Small marks on a book's tab (R3 adds its band chip here). */
export const BOOK_TAB_BADGES: readonly ((s: BookSummary) => React.ReactElement | null)[] = [bandBadge]

/**
 * The Books page: the book chosen by the stock tabs. Inside the shell those tabs are in its top bar (shell.tsx);
 * a Books page on its own draws them here.
 */
export function BooksPage(): React.ReactElement {
  const session = useSession()
  const [route, go] = useTradersRoute()
  const inShell = useContext(BooksContext) !== null
  const books = useBooksList()
  const list = books.data

  // An admin who has not named a trader gets a prompt, not the server's refusal.
  if (books.error !== null && list === null) {
    if (books.status === 400 && session?.role === 'admin' && session.asTrader === null) {
      return <Text color="secondary">Pick a trader to see their books</Text>
    }
    return <BellAlert status="error" inline text={`Could not load the books: ${books.error}`} />
  }
  if (list === null) return <Text color="secondary">Loading books…</Text>
  if (list.length === 0) return <NoBooks />

  const stocks = list.map((b) => b.stock)
  const active = route.stock !== null && stocks.includes(route.stock) ? route.stock : (stocks[0] as string)

  return (
    <VStack gap={3}>
      <BellAlert text={books.error === null ? null : `Refresh failed: ${books.error}`} />
      {inShell ? null : (
        <TabList role="tablist" aria-label="Books" value={active} onChange={(v) => go(`/books/${encodeURIComponent(v)}`)} layout="hug" hasDivider>
          {list.map((b) => (
            <Tab
              key={b.stock}
              role="tab"
              aria-selected={b.stock === active}
              value={b.stock}
              label={b.stock}
              endContent={
                BOOK_TAB_BADGES.length === 0 ? undefined : (
                  <>{BOOK_TAB_BADGES.map((badge, i) => <span key={i}>{badge(b)}</span>)}</>
                )
              }
            />
          ))}
        </TabList>
      )}
      {/* Keyed on the stock: switching tabs remounts, so one book never paints under another's name. */}
      <BellSource label={active}>
        <BookTab key={active} stock={active} />
      </BellSource>
    </VStack>
  )
}
