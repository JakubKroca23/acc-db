import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPING_RATES, SHIPPING_AVG } from '../shipping.ts'
import {
  getCatalogUpdateStatus,
  startCatalogUpdate,
  stopCatalogUpdate,
  setCatalogChangedHandler,
} from './catalog-update.ts'
import { handleImageProxy } from './image-proxy.ts'
import { hasDatabaseUrl } from './db.ts'
import {
  listAccessories,
  queryProducts,
  listAllSuppliers,
  productCountsByType,
  catalogStats,
  priceHistory,
  type AccessoryRow,
  type ProductRow,
} from './catalog-repo.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

export class CatalogUnavailableError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause ? String(cause) : ''
    super(detail ? `Katalog není dostupný: ${detail}` : 'Katalog není dostupný (PostgreSQL)')
    this.name = 'CatalogUnavailableError'
  }
}

function loadCategoryMap() {
  try {
    const raw = readFileSync(join(__dirname, '../../scripts/category-map.json'), 'utf8')
    return JSON.parse(raw) as {
      groups: { id: string; label: string; slugs: string[] }[]
      accessories: {
        slug: string
        name: string
        category: string
        unit: string
        priceApprox: number
        sortOrder: number
        parentSlug: string | null
        relatedGroup: string | null
      }[]
    }
  } catch {
    return { groups: [], accessories: [] }
  }
}

type GateLike = {
  enabled: boolean
  userFor: (req: IncomingMessage) => { id: string; name: string; email: string; labels: string[] } | null
  managerUrl: string
}

