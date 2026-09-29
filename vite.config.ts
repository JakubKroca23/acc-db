import { defineConfig, type Plugin, loadEnv } from 'vite'
import { createApiHandler } from './src/server/api-handler.ts'

function apiPlugin(env: Record<string, string>): Plugin {
  const handler = createApiHandler(env)
  return {
    name: 'acc-db-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string>
  return {
    base: '/acc-db/',
    plugins: [apiPlugin(env)],
    server: { port: 5173, host: true },
    preview: {
      port: 4173,
      host: true,
      allowedHosts: ['zakazky.contsystem.cz', 'localhost'],
    },
  }
})
