import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}
export function read(name: string): string { return readFileSync(fixture(name), 'utf8') }
