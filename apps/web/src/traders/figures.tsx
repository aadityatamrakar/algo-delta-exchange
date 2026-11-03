/**
 * The Analysis tab's plain typography: unboxed sections, label/value figures in tabular digits, and the ⓘ that
 * holds a figure's explanation or source — the same words, on hover, and under the section on a click.
 */

import { useState, type ReactElement, type ReactNode } from 'react'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { MetadataList } from '@astryxdesign/core/MetadataList'
import { Text } from '@astryxdesign/core/Text'
import './figures.css'

/** Digits of one width, so figures in a column line up. */
export const NUM: Readonly<Record<string, string>> = { fontVariantNumeric: 'tabular-nums' }

/** A small figure in tabular digits, toned by `style` (sign colours). */
export function Num(props: { readonly children: ReactNode; readonly style?: Readonly<Record<string, string>> | undefined }): ReactElement {
  return <Text size="sm" style={{ ...NUM, ...(props.style ?? {}) }}>{props.children}</Text>
}

/** Label/value rows, compact: one baseline each, close together (figures.css). */
export const FIGURES_CLASS = 'traders-figures'

export function FigureList(props: { readonly children: ReactNode }): ReactElement {
  return <MetadataList columns="single" label={{ position: 'start' }} className={FIGURES_CLASS}>{props.children}</MetadataList>
}

/** A label above its value. */
export function Figure(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <VStack gap={0}>
      <Text size="sm" color="secondary">{props.label}</Text>
      <Text weight="bold" style={NUM}>{props.value}</Text>
    </VStack>
  )
}

export interface Info { readonly button: ReactElement | null; readonly text: ReactElement | null }

/** The ⓘ for `about` (its button) and the words it opens (placed by the caller). No lines, no ⓘ. */
export function useInfo(about: string, lines: readonly string[]): Info {
  const [open, setOpen] = useState(false)
  if (lines.length === 0) return { button: null, text: null }
  return {
    button: (
      <Button variant="ghost" size="sm" isIconOnly label={`About ${about}`} tooltip={lines.join(' · ')}
        icon={<Icon icon="info" size="sm" color="inherit" />} aria-expanded={open} onClick={() => setOpen((o) => !o)} />
    ),
    text: open ? <VStack gap={0}>{lines.map((l, i) => <Text key={`${i}:${l}`} size="sm" color="secondary">{l}</Text>)}</VStack> : null,
  }
}

/** An unboxed section: its name (and unit) in small bold type, an optional ⓘ, then its figures. */
export function Block(props: {
  readonly name: string
  readonly unit?: string
  readonly info?: { readonly about?: string; readonly lines: readonly string[] }
  readonly children: ReactNode
}): ReactElement {
  const info = useInfo(props.info?.about ?? props.name, props.info?.lines ?? [])
  return (
    <VStack gap={1} role="group" aria-label={props.name}>
      <HStack gap={1} align="center">
        <Text size="sm" weight="bold">{props.unit === undefined ? props.name : `${props.name} (${props.unit})`}</Text>
        {info.button}
      </HStack>
      {info.text}
      {props.children}
    </VStack>
  )
}
