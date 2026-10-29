import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

/**
 * `src/shared` is platform-neutral by construction — its files import nothing
 * from Node — so the phone builds the same Scry report, the same service list and
 * the same address rules the desktop does. A copy under `mobile/src` would be a
 * second list to forget to update.
 */
const shared = fileURLToPath(new URL('../src/shared', import.meta.url))

export default defineConfig({
  base: './',
  define: { __WARDEN_VERSION__: JSON.stringify(pkg.version) },
  resolve: { alias: { '@shared': shared } },
  // The dev server serves files from this folder's root; `../src/shared` is
  // outside it, so it has to be allowed explicitly.
  server: { fs: { allow: ['..'] } },
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true }
})
