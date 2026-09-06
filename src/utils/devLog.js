/**
 * devLog — a console trace that exists ONLY in development.
 *
 * WHY. Diagnostic `console.log` calls were shipping in the production bundle, and two of them
 * printed the signed-in user's e-mail address on every login. WORKZ runs on shared phones and
 * office desktops, where the browser console is not a private surface — so identifying data must
 * not be written to it in a build a worker uses. The traces themselves are worth keeping: the
 * sign-in path (popup vs redirect, iOS standalone, Opera) is the hardest flow in the app to debug
 * without them.
 *
 * `import.meta.env.DEV` is a literal Vite replaces at build time, so in production this collapses
 * to a dead branch the minifier removes — no runtime cost, and the argument expressions are never
 * evaluated either.
 *
 * This is for TRACES, not for failures. Anything that must survive to be diagnosed later belongs
 * in `logError` (utils/errorLog.js), the durable crash log.
 */
export const devLog = (...args) => {
    if (import.meta.env.DEV) console.log(...args);
};

export default devLog;
