import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Base styles first: without both of these every astryx component is unstyled.
import '@astryxdesign/core/reset.css'
import '@astryxdesign/core/astryx.css'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import '@astryxdesign/theme-neutral/theme.css'
// AFTER the theme, so the eye-comfort overrides win. See comfort.css.
import './comfort.css'
// Layout only, and kept apart from comfort.css because colour and width are
// re-tuned by different people at different times. See responsive.css.
import './responsive.css'
import { App } from './App.tsx'
import { useThemeMode } from './shell.tsx'

/**
 * `mode` is lifted here because `Theme` must wrap the whole tree for the token
 * swap to reach every component. Defaults to `system`, so the OS setting wins
 * until someone deliberately overrides it.
 */
function Root(): React.ReactElement {
  const [mode, setMode] = useThemeMode()
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <App themeMode={mode} onThemeMode={setMode} />
    </Theme>
  )
}

const el = document.getElementById('root')
if (el === null) throw new Error('#root missing from index.html')
createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
