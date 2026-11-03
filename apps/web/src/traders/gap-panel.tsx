/**
 * VolHedge v50's Gap Up Down panel: two editable rows (price move %, vol
 * change in points) priced by the server at the next open, the Ltp and Vol
 * ticks, and which price the options' vols are solved against. The panel only
 * edits the request; the figures are the server's, and its note sits behind the ⓘ.
 */

import { useEffect, useRef, type ReactElement } from 'react'
import { HStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Text } from '@astryxdesign/core/Text'
import { money, sign } from '../format.ts'
import type { AnalysisView, GapInput, VolBasis } from '../../../traders/src/analytics/wire.ts'
import type { AnalysisInputs } from './viewer.ts'
import { Block, NUM } from './figures.tsx'

export type GapInputs = Pick<AnalysisInputs, 'gap' | 'gapUseLtp' | 'gapUseVol' | 'volBasis'>

/** The server's limit on either figure of a row. */
const GAP_LIMIT = 50

export function GapPanel(props: {
  readonly panel: AnalysisView['gapPanel']
  readonly state: GapInputs
  onChange(p: Partial<GapInputs>): void
  onCalculate(): void
}): ReactElement {
  const { panel, state, onChange } = props
  const calculate = useRef(props.onCalculate)
  calculate.current = props.onCalculate

  // Alt+C, as the button says. `code` too: on a Mac Option+C types `ç`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && (e.code === 'KeyC' || e.key.toLowerCase() === 'c')) {
        e.preventDefault()
        calculate.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setRow = (i: number, g: Partial<GapInput>): void =>
    onChange({ gap: state.gap.map((r, k) => (k === i ? { ...r, ...g } : r)) })
  // At most one basis tick is on; neither means the future.
  const setBasis = (b: VolBasis, on: boolean): void => onChange({ volBasis: on ? b : 'future' })

  return (
    <Block name="Gap Up Down" info={{ lines: [panel.note] }}>
      <HStack gap={4}>
        <CheckboxInput label="Ltp" size="sm" value={state.gapUseLtp} onChange={(v) => onChange({ gapUseLtp: v })} />
        <CheckboxInput label="Vol" size="sm" value={state.gapUseVol} onChange={(v) => onChange({ gapUseVol: v })} />
      </HStack>
      {state.gap.map((g, i) => {
        const name = `Scenario-${i + 1}`
        // Matched by its inputs: the server skips a row it cannot price, and a row being edited has no answer yet.
        const r = panel.rows.find((x) => x.movePct === g.movePct && x.volPts === g.volPts)
        return (
          <HStack key={name} gap={2} align="center" wrap="wrap">
            <Text size="sm" color="secondary">{name}</Text>
            <NumberInput label={`${name} price %`} isLabelHidden size="sm" width={72} min={-GAP_LIMIT} max={GAP_LIMIT}
              value={g.movePct} onChange={(n) => setRow(i, { movePct: n })} />
            <NumberInput label={`${name} vol pts`} isLabelHidden size="sm" width={72} min={-GAP_LIMIT} max={GAP_LIMIT}
              value={g.volPts} onChange={(n) => setRow(i, { volPts: n })} />
            <Text size="sm" weight="bold" style={r === undefined ? NUM : { ...NUM, ...sign(r.pnl) }}>{r === undefined ? '—' : money(r.pnl)}</Text>
            {r === undefined ? null : <Text size="sm" color="secondary" style={NUM}>{`vs value now ${money(r.change)}`}</Text>}
          </HStack>
        )
      })}
      <HStack gap={4} align="center" wrap="wrap">
        <Button size="sm" variant="secondary" label="Calculate (Alt+C)" onClick={() => props.onCalculate()} />
        <CheckboxInput label="Cal Vol Using EQ" size="sm" value={state.volBasis === 'cash'} onChange={(v) => setBasis('cash', v)} />
        <CheckboxInput label="Cal Vol Using syn future" size="sm" value={state.volBasis === 'synthetic'} onChange={(v) => setBasis('synthetic', v)} />
      </HStack>
    </Block>
  )
}
