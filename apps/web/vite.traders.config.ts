import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The second page. Built apart from the desk (its own outDir) so the desk's
// dist/ never holds traders.html and a deploy of one cannot ship the other.
export default defineConfig({
  base: '/traders/',
  // Copied as-is, unhashed, to dist-traders/: the service worker (/traders/sw.js, scope /traders/), the web app
  // manifest and its icons. Its own folder, so the desk's build (public/) never ships them.
  publicDir: 'public-traders',
  plugins: [react()],
  server: { port: 5185 },
  build: {
    outDir: 'dist-traders',
    emptyOutDir: true,
    rollupOptions: { input: 'traders.html' },
  },
})
