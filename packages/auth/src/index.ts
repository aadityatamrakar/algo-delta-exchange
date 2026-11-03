/**
 * `@algomaker/auth` — the crypto and policy half of Phase A access control
 * (spec §3): argon2id password hashing, session token mint/expiry, and login
 * lockout.
 *
 * Deliberately pure. No database, no HTTP, no clock, no config loading. The
 * routes in the portal own persistence and transport; this package owns only
 * the decisions, so every one of them is testable in milliseconds against an
 * injected `now`.
 */

export * from './password.ts'
export * from './session.ts'
export * from './lockout.ts'
