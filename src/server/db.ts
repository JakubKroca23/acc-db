import pg from 'pg'

type GlobalPool = typeof globalThis & {
  __accDbPool?: pg.Pool
  __accDbPoolUrl?: string
}

function databaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = (env.DATABASE_URL || '').trim()
  return url || null
}

/** Shared Pool across Vite HMR reloads (avoids leaking connections). */
export function getPool(env: Record<string, string | undefined> = process.env): pg.Pool | null {
  const url = databaseUrl(env)
  if (!url) return null
  const g = globalThis as GlobalPool
  if (g.__accDbPool && g.__accDbPoolUrl === url) return g.__accDbPool
  if (g.__accDbPool) {
    void g.__accDbPool.end().catch(() => {})
  }
  const pool = new pg.Pool({ connectionString: url, max: 10 })
  g.__accDbPool = pool
  g.__accDbPoolUrl = url
  return pool
}

export function hasDatabaseUrl(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(databaseUrl(env))
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  env: Record<string, string | undefined> = process.env,
): Promise<pg.QueryResult<T>> {
  const pool = getPool(env)
  if (!pool) throw new Error('DATABASE_URL is not set')
  return pool.query<T>(text, params)
}
