import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

type GlobalPool = typeof globalThis & {
  __accDbPool?: pg.Pool
  __accDbPoolUrl?: string
  __accDbSchemaReady?: boolean
  __accDbSchemaPromise?: Promise<void>
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

/** Vite plugin env + process.env (dotenv / compose). */
function mergeEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...process.env, ...env }
}

/**
 * Prefer discrete POSTGRES_* (password may contain ?, @, # …).
 * Fall back to DATABASE_URL; if the URL is invalid because the password
 * was not percent-encoded, rebuild it from POSTGRES_PASSWORD when available.
 */
function resolveConnection(
  env: Record<string, string | undefined> = process.env,
): { connectionString?: string; config?: pg.PoolConfig; key: string } | null {
  const e = mergeEnv(env)
  const user = (e.POSTGRES_USER || '').trim()
  const password = e.POSTGRES_PASSWORD ?? ''
  const databaseEnv = (e.POSTGRES_DB || '').trim()
  const rawUrl = (e.DATABASE_URL || '').trim()
  const fromUrl = rawUrl ? parseHostPortDb(rawUrl) : {}

  const host = (e.POSTGRES_HOST || '').trim() || fromUrl.host || ''
  const port = Number(e.POSTGRES_PORT || 0) || fromUrl.port || undefined
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
  g.__accDbSchemaReady = false
  g.__accDbSchemaPromise = undefined
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

function isMissingRelation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  return e.code === '42P01' || /relation .* does not exist/i.test(e.message || '')
}

/** CREATE TABLE IF NOT EXISTS from scripts/sql/001_init.sql (idempotent). */
export async function ensureSchema(env: Record<string, string | undefined> = process.env): Promise<void> {
  const g = globalThis as GlobalPool
  if (g.__accDbSchemaReady) return
  if (g.__accDbSchemaPromise) return g.__accDbSchemaPromise

  g.__accDbSchemaPromise = (async () => {
    const pool = getPool(env)
    if (!pool) return
    const here = dirname(fileURLToPath(import.meta.url))
    const initSql = readFileSync(join(here, '../../scripts/sql/001_init.sql'), 'utf8')
    await pool.query(initSql)
    g.__accDbSchemaReady = true
  })()

  try {
    await g.__accDbSchemaPromise
  } catch (err) {
    g.__accDbSchemaPromise = undefined
    throw err
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  env: Record<string, string | undefined> = process.env,
): Promise<pg.QueryResult<T>> {
  const pool = getPool(env)
  if (!pool) throw new Error('DATABASE_URL / POSTGRES_* is not set')
  await ensureSchema(env)
  try {
    return await pool.query<T>(text, params)
  } catch (err) {
    if (!isMissingRelation(err)) throw err
    const g = globalThis as GlobalPool
    g.__accDbSchemaReady = false
    g.__accDbSchemaPromise = undefined
    await ensureSchema(env)
    return pool.query<T>(text, params)
  }
}
