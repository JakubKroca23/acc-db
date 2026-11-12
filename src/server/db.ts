import pg from 'pg'

type GlobalPool = typeof globalThis & {
  __accDbPool?: pg.Pool
  __accDbPoolUrl?: string
}

function parseHostPortDb(rawUrl: string): { host?: string; port?: number; database?: string } {
  const m = rawUrl.match(/@([^/:?]+)(?::(\d+))?\/([^?\s]+)/)
  if (!m) return {}
  return {
    host: m[1],
    port: m[2] ? Number(m[2]) : undefined,
    database: m[3] ? decodeURIComponent(m[3]) : undefined,
  }
}

/**
 * Prefer discrete POSTGRES_* (password may contain ?, @, # …).
 * Fall back to DATABASE_URL; if the URL is invalid because the password
 * was not percent-encoded, rebuild it from POSTGRES_PASSWORD when available.
 */
function resolveConnection(
  env: Record<string, string | undefined> = process.env,
): { connectionString?: string; config?: pg.PoolConfig; key: string } | null {
  const user = (env.POSTGRES_USER || '').trim()
  const password = env.POSTGRES_PASSWORD ?? ''
  const databaseEnv = (env.POSTGRES_DB || '').trim()
  const rawUrl = (env.DATABASE_URL || '').trim()
  const fromUrl = rawUrl ? parseHostPortDb(rawUrl) : {}

  const host = (env.POSTGRES_HOST || '').trim() || fromUrl.host || ''
  const port = Number(env.POSTGRES_PORT || 0) || fromUrl.port || undefined
  const database = databaseEnv || fromUrl.database || ''

  if (user && database && password !== '' && host) {
    const p = port || 5432
    const config: pg.PoolConfig = { user, password, host, port: p, database }
    return { config, key: `pg://${user}@${host}:${p}/${database}` }
  }

  if (rawUrl) {
    try {
      // eslint-disable-next-line no-new
      new URL(rawUrl)
      return { connectionString: rawUrl, key: rawUrl }
    } catch {
      if (user && database && password !== '') {
        const h = host || '127.0.0.1'
        const p = port || 5432
        const config: pg.PoolConfig = { user, password, host: h, port: p, database }
        return { config, key: `pg://${user}@${h}:${p}/${database}` }
      }
      return { connectionString: rawUrl, key: rawUrl }
    }
  }

  if (user && database && password !== '') {
    const h = host || '127.0.0.1'
    const p = port || 5432
    const config: pg.PoolConfig = { user, password, host: h, port: p, database }
    return { config, key: `pg://${user}@${h}:${p}/${database}` }
  }

  return null
}

/** Shared Pool across Vite HMR reloads (avoids leaking connections). */
export function getPool(env: Record<string, string | undefined> = process.env): pg.Pool | null {
  const resolved = resolveConnection(env)
  if (!resolved) return null
  const g = globalThis as GlobalPool
  if (g.__accDbPool && g.__accDbPoolUrl === resolved.key) return g.__accDbPool
  if (g.__accDbPool) {
    void g.__accDbPool.end().catch(() => {})
  }
  const pool = resolved.config
    ? new pg.Pool({ ...resolved.config, max: 10 })
    : new pg.Pool({ connectionString: resolved.connectionString, max: 10 })
  g.__accDbPool = pool
  g.__accDbPoolUrl = resolved.key
  return pool
}

export function hasDatabaseUrl(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(resolveConnection(env))
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  env: Record<string, string | undefined> = process.env,
): Promise<pg.QueryResult<T>> {
  const pool = getPool(env)
  if (!pool) throw new Error('DATABASE_URL / POSTGRES_* is not set')
  return pool.query<T>(text, params)
}
