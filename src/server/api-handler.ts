import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, TablesDB, Query } from 'node-appwrite'
import { SHIPPING_RATES, SHIPPING_AVG } from '../shipping.ts'
import { getCatalogUpdateStatus, startCatalogUpdate } from './catalog-update.ts'
import { handleImageProxy } from './image-proxy.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  userFor: (req: IncomingMessage) => { name: string; email: string; labels: string[] } | null
  managerUrl: string
}

export function createApiHandler(env: Record<string, string>, gate?: GateLike) {
  const databaseId = env.APPWRITE_DATABASE_ID || 'acc-db'
  const updateToken = env.ACC_DB_UPDATE_TOKEN || ''

  function client() {
    return new Client()
      .setEndpoint(env.APPWRITE_ENDPOINT!)
      .setProject(env.APPWRITE_PROJECT_ID!)
      .setKey(env.APPWRITE_API_KEY!)
  }

  async function fetchAllRows(tableId: string, extraQueries: string[] = []) {
    const tablesDB = new TablesDB(client())
    const all: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < 40; page++) {
      const queries = [...extraQueries, Query.limit(100)]
      if (cursor) queries.push(Query.cursorAfter(cursor))
      const result = await tablesDB.listRows({ databaseId, tableId, queries })
      all.push(...result.rows)
      if (result.rows.length < 100) break
      cursor = result.rows[result.rows.length - 1].$id
    }
    return all
  }

  function mapAccessory(row: Record<string, unknown>) {
    return {
      id: row.$id as string,
      name: row.name as string,
      category: row.category as string,
      unit: row.unit as 'ks' | 'L',
      priceApprox: Number(row.priceApprox),
      sortOrder: Number(row.sortOrder),
      slug: row.slug as string,
      parentSlug: (row.parentSlug as string) || null,
      relatedGroup: (() => {
        const note = (row.note as string) || ''
        const m = note.match(/^related:(.+)$/)
        return m ? m[1] : null
      })(),
    }
  }

  function mapProduct(row: Record<string, unknown>) {
    return {
      id: row.$id as string,
      name: row.name as string,
      typeSlug: row.typeSlug as string,
      supplier: row.supplier as string,
      price: Number(row.price),
      priceVat: Number(row.priceVat),
      unit: (row.unit as 'ks' | 'L') || 'ks',
      dimensions: (row.dimensions as string) || null,
      imageUrl: (row.imageUrl as string) || null,
      productUrl: (row.productUrl as string) || null,
      sku: (row.sku as string) || null,
      note: (row.note as string) || null,
    }
  }

  function loadLocalCatalog() {
    const cmap = loadCategoryMap()
    const accessories = cmap.accessories.map((a) => ({
      id: a.slug,
      name: a.name,
      category: a.category,
      unit: a.unit as 'ks' | 'L',
      priceApprox: a.priceApprox,
      sortOrder: a.sortOrder,
      slug: a.slug,
      parentSlug: a.parentSlug,
      relatedGroup: a.relatedGroup,
    }))
    let products: ReturnType<typeof mapProduct>[] = []
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
            unit: (p.unit as 'ks' | 'L') || 'ks',
            dimensions: p.dimensions || null,
            imageUrl: p.imageUrl || null,
            productUrl: p.productUrl || null,
            sku: p.sku || null,
            note: p.note || null,
          }
        })
    } catch {
      products = []
    }
    return { accessories, products }
  }

  async function loadCatalog() {
    try {
      const [accRows, prodRows] = await Promise.all([
        fetchAllRows('accessories', [Query.orderAsc('sortOrder')]),
        fetchAllRows('products'),
      ])
      const accessories = accRows
        .map(mapAccessory)
        .filter((a) => a.category !== 'Vlastní výroba' && a.slug !== 'zadni-zabrana')
      const products = prodRows.map(mapProduct).filter((p) => p.typeSlug !== 'zadni-zabrana')
      if (!products.length && !accessories.length) return loadLocalCatalog()
      return { accessories, products }
    } catch (err) {
      console.warn('[acc-db] Appwrite unavailable, using local scraped_products.json', err)
      return loadLocalCatalog()
    }
  }

  function buildStats(
    accessories: ReturnType<typeof mapAccessory>[],
    products: ReturnType<typeof mapProduct>[],
  ) {
    const bySupplier: Record<string, number> = {}
    const byType: Record<string, number> = {}
    let minVat = Infinity
    let maxVat = 0
    let sumVat = 0
    let withImage = 0
    const withImageBySupplier: Record<string, number> = {}
    for (const p of products) {
      bySupplier[p.supplier] = (bySupplier[p.supplier] || 0) + 1
      byType[p.typeSlug] = (byType[p.typeSlug] || 0) + 1
      if (p.priceVat < minVat) minVat = p.priceVat
      if (p.priceVat > maxVat) maxVat = p.priceVat
      sumVat += p.priceVat
      if (p.imageUrl) {
        withImage++
        withImageBySupplier[p.supplier] = (withImageBySupplier[p.supplier] || 0) + 1
      }
    }
    const categories = [...new Set(accessories.map((a) => String(a.category)))]
    return {
      types: accessories.length,
      products: products.length,
      categories: categories.length,
      suppliers: Object.keys(bySupplier).filter((s) => s !== 'tržní odhad').length,
      bySupplier,
      byType,
      withImage,
      withImageBySupplier,
      priceVat: {
        min: products.length ? minVat : 0,
        max: products.length ? maxVat : 0,
        avg: products.length ? Math.round(sumVat / products.length) : 0,
      },
      shipping: { rates: SHIPPING_RATES, averageParcel: SHIPPING_AVG },
      updatedAt: new Date().toISOString(),
      catalogUpdate: getCatalogUpdateStatus(),
    }
  }

  const gzipOk = new WeakSet<ServerResponse>()

  function json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const payload = Buffer.from(JSON.stringify(body))
    // full catalogue („Vše“) is ~400 kB of JSON → ~60 kB gzipped
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
    if (!updateToken) return true // private deploy: allow if token not configured
    const header = req.headers['x-update-token']
    const token = Array.isArray(header) ? header[0] : header
    if (token && token === updateToken) return true
    // also allow Authorization: Bearer …
    const auth = req.headers.authorization
    if (auth && auth === `Bearer ${updateToken}`) return true
    return false
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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
          user: u ? { name: u.name, email: u.email, labels: u.labels } : null,
          managerUrl: gate?.managerUrl || '/',
        })
        return
      }

      if (method === 'GET' && pathOnly === '/api/stats') {
        const { accessories, products } = await loadCatalog()
        json(res, 200, buildStats(accessories, products))
        return
      }

      if (method === 'GET' && pathOnly === '/api/categories') {
        const cmap = loadCategoryMap()
        const { accessories, products } = await loadCatalog()
        const counts: Record<string, number> = {}
        for (const p of products) counts[p.typeSlug] = (counts[p.typeSlug] || 0) + 1

        // Merge DB accessories with map metadata (related groups)
        const bySlug = new Map(accessories.map((a) => [a.slug, a]))
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
            const items = accessories
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
        const { accessories } = await loadCatalog()
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
        const supplier = u.searchParams.get('supplier')
        const q = (u.searchParams.get('q') || '').trim().toLocaleLowerCase('cs')
        const { products } = await loadCatalog()
        let items = products
        if (typeSlug) items = items.filter((p) => p.typeSlug === typeSlug)
        if (supplier) items = items.filter((p) => p.supplier === supplier)
        if (q) {
          items = items.filter(
            (p) =>
              p.name.toLocaleLowerCase('cs').includes(q) ||
              p.supplier.toLocaleLowerCase('cs').includes(q) ||
              String(p.dimensions || '').toLocaleLowerCase('cs').includes(q) ||
              String(p.sku || '').toLocaleLowerCase('cs').includes(q) ||
              p.typeSlug.toLocaleLowerCase('cs').includes(q),
          )
        }
        items.sort((a, b) => a.priceVat - b.priceVat)
        const suppliers = [...new Set(items.map((p) => p.supplier))].sort((a, b) =>
          a.localeCompare(b, 'cs'),
        )
        json(res, 200, { items, suppliers, total: items.length })
        return
      }

      if (method === 'GET' && pathOnly === '/api/price-history') {
        const u = new URL(url, 'http://localhost')
        const productId = (u.searchParams.get('productId') || '').trim()
        if (!productId) {
          json(res, 400, { error: 'productId required' })
          return
        }
        try {
          const rows = await fetchAllRows('price_history', [
            Query.equal('productId', productId),
            Query.orderDesc('recordedAt'),
          ])
          const items = rows.map((row) => ({
            id: row.$id as string,
            productId: row.productId as string,
            oldPrice: Number(row.oldPrice),
            newPrice: Number(row.newPrice),
            oldPriceVat: Number(row.oldPriceVat),
            newPriceVat: Number(row.newPriceVat),
            recordedAt: row.recordedAt as string,
            supplier: (row.supplier as string) || null,
            name: (row.name as string) || null,
          }))
          json(res, 200, { items, total: items.length })
        } catch (err) {
          // Table may not exist yet before first seed
          json(res, 200, { items: [], total: 0 })
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
        await readBody(req) // drain
        const result = startCatalogUpdate()
        json(res, result.started ? 202 : 200, result)
        return
      }

      if (method !== 'GET') {
        json(res, 405, { error: 'Method Not Allowed' })
        return
      }

      next()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      json(res, 500, { error: message })
    }
  }
}
