import { defineConfig } from 'vitest/config'

// Most tests are PURE functions (time math, timezone helpers), so the default Node environment is
// enough. Node 18+ ships full ICU, so the Intl 'Europe/Vilnius' formatting these helpers rely on
// works in tests. The few tests that must render React opt into jsdom per file with a
// `// @vitest-environment jsdom` docblock, so the pure suites keep their fast Node environment.
export default defineConfig({
  // Vite's React plugin is not in this pipeline, so esbuild would otherwise compile JSX with the
  // CLASSIC runtime and every rendering test would need a React import that eslint (configured for
  // `react/jsx-runtime`) then reports as unused. Match the app's automatic runtime instead.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
})
