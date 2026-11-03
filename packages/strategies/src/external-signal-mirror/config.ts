export interface ExternalSignalMirrorConfig {
  readonly tag: string
  readonly destinationTag: string
  /** Secret-store key — NEVER an inline credential (all 3 legacy files leak one today). */
  readonly credentialsRef: string
  readonly instrumentRefreshMinutes: number
  readonly onUnknownSymbol: 'drop-and-alert' | 'throw'
}
