import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.jpg', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'Viduramžiai.LT WORKZ',
        short_name: 'WORKZ',
        description: 'Productivity App',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      devOptions: {
        enabled: true
      }
    })
  ],
  build: {
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
