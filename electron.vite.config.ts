import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = { '@shared': resolve('src/shared') }

// CSP chặt chỉ áp cho bản build. Bản dev cần inline script của React Refresh.
// xterm.js tự chèn thẻ <style> nên style-src phải có 'unsafe-inline'.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function injectCsp(): Plugin {
  return {
    name: 'shellhouse:csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'session-host': resolve('src/session-host/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    resolve: {
      alias: { ...alias, '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), injectCsp()],
    build: {
      // electron-vite mặc định không minify → bundle 2,5 MB mang cả nhánh development của React.
      // Minify loại nhánh chết (process.env.NODE_ENV), giảm thời gian parse lúc mở app.
      minify: 'esbuild',
      // Chromium của Electron luôn mới — không cần hạ cú pháp.
      target: 'esnext'
    }
  }
})
