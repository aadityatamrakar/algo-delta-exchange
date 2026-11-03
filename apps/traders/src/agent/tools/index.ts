/**
 * The assistant's tools, in the order the model is shown them. The order and
 * the descriptions are part of the cached prompt prefix (spec §6.1): change
 * them only on purpose — every change re-writes every trader's cache once.
 *
 * get_risk (the Risk page's view) sits right after get_portfolio, its whole-desk sibling.
 * get_market_context (Lane 2's deps.marketContext) sits right after get_book:
 * the prompt has the model read the two first when asked about a book.
 *
 * The adjustment tools (adjust.ts, on Lane 1's objective search) come after
 * the readers: search_adjustments, neutralize_delta, evaluate_adjustment and
 * scenario_grid. Their cards go out through `ToolOutcome.cards`, their plans
 * into the conversation's PlanCache, and a search sets `search: true` (R10).
 *
 * get_track_record (the trader's own series and their P&L, spec 2026-11-01 P4)
 * sits right after get_events, with the other readers. read_playbook (P2) is
 * LAST: the prompt's playbook index names it. Both re-write the cached prefix
 * once (get_track_record moves every tool after it).
 */

import type { AgentDeps, AnyTool } from './ctx.ts'
import { evaluateAdjustment, neutralizeDelta, scenarioGrid, searchAdjustments } from './adjust.ts'
import { getAdvice, getBook, getMargin } from './book.ts'
import { getChain } from './chain.ts'
import { getMarketContext } from './market.ts'
import { describeData, queryData } from './data.ts'
import { getEvents } from './events.ts'
import { readPlaybook } from './playbook.ts'
import { comparePlans } from './plans.ts'
import { getPortfolio } from './portfolio.ts'
import { getRepairs } from './repairs.ts'
import { getRisk } from './risk.ts'
import { getTrackRecord } from './track-record.ts'

export const AGENT_TOOLS: readonly AnyTool[] = [
  getPortfolio, getRisk, getBook, getMarketContext, getMargin, getChain, getAdvice, getRepairs, getEvents, getTrackRecord,
  searchAdjustments, neutralizeDelta, evaluateAdjustment, scenarioGrid, comparePlans, describeData, queryData, readPlaybook,
]

/** The tools for this app's deps. */
export function agentTools(_deps: AgentDeps): readonly AnyTool[] {
  return AGENT_TOOLS
}
