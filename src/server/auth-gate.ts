/**
 * Access gate: acc-db is reachable only for users logged in to Contsystem Manager (cs-zakazky)
 * who carry one of the allowed roles (user labels, e.g. `dev`).
 *
 * The Manager stores its Better Auth session in the httpOnly cookie
 * `better-auth.session_token` (http) or `__Secure-better-auth.session_token` (https),
 * path=/, host-only on zakazky.contsystem.cz, so the browser sends it to /acc-db/ as well.
 * We validate it the same way the Manager does: GET <MANAGER_AUTH_URL>/api/auth/session
 * with that cookie. The route returns the user including `labels` (= roles).
 * A leftover Appwrite cookie `a_session_*` is ignored — that API is gone (HTTP 404) and
 * treating the 404 as a hard failure showed „Dočasně nedostupné“ to logged-in users.
 * Results are cached per sha256(cookie) for a short time.
 *
 * Env:
 *   ACC_DB_AUTH=manager                 enable the gate (anything else = disabled, e.g. local dev)
 *   ACC_DB_ALLOWED_ROLES=dev            comma separated labels allowed in (`*` = any logged-in user)
 *   MANAGER_AUTH_URL                    default http://cs-zakazky-app:3000 (docker DNS on network appwrite)
 *   MANAGER_LOGIN_URL                   default /login?next=%2Facc-db%2F
 *   MANAGER_URL                         default /  (link back to the Manager)
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'

export type GateUser = { id: string; name: string; email: string; labels: string[] }

type CacheEntry = { exp: number; user: GateUser | null }

const OK_TTL_MS = 60_000
const DENY_TTL_MS = 10_000
const FETCH_TIMEOUT_MS = 6_000

/** Same names as cs-zakazky `getSessionCookieHeader()` — do not take them from MANAGER_SESSION_COOKIE (that was the Appwrite cookie). */
const SESSION_COOKIE_NAMES = ['better-auth.session_token', '__Secure-better-auth.session_token'] as const

