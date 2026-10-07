import { defineConfig, type Plugin, loadEnv } from 'vite'
import { createApiHandler } from './src/server/api-handler.ts'
import { createAuthGate } from './src/server/auth-gate.ts'

function apiPlugin(env: Record<string, string>): Plugin {
  // Contsystem Manager login + role gate (ACC_DB_AUTH=manager); runs before static files and the API.
  const gate = createAuthGate(env)
  const handler = createApiHandler(env, gate)
  if (gate.enabled) {
    console.log(`[acc-db auth] gate ON — Manager session cookie ${gate.config.cookieName} @ ${gate.config.endpoint} (project ${gate.config.projectId}), roles: ${gate.config.allowedRoles.join(', ')}`)
  } else {
    console.log('[acc-db auth] gate OFF (set ACC_DB_AUTH=manager to require the Manager login)')
  }
  console.log(`[acc-db chat] Ollama ${env.OLLAMA_URL || 'http://ollama:11434'} · model ${env.OLLAMA_MODEL || 'qwen2.5:3b'}`)
  return {
    name: 'acc-db-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void gate.middleware(req, res, next)
      })
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next)
      })
    },
    configurePreviewServer(server) {
      handler.onServerStart()
      server.middlewares.use((req, res, next) => {
        void gate.middleware(req, res, next)
      })
      // Hashed build assets (JS/CSS/woff2/PNG) never change under the same name → cache them for a year.
      // vite preview's static server sends `no-cache` via writeHead, so override it there.
      server.middlewares.use((req, res, next) => {
        if (/^\/acc-db\/assets\/[^/?]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2|png)(?:\?|$)/.test(req.url ?? '')) {
          const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => typeof res
          res.writeHead = ((code: number, ...rest: unknown[]) => {
            if (code === 200 || code === 304) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
            const hdrs = rest.find((r) => r && typeof r === 'object') as Record<string, unknown> | undefined
            if (hdrs && (code === 200 || code === 304)) {
              for (const k of Object.keys(hdrs)) if (k.toLowerCase() === 'cache-control') delete hdrs[k]
            }
            return writeHead(code, ...rest)
          }) as typeof res.writeHead
        }
        next()
      })
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
