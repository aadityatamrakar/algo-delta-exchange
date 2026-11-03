/**
 * The margin figures, as VolHedge v50 has them: total in lakhs, initial, exposure, cash-segment and peak margin,
 * from NSE's own SPAN and exposure files. The files' names sit behind the section's ⓘ, the peak's own line behind
 * its ⓘ; a stale SPAN file is said in yellow, in view. No file, no figure: the server's sentence instead of an
 * estimate (spec item 15). A figure that leaves out a contract or a rate says `(partial)` beside it.
 */

import type { ReactElement } from 'react'
import { HStack } from '@astryxdesign/core/Layout'
import { MetadataListItem } from '@astryxdesign/core/MetadataList'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { inr } from '../format.ts'
import type { MarginView } from '../../../traders/src/analytics/wire.ts'
import { orDash } from './wire.ts'
import { Caveats } from './caveats.tsx'
import { Block, FigureList, NUM, Num, useInfo } from './figures.tsx'

const NOT_COMPUTED = { title: 'cash-segment margin is not computed' }

export function MarginBox(props: { readonly margin: MarginView | null; readonly error: string | null }): ReactElement {
  const m = props.margin
  const files = m === null ? [] : [
    ...(m.span === null || m.stale ? [] : [m.span.label]),
    ...(m.exposureFile === null ? [] : [m.exposureFile.label]),
  ]
  const peak = useInfo('Peak', m === null || m.peak === null ? [] : [m.peak.label])
  return (
    <Block name="Margin" unit="₹" info={{ about: 'the margin files', lines: files }}>
      <FigureList>
        <MetadataListItem label="Total (lakh)">
          <Text weight="bold" style={NUM}>{m === null || m.total === null ? '—' : `${inr(m.total / 1e5, 2)}${m.missing.length > 0 ? ' (partial)' : ''}`}</Text>
        </MetadataListItem>
        <MetadataListItem label="Initial"><Num>{orDash(m?.initial ?? null, 0)}</Num></MetadataListItem>
        <MetadataListItem label="Exposure"><Num>{orDash(m?.exposure ?? null, 0)}</Num></MetadataListItem>
        <MetadataListItem label="Cash (EQ)"><Text size="sm" {...NOT_COMPUTED}>—</Text></MetadataListItem>
        <MetadataListItem label="Peak">
          <HStack gap={1} align="center"><Num>{m === null || m.peak === null ? '—' : inr(m.peak.total)}</Num>{peak.button}</HStack>
        </MetadataListItem>
      </FigureList>
      {peak.text}
      {m === null || m.span === null || !m.stale ? null : <HStack><Token size="sm" color="yellow" label={m.span.label} /></HStack>}
      <Caveats items={m?.notes ?? []} kind="note" />
      {props.error === null ? null : (
        <Text size="sm" color="secondary">{`${m === null ? 'Margin did not load' : 'Margin did not refresh'}: ${props.error}`}</Text>
      )}
    </Block>
  )
}
