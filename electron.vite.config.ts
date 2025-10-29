import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import autoprefixer from 'autoprefixer'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    css: {
      postcss: {
        plugins: [tailwindcss, autoprefixer]
      }
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve('src/renderer/index.html'),
          search: resolve('src/renderer/search.html')
        }
      }
    }
  }
})
