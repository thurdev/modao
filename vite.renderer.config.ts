import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Renderer-only dev server, used to iterate on the UI in a browser without
 * booting Electron. The app falls back to a mock IPC bridge in this mode
 * (see src/renderer/devBridge.ts); production always uses the real preload.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer') } },
  plugins: [react()],
  server: { port: 5199, strictPort: true }
})
