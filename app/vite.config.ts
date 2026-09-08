/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Content-Security-Policy for the published build (GitHub Pages cannot set headers, so it goes in as a meta tag):
// scripts only from the app itself, network only to Supabase, no frames, no plugins.
function csp(supabaseUrl: string) {
  return {
    name: 'proaid-csp',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      if (ctx.server) return html; // dev server injects its own inline scripts
      const supa = supabaseUrl.replace(/\/$/, '');
      const ws = supa.replace(/^http/, 'ws');
      const policy = [
        "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
        `connect-src 'self' ${supa} ${ws}`, `img-src 'self' data: blob: ${supa}`, "font-src 'self' data:",
        "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "worker-src 'self'", "manifest-src 'self'",
      ].join('; ');
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}">\n    <meta name="referrer" content="no-referrer">`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE || '/',
  plugins: [
    csp(loadEnv(mode, process.cwd(), '').VITE_SUPABASE_URL || ''),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'],
      manifest: {
        name: 'Pro Aid',
        short_name: 'Pro Aid',
        description: 'Pharmacy cash control',
        theme_color: '#0f766e',
        background_color: '#f4f7f7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        runtimeCaching: [{ urlPattern: ({ url }) => url.pathname.includes('/storage/v1/'), handler: 'CacheFirst', options: { cacheName: 'proofs', expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 } } }],
      },
    }),
  ],
  server: { port: 5173, host: true },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
}))
