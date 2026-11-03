import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// No StyleX plugin: astryx ships compiled CSS and its own guidance is explicit
// that there is no StyleX/Tailwind compiler in a consuming app.
export default defineConfig({
  plugins: [react()],
  server: { port: 5184 },
})
