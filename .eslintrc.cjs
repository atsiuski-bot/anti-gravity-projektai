module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  // `public/__` is Firebase's own minified sign-in helper, vendored verbatim so the iOS handshake
  // is first-party (docs/runbooks/firebase-auth-helper-selfhost.md). It is third-party build
  // output we must be able to re-download byte-for-byte, so linting it is meaningless — and the
  // gate runs at --max-warnings 0, where a few hundred findings in code we do not own would block
  // every unrelated change.
  ignorePatterns: ['dist', '.eslintrc.cjs', 'dev-dist', 'tailwind.config.js', 'postcss.config.js', 'vite.config.js', 'vitest.config.js', 'functions', 'public/firebase-messaging-sw.js', 'public/__'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  rules: {
    'react/prop-types': 'off',
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
  },
}
