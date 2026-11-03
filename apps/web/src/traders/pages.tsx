/** The top-level pages. Later releases append here (Market Watch, Range, Portfolio). */

import { AdminPage } from './admin.tsx'
import { BooksPage } from './books.tsx'
import { DailyPage } from './daily.tsx'
import { MarketWatchPage } from './market-watch.tsx'
import { OrdersPage } from './orders.tsx'
import { PortfolioPage } from './portfolio.tsx'
import { RiskPage } from './risk.tsx'
import { RangePage } from './range-page.tsx'
import { VolPage } from './vol.tsx'

export interface TradersPage {
  readonly id: string
  readonly label: string
  readonly adminOnly?: true
  render(): React.ReactElement
}

/**
 * Books, the day's orders and trades, and the admin's trader management. Booked (booked.tsx) is not listed: hidden on
 * 23 Oct 2026 at the operator's request, so it has no menu entry, no `g` key and no route (its URL opens Books).
 */
export const PAGES: readonly TradersPage[] = [
  { id: 'books', label: 'Books', render: () => <BooksPage /> },
  { id: 'orders', label: 'Orders', render: () => <OrdersPage /> },
  { id: 'market', label: 'Market Watch', render: () => <MarketWatchPage /> },
  { id: 'range', label: 'Range', render: () => <RangePage /> },
  { id: 'portfolio', label: 'Portfolio', render: () => <PortfolioPage /> },
  { id: 'risk', label: 'Risk', render: () => <RiskPage /> },
  { id: 'vol', label: 'Vol', render: () => <VolPage /> },
  { id: 'daily', label: 'Daily', render: () => <DailyPage /> },
  { id: 'admin', label: 'Admin', adminOnly: true, render: () => <AdminPage /> },
]
