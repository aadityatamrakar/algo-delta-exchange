/**
 * The frontend test runner.
 *
 * SEPARATE FROM `vite.config.ts` on purpose: `defineConfig` from `vite` does not
 * carry the `test` key, and merging them means the dev server config grows a
 * field its own types reject.
 *
 * `jsdom`, not `happy-dom`: these tests are about what an operator sees, and
 * three of them depend on `localStorage`, `location.hash` and the `storage`
 * event behaving the way a real browser's do.
 */
import { defineConfig } from 'vitest/config'

// No `@vitejs/plugin-react`: the bundler compiles JSX with the automatic
// runtime on its own here, and adding the plugin only produces deprecation
// warnings about options it can no longer set. Fast Refresh is a dev-server
// concern and there is no dev server in a test run.
export default defineConfig({
  test: {
    environment: 'jsdom',
    // THE EXTENSION PICKS THE RUNNER, and this directory holds both:
    //
    //   - `*.test.tsx` — vitest + jsdom, i.e. everything below. Anything that
    //     renders a component or touches the DOM must be `.tsx`.
    //   - `*.test.ts`  — node:test, run by the repo-root `npm run test:node`,
    //     whose glob is `apps/*/test/**/*.test.ts`. Fine for plain functions
    //     (`entry-plan.test.ts` is one); it cannot run JSX or reach a DOM.
    //
    // The two sets are disjoint and neither runner sees the other's files, so
    // a new `.test.ts` here will NOT run under `npm run test --workspace
    // @algomaker/web` no matter how green that reports. Name it `.tsx` if you
    // expect vitest to run it.
    include: ['test/**/*.test.tsx'],
    setupFiles: ['test/setup.tsx'],
    restoreMocks: true,
  },
})
