module.exports = {
    root: true,
    env: { node: true, es2021: true },
    parserOptions: { ecmaVersion: 2021, sourceType: 'commonjs' },
    extends: ['eslint:recommended'],
    rules: {
        'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
};
