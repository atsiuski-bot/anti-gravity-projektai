import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // The worker is hand-written (src/sw.js) rather than generated, because `generateSW` cannot
      // express a catch handler for the navigation route — and without one a failed navigation
      // rejects into the browser as ERR_FAILED, i.e. the app appears dead instead of offline.
      // See src/sw.js for the full reasoning.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      includeAssets: ['logo-mark.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-192x192-maskable.png', 'pwa-512x512-maskable.png'],
      injectManifest: {
        // Bundle the worker as a CLASSIC script, not an ES module. Module service workers need
        // Chrome 91+ / Safari 15.4+ / Firefox 114+, which is far above this app's support floor
        // (see package.json browserslist — iOS 14). A module worker would simply fail to register
        // on those phones, silently removing offline support from exactly the field devices that
        // need it. The generated worker was classic; this keeps it that way.
        rollupFormat: 'iife',
        // The app shell. The icons and the web manifest are NOT listed here on purpose — they
        // reach the precache through `includeAssets` above, and matching them twice would put
        // duplicate entries in the manifest.
        globPatterns: ['**/*.{js,css,html}'],
        // The FCM service worker is a SEPARATE worker (registered by the messaging SDK at its own
        // scope). Keep Workbox from precaching/serving it so the two never collide. Also skip the
        // iOS splash set — 20 device-specific PNGs of which any one device only ever uses one, so
        // precaching them all would bloat the offline cache for no benefit (iOS fetches the matching
        // splash at launch).
        globIgnores: ['**/firebase-messaging-sw.js', '**/splash/**']
      },
      manifest: {
        name: 'Gildija',
        short_name: 'Gildija',
        description: 'Darbo laiko apskaitos programa',
        lang: 'lt',
        // Pin install identity + scope explicitly (these previously defaulted). `id` keeps the
        // installed app stable across any future start_url change so browsers treat updates as the
        // same app, not a second install; scope/start_url anchor the standalone window to the root.
        id: '/',
        start_url: '/',
        scope: '/',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Maskable variants are padded to the safe zone (logo on a full-bleed brand field) so
          // Android adaptive launchers no longer clip the top "W" / bottom wordmark. The previous
          // maskable entry pointed at the edge-to-edge pwa-512 and DID clip. Regenerate via
          // scripts/generate-pwa-assets.cjs.
          { src: 'pwa-192x192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-512x512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      devOptions: {
        enabled: true,
        // The hand-written worker is an ES module (it imports workbox), so dev must serve it as one.
        type: 'module'
      }
    })
  ],
  build: {
    // Pin the JS output floor to mirror package.json "browserslist" (Vite does NOT read browserslist
    // for build.target on its own). This equals the previous implicit 'modules' default, but is now
    // explicit and stable — a dependency/Tailwind bump can no longer silently raise the floor.
    target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core
          if (id.includes('node_modules/react/') || 
              id.includes('node_modules/react-dom/') || 
              id.includes('node_modules/react-router') ||
              id.includes('node_modules/scheduler/')) {
            return 'react-vendor';
          }
          // Firebase Auth
          if (id.includes('node_modules/firebase/') || 
              id.includes('node_modules/@firebase/')) {
            if (id.includes('/auth/') || id.includes('/auth-')) {
              return 'firebase-auth';
            }
            if (id.includes('/storage/') || id.includes('/storage-')) {
              return 'firebase-storage';
            }
            // Firestore + core firebase
            return 'firebase-firestore';
          }
          // lucide icons
          if (id.includes('node_modules/lucide-react/')) {
            return 'lucide-icons';
          }
          // react-big-calendar is heavy (~115 KB gz) and only used by the calendar
          // views. Give it its own chunk so it is no longer auto-merged into an
          // unrelated lazy chunk (it was being attributed to TaskTimeLimitPopup) and so
          // it is cached/loaded independently of the rest of the app.
          if (id.includes('node_modules/react-big-calendar/')) {
            return 'calendar-vendor';
          }
          // date-fns is used both by the calendar and by app-wide utils
          // (calendarNotifications); keep it in its own chunk so the broad util users
          // do NOT transitively pull in react-big-calendar.
          if (id.includes('node_modules/date-fns/')) {
            return 'date-vendor';
          }
          // Other smaller vendor libs
          if (id.includes('node_modules/clsx/') ||
              id.includes('node_modules/tailwind-merge/') ||
              id.includes('node_modules/react-swipeable/')) {
            return 'utils-vendor';
          }
        }
      }
    },
    chunkSizeWarningLimit: 500
  },
  server: {
    host: true // Allow access from network (for mobile testing)
  }
})
