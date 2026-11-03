/**
 * `describe_data` and `query_data`: the query language (spec §6.3) as two
 * tools. The catalogue says what can be asked; a query that names a field the
 * dataset does not have is refused with the valid ones, so the model can fix
 * it in the next step.
 */

import { z } from 'zod'
import { CATALOGUE } from '../query/catalogue.ts'
import { AGG_FNS, checkQuery, dataQuerySchema, defOf, QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT, QueryError, runQuery, WHERE_OPS, type DataQuery } from '../query/execute.ts'
import { sourceOf } from '../query/sources.ts'
import { droppedSymbols, envelope, nseRows, ToolRefusal, type AgentTool } from './ctx.ts'

const noInput = z.object({}).strict()

export const describeData: AgentTool<z.infer<typeof noInput>> = {
  name: 'describe_data',
  description: 'The datasets query_data can read: each one\'s fields with type, unit and meaning, its scope params, and whether it is available on this desk.',
  input: noInput,
  label: () => 'reading the data catalogue',
  async run(ctx) {
    return {
      result: {
        ...envelope(ctx),
        datasets: CATALOGUE.map((d) => {
          const available = d.available && sourceOf(ctx, d.name) !== null
          return {
            name: d.name, description: d.description, params: d.params, available,
            ...(available ? {} : { unavailable: d.unavailable ?? 'not on this desk' }),
            fields: d.fields.map((f) => ({ name: f.name, type: f.type, unit: f.unit, description: f.description })),
          }
        }),
        query: {
          where: WHERE_OPS, aggregate: AGG_FNS, limit: { default: QUERY_DEFAULT_LIMIT, max: QUERY_MAX_LIMIT },
          rules: 'where conditions are ANDed; with groupBy or aggregate the columns are the groupBy fields and the aggregate names (no select); over the limit you get the first rows, truncated: true and a summary of every numeric column',
        },
      },
      summary: `${CATALOGUE.length} datasets`,
    }
  },
}

export const queryData: AgentTool<DataQuery> = {
  name: 'query_data',
  description: 'Run a query over one dataset of the trader\'s own data: where / select / groupBy + aggregate / orderBy / limit. Call describe_data first for the fields.',
  input: dataQuerySchema,
  label: (q) => `query ${q.dataset}${q.params?.stock === undefined ? '' : ` ${q.params.stock}`}`,
  async run(ctx, q) {
    const def = defOf(q.dataset)
    const source = def.available ? sourceOf(ctx, def.name) : null
    if (source === null) throw new ToolRefusal(`${def.name} is not available: ${def.unavailable ?? 'not on this desk'}`)
    try {
      checkQuery(q, def)
      const got = await source(ctx, q)
      // R11: a row whose symbol is not an NSE symbol carries file text: dropped, and counted
      const clean = nseRows(got.rows, (row) => row['stock'])
      const warnings = clean.dropped === 0 ? got.warnings : [...got.warnings, droppedSymbols(clean.dropped)]
      const r = runQuery(q, clean.rows, def)
      return {
        result: { ...envelope(ctx, { ...(got.closed === undefined ? {} : { closed: got.closed }), warnings }), ...r },
        summary: `${r.dataset}: ${r.total} ${r.total === 1 ? 'row' : 'rows'}${r.truncated ? `, first ${r.rows.length}` : ''}`,
      }
    } catch (e) {
      if (e instanceof QueryError) throw new ToolRefusal(e.message)
      throw e
    }
  },
}
