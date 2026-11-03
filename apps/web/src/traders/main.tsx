import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Base styles first: without both of these every astryx component is unstyled.
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import '@astryxdesign/theme-neutral/theme.css'
// AFTER the theme, so the eye-comfort overrides win.
import '../comfort.css'
import '../responsive.css'
import './tables.css'
import './shell.css'
import { useThemeMode } from '../theme-mode.ts'
import { TradersApp } from './app.tsx'
import { useTextSize } from './text-size.ts'

/** `mode` is lifted here, as on the desk page, because `Theme` must wrap the whole tree. Defaults to the OS setting. */
function Root(): React.ReactElement {
  const [mode, setMode] = useThemeMode()
  useTextSize()   // applies the stored text size from the login page on
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <TradersApp themeMode={mode} onThemeMode={setMode} />
    </Theme>
  )
}

const el = document.getElementById('root')
if (el === null) throw new Error('#root missing from traders.html')
createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
