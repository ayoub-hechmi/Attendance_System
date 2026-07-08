import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'

function tryLoadHttps() {
  try {
    return {
      key:  fs.readFileSync('./key.pem'),
      cert: fs.readFileSync('./cert.pem'),
    }
  } catch {
    return undefined  // fall back to HTTP if certs aren't generated yet
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5174,
    https: tryLoadHttps(),
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
