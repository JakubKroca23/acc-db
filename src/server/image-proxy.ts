import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Same-origin image proxy for supplier thumbnails: GET /api/img?url=<absolute URL>
 *
 * Why: supplier CDNs are inconsistent — Hydrotruck's <img> .jpg fallbacks often 404
 * (only the .webp exists) and its TLS endpoint drops connections intermittently,
 * Trans-Technik serves images with no Content-Type and URLs with spaces/diacritics.
 * Serving everything through our origin gives one cacheable, hotlink-proof URL that
 * also works in print/PDF.
 *
 * Safety: https only, strict host allowlist (also re-checked on every redirect),
 * raster images only (magic-byte sniffed, no SVG), 6 MB cap, 15 s timeout.
 */

const ALLOWED_HOSTS = new Set([
  'cdn.alsap.cz',
  'www.alsap.cz',
  'alsap.cz',
  'www.trans-technik.cz',
  'trans-technik.cz',
  'www.hydrotruck.cz',
  'hydrotruck.cz',
])

const MAX_BYTES = 6 * 1024 * 1024
const TIMEOUT_MS = 15_000
const MEM_LIMIT_BYTES = 64 * 1024 * 1024
const NEG_TTL_MS = 10 * 60 * 1000
const BROWSER_MAX_AGE = 7 * 24 * 3600
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

type Cached = { body: Buffer; type: string; etag: string }

const CACHE_DIR = join(tmpdir(), 'acc-db-img-cache')
let diskOk = true
try {
  mkdirSync(CACHE_DIR, { recursive: true })
} catch {
  diskOk = false
}

const mem = new Map<string, Cached>() // insertion-ordered → simple LRU
let memBytes = 0
const negative = new Map<string, number>()
const inflight = new Map<string, Promise<Cached | null>>()

function memGet(key: string): Cached | undefined {
  const hit = mem.get(key)
  if (hit) {
    mem.delete(key)
    mem.set(key, hit)
  }
  return hit
}

function memSet(key: string, value: Cached) {
  if (mem.has(key)) return
  mem.set(key, value)
  memBytes += value.body.length
  while (memBytes > MEM_LIMIT_BYTES && mem.size) {
    const [oldKey, old] = mem.entries().next().value as [string, Cached]
    mem.delete(oldKey)
    memBytes -= old.body.length
  }
}

export function normalizeImageUrl(raw: string): URL | null {
  if (!raw || raw.length > 2048) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol === 'http:') u.protocol = 'https:'
  if (u.protocol !== 'https:') return null
  if (u.username || u.password || (u.port && u.port !== '443')) return null
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null
  return u
}

function sniffType(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  if (buf.subarray(4, 12).toString('ascii') === 'ftypavif') return 'image/avif'
  return null
}

async function fetchOnce(url: URL): Promise<{ status: number; body?: Buffer }> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*;q=0.8' },
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        const next = loc ? normalizeImageUrl(new URL(loc, current).toString()) : null
        if (!next) return { status: 502 }
        current = next
        continue
      }
      if (!res.ok) return { status: res.status }
      const len = Number(res.headers.get('content-length') || 0)
      if (len > MAX_BYTES) return { status: 413 }
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length
        if (total > MAX_BYTES) {
          ctrl.abort()
          return { status: 413 }
        }
        chunks.push(Buffer.from(chunk))
      }
      return { status: 200, body: Buffer.concat(chunks) }
    } finally {
      clearTimeout(timer)
    }
  }
  return { status: 508 }
}

async function fetchWithRetry(url: URL): Promise<{ status: number; body?: Buffer }> {
  let last: { status: number; body?: Buffer } = { status: 502 }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      last = await fetchOnce(url)
      if (last.status === 200 || (last.status >= 400 && last.status < 500)) return last
    } catch {
      last = { status: 502 } // network / TLS reset (Hydrotruck drops handshakes now and then)
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
  }
  return last
}

async function loadImage(url: URL, key: string): Promise<Cached | null> {
  const diskPath = join(CACHE_DIR, key)
  if (diskOk) {
    try {
      const [body, meta] = await Promise.all([fsp.readFile(diskPath), fsp.readFile(`${diskPath}.type`, 'utf8')])
      return { body, type: meta.trim(), etag: `"${key}"` }
    } catch {
      /* miss */
    }
  }

  let result = await fetchWithRetry(url)
  // Hydrotruck: the .jpg named in <img src> is frequently missing while the .webp exists.
  if (result.status === 404 && /\.(jpe?g|png)$/i.test(url.pathname)) {
    const alt = new URL(url)
    alt.pathname = alt.pathname.replace(/\.(jpe?g|png)$/i, '.webp')
    result = await fetchWithRetry(alt)
  }
  if (result.status !== 200 || !result.body) return null
  const type = sniffType(result.body)
  if (!type) return null
  const value: Cached = { body: result.body, type, etag: `"${key}"` }
  if (diskOk) {
    fsp
      .writeFile(diskPath, result.body)
      .then(() => fsp.writeFile(`${diskPath}.type`, type))
      .catch(() => undefined)
  }
  return value
}

function send(res: ServerResponse, status: number, message: string) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', status === 400 || status === 403 ? 'no-store' : 'public, max-age=300')
  res.end(message)
}

export async function handleImageProxy(req: IncomingMessage, res: ServerResponse, rawUrl: string) {
  const params = new URL(rawUrl, 'http://localhost').searchParams
  const target = normalizeImageUrl(params.get('url') || '')
  if (!target) {
    send(res, 403, 'URL not allowed')
    return
  }
  const href = target.toString()
  const key = createHash('sha1').update(href).digest('hex')

  const negUntil = negative.get(key)
  if (negUntil && negUntil > Date.now()) {
    send(res, 404, 'Image unavailable')
    return
  }

  let hit = memGet(key)
  if (!hit) {
    let p = inflight.get(key)
    if (!p) {
      p = loadImage(target, key).finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    const loaded = await p
    if (!loaded) {
      negative.set(key, Date.now() + NEG_TTL_MS)
      send(res, 404, 'Image unavailable')
      return
    }
    memSet(key, loaded)
    hit = loaded
  }

  res.setHeader('ETag', hit.etag)
  res.setHeader('Cache-Control', `public, max-age=${BROWSER_MAX_AGE}, stale-while-revalidate=86400`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'")
  if (req.headers['if-none-match'] === hit.etag) {
    res.statusCode = 304
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', hit.type)
  res.setHeader('Content-Length', String(hit.body.length))
  if ((req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end()
    return
  }
  res.end(hit.body)
}
