import type { ExternalSignalMirrorConfig } from './config.ts'

// destinationTag values copied verbatim from the legacy trackOrder() calls
// (candlestrategy.js:84 "1PBUY", -a006.js "A006", -test3.js "EMA2050") and
// from the migration ledger (design spec, context/strategy-specs/00-taxonomy.md section 6.1).
export const MIRROR_1PBUY: ExternalSignalMirrorConfig = {
  tag: 'Mirror_1PBUY', destinationTag: '1PBUY', credentialsRef: 'optionbhai/1pbuy',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
export const MIRROR_A006: ExternalSignalMirrorConfig = {
  tag: 'Mirror_A006', destinationTag: 'A006', credentialsRef: 'optionbhai/a006',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
export const MIRROR_A010: ExternalSignalMirrorConfig = {
  tag: 'Mirror_A010', destinationTag: 'A010', credentialsRef: 'optionbhai/a010',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
export const MIRROR_EMA2050: ExternalSignalMirrorConfig = {
  tag: 'Mirror_EMA2050', destinationTag: 'EMA2050', credentialsRef: 'optionbhai/test3',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