export function createApiHandler(env: Record<string, string>, gate?: GateLike) {
  const updateToken = env.ACC_DB_UPDATE_TOKEN || ''
  const usePg = hasDatabaseUrl(env)

  function loadLocalCatalog() {
    const cmap = loadCategoryMap()
    const accessories: AccessoryRow[] = cmap.accessories
      .filter((a) => a.category !== 'Vlastní výroba' && a.slug !== 'zadni-zabrana')
      .map((a) => ({
        id: a.slug,
        name: a.name,
        category: a.category,
        unit: a.unit as 'ks' | 'L' | 'm',
        priceApprox: a.priceApprox,
        sortOrder: a.sortOrder,
        slug: a.slug,
        parentSlug: a.parentSlug,
        relatedGroup: a.relatedGroup,
      }))
    let products: ProductRow[] = []
    try {
      const raw = readFileSync(join(__dirname, '../../scripts/scraped_products.json'), 'utf8')
      const items = JSON.parse(raw) as {
        name: string
        typeSlug: string
        supplier: string
        price: number
        priceVat: number
        unit?: string
        dimensions?: string | null
        imageUrl?: string | null
        productUrl?: string | null
        sku?: string | null
        note?: string | null
        datasheetUrl?: string | null
      }[]
      products = items
        .filter((p) => p.typeSlug !== 'zadni-zabrana')
        .map((p) => {
          const rawId = `${p.supplier}|${p.productUrl || p.name}`
          return {
            id: createHash('sha1').update(rawId).digest('hex').slice(0, 32),
            name: p.name,
            typeSlug: p.typeSlug,
            supplier: p.supplier,
            price: Number(p.price),
            priceVat: Number(p.priceVat),
            unit: (p.unit as 'ks' | 'L' | 'm') || 'ks',
            dimensions: p.dimensions || null,
            imageUrl: p.imageUrl || null,
            productUrl: p.productUrl || null,
            sku: p.sku || null,
            note: p.note || null,
            datasheetUrl: p.datasheetUrl || null,
          }
        })
    } catch {
      products = []
    }
    return { accessories, products }
  }

  /** Short-lived accessories cache (small). Products are queried per request in SQL. */
  let accessoriesCache: { at: number; items: AccessoryRow[] } | null = null

  function invalidateCaches() {
    accessoriesCache = null
  }
  setCatalogChangedHandler(invalidateCaches)

  async function getAccessories(): Promise<AccessoryRow[]> {
    if (accessoriesCache && Date.now() - accessoriesCache.at < 60_000) return accessoriesCache.items
    if (!usePg) {
      const items = loadLocalCatalog().accessories
      accessoriesCache = { at: Date.now(), items }
      return items
    }
    try {
      const items = await listAccessories(env)
      accessoriesCache = { at: Date.now(), items }
      return items
    } catch (err) {
      console.error('[acc-db] PostgreSQL unavailable', err)
      throw new CatalogUnavailableError(err)
    }
  }

  async function getProducts(opts: {
    typeSlug?: string | null
    suppliers?: string[]
    q?: string | null
    sort?: 'price_asc' | 'price_desc'
    ids?: string[]
  }): Promise<{ items: ProductRow[]; allSuppliers: string[] }> {
    if (!usePg) {
      let items = loadLocalCatalog().products
      if (opts.ids?.length) {
        const want = new Set(opts.ids)
        items = items.filter((p) => want.has(p.id))
      }
      if (opts.typeSlug) items = items.filter((p) => p.typeSlug === opts.typeSlug)
      if (opts.suppliers?.length) items = items.filter((p) => opts.suppliers!.includes(p.supplier))
      if (opts.q?.trim()) {
        const q = opts.q.trim().toLocaleLowerCase('cs')
        items = items.filter(
          (p) =>
            p.name.toLocaleLowerCase('cs').includes(q) ||
            p.supplier.toLocaleLowerCase('cs').includes(q) ||
            String(p.dimensions || '').toLocaleLowerCase('cs').includes(q) ||
            String(p.sku || '').toLocaleLowerCase('cs').includes(q) ||
            p.typeSlug.toLocaleLowerCase('cs').includes(q),
        )
      }
      items.sort((a, b) => {
        const ak = a.price > 0
        const bk = b.price > 0
        if (ak !== bk) return ak ? -1 : 1
        if (!ak) return a.name.localeCompare(b.name, 'cs')
        return opts.sort === 'price_desc' ? b.priceVat - a.priceVat : a.priceVat - b.priceVat
      })
      const allSuppliers = [
        ...new Set(loadLocalCatalog().products.map((p) => p.supplier).filter((s) => s && s !== 'tržní odhad')),
      ].sort((a, b) => a.localeCompare(b, 'cs'))
      return { items, allSuppliers }
    }
    try {
      const [items, allSuppliers] = await Promise.all([
        queryProducts(
          {
            typeSlug: opts.typeSlug,
            suppliers: opts.suppliers,
            q: opts.q,
            sort: opts.sort,
            ids: opts.ids,
          },
          env,
        ),
        listAllSuppliers(env),
      ])
      return { items, allSuppliers }
    } catch (err) {
      console.error('[acc-db] PostgreSQL unavailable', err)
      throw new CatalogUnavailableError(err)
    }
  }

  const gzipOk = new WeakSet<ServerResponse>()

  function json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const payload = Buffer.from(JSON.stringify(body))
    if (payload.length > 8192 && gzipOk.has(res)) {
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Vary', 'Accept-Encoding')
      res.end(gzipSync(payload, { level: 6 }))
      return
    }
    res.end(payload)
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function checkUpdateAuth(req: IncomingMessage): boolean {
    if (!updateToken) return true
    const header = req.headers['x-update-token']
    const token = Array.isArray(header) ? header[0] : header
    if (token && token === updateToken) return true
    const auth = req.headers.authorization
    if (auth && auth === `Bearer ${updateToken}`) return true
    return false
  }

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = req.url || ''
    const url = raw.replace(/^\/acc-db(?=\/)/, '')
    if (!url.startsWith('/api/')) return next()

    const method = (req.method || 'GET').toUpperCase()
    const pathOnly = url.split('?')[0]
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) gzipOk.add(res)

    try {
      if ((method === 'GET' || method === 'HEAD') && pathOnly === '/api/img') {
        await handleImageProxy(req, res, url)
        return
      }

      if (method === 'GET' && pathOnly === '/api/me') {
        const u = gate?.userFor(req)
        json(res, 200, {
          auth: !!gate?.enabled,
          user: u ? { id: u.id, name: u.name, email: u.email, labels: u.labels } : null,
          managerUrl: gate?.managerUrl || '/',
        })
        return
      }

      if (method === 'GET' && pathOnly === '/api/stats') {
        if (!usePg) {
          const { accessories, products } = loadLocalCatalog()
          const bySupplier: Record<string, number> = {}
          const byType: Record<string, number> = {}
          let withImage = 0
          const withImageBySupplier: Record<string, number> = {}
          let minVat = Infinity
          let maxVat = 0
          let sumVat = 0
          let priced = 0
          for (const p of products) {
            bySupplier[p.supplier] = (bySupplier[p.supplier] || 0) + 1
            byType[p.typeSlug] = (byType[p.typeSlug] || 0) + 1
            if (p.priceVat > 0) {
              priced++
              if (p.priceVat < minVat) minVat = p.priceVat
              if (p.priceVat > maxVat) maxVat = p.priceVat
              sumVat += p.priceVat
            }
            if (p.imageUrl) {
              withImage++
              withImageBySupplier[p.supplier] = (withImageBySupplier[p.supplier] || 0) + 1
            }
          }
          json(res, 200, {
            types: accessories.length,
            products: products.length,
            categories: new Set(accessories.map((a) => a.category)).size,
            suppliers: Object.keys(bySupplier).filter((s) => s !== 'tržní odhad').length,
            bySupplier,
            byType,
            withImage,
            withImageBySupplier,
            priceVat: {
              min: priced ? minVat : 0,
              max: priced ? maxVat : 0,
              avg: priced ? Math.round(sumVat / priced) : 0,
            },
            shipping: { rates: SHIPPING_RATES, averageParcel: SHIPPING_AVG },
            updatedAt: new Date().toISOString(),
            catalogUpdate: getCatalogUpdateStatus(),
            backend: 'json',
          })
          return
        }
        try {
          const stats = await catalogStats(env)
          json(res, 200, {
            ...stats,
            shipping: { rates: SHIPPING_RATES, averageParcel: SHIPPING_AVG },
            updatedAt: new Date().toISOString(),
            catalogUpdate: getCatalogUpdateStatus(),
            backend: 'postgres',
          })
        } catch (err) {
          throw new CatalogUnavailableError(err)
        }
        return
      }

      if (method === 'GET' && pathOnly === '/api/categories') {
        const cmap = loadCategoryMap()
        const accessories = await getAccessories()
        let counts: Record<string, number> = {}
        if (usePg) {
          try {
            counts = await productCountsByType(env)
          } catch (err) {
            throw new CatalogUnavailableError(err)
          }
        } else {
          for (const p of loadLocalCatalog().products) {
            counts[p.typeSlug] = (counts[p.typeSlug] || 0) + 1
          }
        }

        const bySlug = new Map(accessories.map((a) => [a.slug, { ...a }]))
        for (const a of cmap.accessories) {
          const existing = bySlug.get(a.slug)
          if (existing) {
            existing.relatedGroup = a.relatedGroup
            if (!existing.parentSlug) existing.parentSlug = a.parentSlug
          }
        }

        const categoryOrder = ['Podvozek', 'Všechny nástavby', 'Hákový nosič kontejneru', 'Ostatní']
        const tree = categoryOrder
          .map((cat) => {
            const items = [...bySlug.values()]
              .filter((a) => a.category === cat)
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((a) => ({
                ...a,
                productCount: counts[a.slug] || 0,
                relatedSlugs:
                  cmap.groups.find((g) => g.id === a.relatedGroup)?.slugs.filter((s) => s !== a.slug) ||
                  [],
              }))
            return { category: cat, items }
          })
          .filter((g) => g.items.length)

        json(res, 200, {
          tree,
          groups: cmap.groups,
          updatedAt: new Date().toISOString(),
        })
        return
      }

      if (method === 'GET' && pathOnly === '/api/accessories') {
        const cmap = loadCategoryMap()
        const accessories = await getAccessories()
        const items = accessories
          .map((a) => {
            const meta = cmap.accessories.find((m) => m.slug === a.slug)
            return {
              ...a,
              relatedGroup: meta?.relatedGroup || a.relatedGroup,
              relatedSlugs:
                cmap.groups.find((g) => g.id === (meta?.relatedGroup || a.relatedGroup))?.slugs.filter(
                  (s) => s !== a.slug,
                ) || [],
            }
          })
          .sort((a, b) => a.sortOrder - b.sortOrder)
        json(res, 200, { items, groups: cmap.groups, updatedAt: new Date().toISOString() })
        return
      }

      if (method === 'GET' && pathOnly === '/api/products') {
        const u = new URL(url, 'http://localhost')
        const typeSlug = u.searchParams.get('type')
        const idsRaw = (u.searchParams.get('ids') || '').trim()
        const ids = idsRaw
          ? [...new Set(idsRaw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 100)
          : undefined
        const supplierRaw = (u.searchParams.get('supplier') || '').trim()
        const wantedSuppliers = supplierRaw
          ? [...new Set(supplierRaw.split(',').map((s) => s.trim()).filter(Boolean))]
          : []
        const sort = u.searchParams.get('sort') === 'price_desc' ? 'price_desc' : 'price_asc'
        const q = (u.searchParams.get('q') || '').trim()
        const { items, allSuppliers } = await getProducts({
          typeSlug,
          suppliers: wantedSuppliers.length ? wantedSuppliers : undefined,
          q: q || undefined,
          sort,
          ids,
        })
        const suppliers = [...new Set(items.map((p) => p.supplier))].sort((a, b) =>
          a.localeCompare(b, 'cs'),
        )
        json(res, 200, { items, suppliers, allSuppliers, total: items.length, sort })
        return
      }

      if (method === 'GET' && pathOnly === '/api/price-history') {
        const u = new URL(url, 'http://localhost')
        const productId = (u.searchParams.get('productId') || '').trim()
        if (!productId) {
          json(res, 400, { error: 'productId required' })
          return
        }
        if (!usePg) {
          json(res, 200, { items: [], total: 0 })
          return
        }
        try {
          const items = await priceHistory(productId, env)
          json(res, 200, { items, total: items.length })
        } catch (err) {
          console.error('[acc-db] price-history failed', err)
          throw new CatalogUnavailableError(err)
        }
        return
      }

      if (method === 'GET' && pathOnly === '/api/catalog/update/status') {
        json(res, 200, getCatalogUpdateStatus())
        return
      }

      if (method === 'POST' && pathOnly === '/api/catalog/update') {
        if (!checkUpdateAuth(req)) {
          json(res, 401, { error: 'Unauthorized — missing or invalid X-Update-Token' })
          return
        }
        if (!usePg) {
          json(res, 503, { error: 'Seed vyžaduje DATABASE_URL (PostgreSQL)' })
          return
        }
        const body = await readBody(req)
        let suppliers: string[] | undefined
        let skipPavlinek = false
        try {
          const parsed = body
            ? (JSON.parse(body) as { suppliers?: string[]; skipPavlinek?: boolean })
            : null
          if (Array.isArray(parsed?.suppliers)) suppliers = parsed.suppliers.map(String)
          skipPavlinek = !!parsed?.skipPavlinek
        } catch {
          /* empty / non-JSON body */
        }
        const result = startCatalogUpdate({ suppliers, skipPavlinek })
        json(res, result.started ? 202 : 200, result)
        return
      }

      if (method === 'POST' && pathOnly === '/api/catalog/update/stop') {
        if (!checkUpdateAuth(req)) {
          json(res, 401, { error: 'Unauthorized — missing or invalid X-Update-Token' })
          return
        }
        await readBody(req)
        const result = stopCatalogUpdate()
        json(res, 200, result)
        return
      }

      if (method !== 'GET') {
        json(res, 405, { error: 'Method Not Allowed' })
        return
      }

      next()
    } catch (err) {
      if (err instanceof CatalogUnavailableError) {
        if (!res.headersSent) json(res, 503, { error: err.message })
        return
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (res.headersSent) {
        res.end()
        return
      }
      json(res, 500, { error: message })
    }
  }

  return Object.assign(handler, { onServerStart: () => {} })
}
