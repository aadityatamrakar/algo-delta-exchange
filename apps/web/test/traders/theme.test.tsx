/** The traders page's light/dark switch: the desk's control, persisted the desk's way. */
import { expect, test, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { useThemeMode } from '../../src/theme-mode.ts'
import { installFetch } from '../http.tsx'

afterEach(() => { window.localStorage.clear() })

/** What traders/main.tsx's Root does, minus the Theme wrapper. */
function Harness(): React.ReactElement {
  const [mode, setMode] = useThemeMode()
  return <TradersApp themeMode={mode} onThemeMode={setMode} />
}

test('the switch cycles Auto -> Light -> Dark -> Auto and the choice survives a reload', async () => {
  installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: [] }
    return { body: {} }
  })
  const first = render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: 'Theme: Auto' }))
  expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeTruthy()
  expect(window.localStorage.getItem('desk.theme')).toBe('light')

  first.unmount()
  render(<Harness />)
  fireEvent.click(await screen.findByRole('button', { name: 'Theme: Light' }))
  fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }))
  expect(screen.getByRole('button', { name: 'Theme: Auto' })).toBeTruthy()
  expect(window.localStorage.getItem('desk.theme')).toBe('system')
})
