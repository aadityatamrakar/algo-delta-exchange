/** pm2 launcher for apps/api/src/web-server.ts (explicit main(), see desk-bridge.mjs). */
import { main } from '../apps/api/src/web-server.ts'

main().catch((err) => {
  console.error('[dx-web] fatal', err)
  process.exit(1)
})
