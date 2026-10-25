import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  base: './',
  define: { __WARDEN_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true }
})