export function createAuthGate(env: Record<string, string | undefined>) {
  const enabled = (env.ACC_DB_AUTH || '').trim().toLowerCase() === 'manager'
  const authUrl = (env.MANAGER_AUTH_URL || 'http://cs-zakazky-app:3000').trim().replace(/\/$/, '')
  const loginUrl = (env.MANAGER_LOGIN_URL || '/login?next=%2Facc-db%2F').trim()
  const managerUrl = (env.MANAGER_URL || '/').trim()
  const allowedRoles = (env.ACC_DB_ALLOWED_ROLES || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<GateUser | null>>()

  /** Raw Cookie header pair(s) for the Better Auth session, or null when the browser did not send one. */
  function sessionCookieHeader(req: IncomingMessage): string | null {
    const header = req.headers.cookie
    if (!header) return null
    const found = new Map<string, string>()
    for (const part of header.split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      const name = part.slice(0, i).trim()
      if (!SESSION_COOKIE_NAMES.includes(name as (typeof SESSION_COOKIE_NAMES)[number])) continue
      const raw = part.slice(i + 1).trim()
      if (!raw) continue
      found.set(name, raw)
    }
    const pairs: string[] = []
    for (const name of SESSION_COOKIE_NAMES) {
      const raw = found.get(name)
      if (raw) pairs.push(`${name}=${raw}`)
    }
    return pairs.length ? pairs.join('; ') : null
  }

  /** null = invalid / expired session; throws when the Manager is unreachable (fail closed, not cached). */
  async function fetchUser(cookieHeader: string): Promise<GateUser | null> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`${authUrl}/api/auth/session`, {
        headers: {
          Accept: 'application/json',
          Cookie: cookieHeader,
        },
        redirect: 'manual',
        signal: ctrl.signal,
      })
      if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel()
        return null
      }
      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`Manager /api/auth/session HTTP ${res.status}`)
      }
      const body = (await res.json()) as {
        success?: boolean
        user?: { $id?: string; id?: string; name?: string; email?: string; labels?: unknown }
      }
      const u = body.user
      const id = (u?.$id || u?.id || '').trim()
      if (!body.success || !id) return null
      return {
        id,
        name: u?.name || '',
        email: u?.email || '',
        labels: Array.isArray(u?.labels) ? u.labels.map(String) : [],
      }
    } finally {
      clearTimeout(t)
    }
  }

  async function resolveUser(cookieHeader: string): Promise<GateUser | null> {
    const key = createHash('sha256').update(cookieHeader).digest('hex')
    const now = Date.now()
    const hit = cache.get(key)
    if (hit && hit.exp > now) return hit.user
    let p = inflight.get(key)
    if (!p) {
      p = fetchUser(cookieHeader).finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    const user = await p
    if (cache.size > 1000) {
      for (const [k, v] of cache) if (v.exp <= now) cache.delete(k)
      if (cache.size > 1000) cache.clear()
    }
    cache.set(key, { exp: now + (user ? OK_TTL_MS : DENY_TTL_MS), user })
    return user
  }

  const isAllowed = (u: GateUser) => allowedRoles.includes('*') || u.labels.some((l) => allowedRoles.includes(l))

  function isApiPath(url: string) {
    return /^(?:\/acc-db)?\/api\//.test(url)
  }

  function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
    res.statusCode = status
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v)
    res.end(body)
  }

  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

  function page(title: string, text: string, actions: string) {
    return `<!doctype html><html lang="cs"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · Katalog příslušenství</title><meta name="robots" content="noindex" />
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e4e4e7;color:#18181b;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
main{max-width:440px;margin:24px;padding:28px;background:#fff;border:1px solid #d4d4d8;border-radius:12px;box-shadow:0 8px 30px rgba(24,24,27,.08)}
h1{margin:0 0 10px;font-size:20px}p{margin:0 0 18px;line-height:1.5;color:#3f3f46}
a{display:inline-block;margin-right:8px;padding:9px 14px;border-radius:6px;background:#0091ff;color:#fff;text-decoration:none;font-weight:600;font-size:14px}
a.sec{background:#fff;color:#18181b;border:1px solid #d4d4d8}
</style></head><body><main><h1>${esc(title)}</h1><p>${text}</p>${actions}</main></body></html>`
  }

  function unauthenticated(req: IncomingMessage, res: ServerResponse) {
    if (isApiPath(req.url || '')) {
      send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'Nepřihlášen — přihlaste se v Contsystem Manageru', login: loginUrl }))
      return
    }
    send(res, 302, 'text/html; charset=utf-8', page('Přihlášení', 'Přesměrovávám na přihlášení do Contsystem Manageru…', `<a href="${esc(loginUrl)}">Přihlásit se</a>`), {
      Location: loginUrl,
    })
  }

  function forbidden(req: IncomingMessage, res: ServerResponse, user: GateUser) {
    if (isApiPath(req.url || '')) {
      send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ error: 'Nemáte přístup — váš účet nemá potřebnou roli' }))
      return
    }
    send(
      res,
      403,
      'text/html; charset=utf-8',
      page(
        'Nemáte přístup',
        `Váš účet nemá pro aplikaci potřebnou roli.${user.name ? ` Přihlášen: <strong>${esc(user.name)}</strong>.` : ''}`,
        `<a href="${esc(managerUrl)}">Zpět do Manageru</a>`,
      ),
    )
  }

  function unavailable(req: IncomingMessage, res: ServerResponse) {
    if (isApiPath(req.url || '')) {
      send(res, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'Ověření přihlášení je dočasně nedostupné' }), { 'Retry-After': '10' })
      return
    }
    send(res, 503, 'text/html; charset=utf-8', page('Dočasně nedostupné', 'Nepodařilo se ověřit přihlášení. Zkuste to prosím za chvíli znovu.', `<a href="">Zkusit znovu</a>`), {
      'Retry-After': '10',
    })
  }

  const users = new WeakMap<IncomingMessage, GateUser>()

  /** connect-style middleware; must run before static files and the API handler */
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    if (!enabled) return next()
    // Only the app itself (/acc-db…) is gated; anything else is not ours (Traefik routes only /acc-db here)
    // and must not loop, e.g. a relative MANAGER_LOGIN_URL hit on a local preview.
    // The API handler also answers un-prefixed /api/* (internal/dev) → gate that too.
    if (!/^\/(?:acc-db(?:[/?#]|$)|api\/)/.test(req.url || '')) return next()
    const cookieHeader = sessionCookieHeader(req)
    if (!cookieHeader) return unauthenticated(req, res)
    let user: GateUser | null
    try {
      user = await resolveUser(cookieHeader)
    } catch (err) {
      console.error('[acc-db auth] session check failed:', err instanceof Error ? err.message : err)
      return unavailable(req, res)
    }
    if (!user) return unauthenticated(req, res)
    if (!isAllowed(user)) return forbidden(req, res, user)
    users.set(req, user)
    next()
  }

  return {
    enabled,
    middleware,
    /** user resolved for this request (only when the gate is enabled) */
    userFor: (req: IncomingMessage) => users.get(req) || null,
    managerUrl,
    loginUrl,
    config: { authUrl, cookieNames: [...SESSION_COOKIE_NAMES], allowedRoles },
  }
}
