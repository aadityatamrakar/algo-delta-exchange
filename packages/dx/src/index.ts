export { signRequest, signWsAuth } from './sign.ts'
export { DxRest, DxApiError, buildQuery, type DxRestOptions } from './rest.ts'
export {
  DxPublicSocket,
  DxPrivateSocket,
  type DxSocketOptions,
  type DxPrivateSocketOptions,
  type DxSocketState,
  type DxPublicChannel,
  type DxPrivateChannel,
} from './socket.ts'
export {
  toInstrumentRow,
  toInstrumentRows,
  spotInstrumentRow,
  quoteFromTicker,
  parseFrame,
  parseFrames,
  num,
  DX_EXCHANGE,
  DX_OPTION_SEGMENT,
  DX_INDEX_SEGMENT,
  DX_SPOT_SYMBOL,
  type DxQuote,
  type DxFrame,
} from './normalise.ts'
export { optionFee, DX_OPTION_FEE_RATES, type OptionFeeRates } from './fees.ts'
export { contractsOf, qtyOfContracts } from './qty.ts'
export {
  DxAdapter,
  DxOrderError,
  dxClientOrderId,
  mapStatus,
  type DxAdapterOptions,
  type DxTradingClient,
} from './adapter.ts'
export type * from './types.ts'
export {
  DX_PROD_REST_URL,
  DX_PROD_WS_URL,
  DX_DEMO_REST_URL,
  DX_DEMO_WS_URL,
  DX_DEMO_PUBLIC_WS_URL,
  assertRailHost,
  isDemoHost,
  isProdHost,
  type DxCredentialRail,
} from './hosts.ts'
