import { defineConfig } from 'vitest/config'

// Minimal Vitest setup. The first tests are PURE functions (time math, timezone
// helpers), so the default Node environment is enough — no jsdom needed. Node 18+
// ships full ICU, so the Intl 'Europe/Vilnius' formatting these helpers rely on works
// in tests. Add `environment: 'jsdom'` later if/when component tests are introduced.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
})
