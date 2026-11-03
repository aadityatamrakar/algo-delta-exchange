/** The trader's open books, polled once by the shell (its stock tabs) and read by the Books page. */

import { createContext, useContext } from 'react'
import type { BookSummary } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { usePoll, type Polled } from './hooks.ts'

export const BOOKS_POLL_MS = 15_000

export const BooksContext = createContext<Polled<readonly BookSummary[]> | null>(null)

/** The shell's shared poll when there is one, else this component's own. */
export function useBooksList(): Polled<readonly BookSummary[]> {
  const shared = useContext(BooksContext)
  const own = usePoll<readonly BookSummary[]>(() => tapi.books(), BOOKS_POLL_MS, [], shared === null)
  return shared ?? own
}
