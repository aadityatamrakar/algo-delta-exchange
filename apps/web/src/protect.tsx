/**
 * PROTECT — the lots on one contract the engine may not spend.
 *
 * The recenter engine manages the WHOLE position by default (design spec §4,
 * D12): every leg is steerable, whether the Build screen opened it, the engine
 * sold it, or a person placed it by hand. That is a deliberate reversal of the
 * Python desk, where a leg was protected or not by a flag nobody could see —
 * and it needs an opt-out, because a hedge bought for a reason must not be shed
 * as convexity the next time the band moves.
 *
 * ── THREE THINGS THIS CONTROL IS, AND ONE IT IS NOT ─────────────────────────
 *
 *   A QUANTITY, NOT A FLAG. `desk-books` legally holds one contract across
 *   several legs (three tranches of one sell), and desk-api folds them, so a
 *   per-leg flag would be pinned to an identity that does not survive the
 *   fold. The claim is `{instrument -> lots}` and the engine exempts
 *   `min(protectedQty, held)` — a partly-protected leg is shed down to its
 *   protected tail instead of being closed.
 *
 *   IN LOTS. Every quantity the engine reasons in is lots
 *   (`shiftSpendableLots` compares this against `leg.lots`), while the table
 *   this opens from shows CONTRACTS. The dialog converts and shows its working,
 *   because "3" meaning three lots of 2,625 is the kind of ambiguity that ends
 *   with a whole book pinned.
 *
 *   AN OPERATOR'S ACT, gated like one: on the live rail it costs the password,
 *   the same as retuning the book, and it is recorded in `desk-audit`. What it
 *   changes is what the desk is ALLOWED to do with a real position.
 *
 *   IT IS NOT A LOCK ON THE POSITION. Protection is exempt at SELECTION only:
 *   protected quantity is still counted in every greek, every MTM and every
 *   margin figure, and the whole-book terminal exits — target lock, expiry
 *   settle — ignore it entirely (§4). A protected leg can still be closed by
 *   hand, and will still be flattened at the end. The dialog says so, because
 *   an operator who believes this pins a leg through expiry has been told
 *   something untrue by the button's name alone.
 */

import { useState } from 'react'
import { lotsOf } from './venue.ts'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { api, type DeskMode } from './api.ts'
import { formatContract } from './contract.ts'
import { withReauth, type Reauth } from './auth.tsx'

/** What the row knows about the contract the dialog is opened for. */
export interface ProtectTarget {
  readonly tag: string
  readonly tradingsymbol: string
  /** Contracts held on this instrument, signed. Absolute lots are derived. */
  readonly qty: number
  /** Contracts per lot, from the book. 0/unknown means lots cannot be shown. */
  readonly lotSize: number
  /** Lots already pinned on this instrument. */
  readonly protectedLots: number
}

/** Held lots, absolute and truncated — the engine counts whole lots only. */
export function heldLots(qty: number, lotSize: number): number {
  if (!(lotSize > 0)) return 0
  // Snapped before truncating: 0.57 BTC / 0.001 is 569.999… and must be 570.
  return Math.trunc(lotsOf(Math.abs(qty), lotSize))
}

export function ProtectDialog(props: {
  target: ProtectTarget | null
  mode: DeskMode
  reauth: Reauth
  onClose: () => void
  /** The whole map, as the server merged it — the caller re-renders from this. */
  onSaved: (protectedQty: Readonly<Record<string, number>>) => void
}): React.ReactElement {
  const target = props.target
  const open = target !== null
  const [lots, setLots] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * The box starts at what is ALREADY pinned, not at the held size.
   *
   * `useState` alone cannot do that — the dialog is mounted once and reopened
   * for a different contract — and a stale value here would pin the wrong
   * number of lots on the wrong strike. `null` means "not yet seeded for this
   * target", which is the same trick the manual-order dialog uses for its own
   * fields.
   */
  const value = lots ?? target?.protectedLots ?? 0
  const held = target === null ? 0 : heldLots(target.qty, target.lotSize)

  const close = (): void => {
    setLots(null)
    setError(null)
    props.onClose()
  }

  async function save(): Promise<void> {
    if (target === null) return
    setBusy(true)
    setError(null)
    /**
     * LIVE ASKS FIRST, on the same condition the server gates on — `mode ===
     * 'live'` (`routes/engine.ts`). Paper asks nothing: nothing there can stop
     * the engine from managing money.
     */
    await withReauth({
      statement:
        `Pin ${value} lot(s) of ${target.tradingsymbol} on the LIVE book ${target.tag}. ` +
        `The engine will not shift, shed, scrap or close that quantity — including when the ` +
        `delta band says it should.`,
      promptFirst: props.mode === 'live',
      run: (password) =>
        api.engine.protect(target.tag, props.mode, target.tradingsymbol, value, password),
      reauth: props.reauth,
      onDone: (res) => {
        props.onSaved(res.protectedQty)
        close()
      },
      onError: (message) => setError(message),
    })
    setBusy(false)
  }

  return (
    <Dialog isOpen={open} onOpenChange={close} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title={`Protect · ${target === null ? '' : formatContract(target.tradingsymbol)}`}
            onOpenChange={close}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3}>
              <HStack gap={2} align="center" wrap="wrap">
                <Badge label={target?.tag ?? ''} />
                <Badge variant={props.mode === 'live' ? 'error' : 'neutral'} label={props.mode} />
              </HStack>
              <NumberInput
                label="Lots the engine may not spend"
                value={value}
                min={0}
                isIntegerOnly
                onChange={setLots}
                description={
                  target === null || target.lotSize <= 0
                    ? 'This book states no lot size, so the held size cannot be shown in lots.'
                    : `This contract holds ${held} lot(s) — ${Math.abs(target.qty)} contracts of ` +
                      `${target.lotSize}. 0 releases it entirely.`
                }
              />
              {value > held && held > 0 ? (
                <Banner
                  status="warning"
                  title="More lots than this book holds"
                  description={
                    `The engine clamps a claim to the position (it protects ${held}), so this is ` +
                    'not dangerous — but a claim larger than the leg usually means the wrong ' +
                    'number was typed.'
                  }
                />
              ) : null}
              <Text size="sm" color="secondary">
                Protected quantity is exempt from the engine&apos;s own selection only. It is
                still in every greek, every MTM and every margin figure, it can still be closed
                by hand, and the whole-book exits — the target lock and the expiry settle —
                ignore protection entirely.
              </Text>
              {error !== null ? (
                <Banner status="error" title="Not applied" description={error} />
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={close} />
              <Button
                variant={props.mode === 'live' ? 'destructive' : 'primary'}
                label={busy ? 'Applying…' : value === 0 ? 'Release this leg' : `Protect ${value} lot(s)`}
                isDisabled={busy}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
