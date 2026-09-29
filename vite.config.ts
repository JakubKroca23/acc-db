import { defineConfig, type Plugin, loadEnv } from 'vite'
import { Client, TablesDB, Query } from 'node-appwrite'
import { SHIPPING_RATES, SHIPPING_AVG } from './src/shipping.ts'

function apiPlugin(env: Record<string, string>): Plugin {
  function client() {
    return new Client()
      .setEndpoint(env.APPWRITE_ENDPOINT)
      .setProject(env.APPWRITE_PROJECT_ID)
      .setKey(env.APPWRITE_API_KEY)
  }

  async function fetchAllRows(tableId: string, extraQueries: string[] = []) {
    const tablesDB = new TablesDB(client())
    const databaseId = env.APPWRITE_DATABASE_ID || 'acc-db'
    const all: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
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
      id: row.$id,
      name: row.name,
      category: row.category,
      unit: row.unit,
      priceApprox: Number(row.priceApprox),
      sortOrder: Number(row.sortOrder),
      slug: row.slug,
      parentSlug: (row.parentSlug as string) || null,
    }
  }

  function mapProduct(row: Record<string, unknown>) {
    return {
      id: row.$id,
      name: row.name,
      typeSlug: row.typeSlug,
      supplier: row.supplier,
      price: Number(row.price),
      priceVat: Number(row.priceVat),
      unit: row.unit || 'ks',
      dimensions: row.dimensions || null,
      imageUrl: row.imageUrl || null,
      productUrl: row.productUrl || null,
      sku: row.sku || null,
      note: row.note || null,
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
    for (const p of products) {
      bySupplier[p.supplier] = (bySupplier[p.supplier] || 0) + 1
      byType[p.typeSlug] = (byType[p.typeSlug] || 0) + 1
      if (p.priceVat < minVat) minVat = p.priceVat
      if (p.priceVat > maxVat) maxVat = p.priceVat
      sumVat += p.priceVat
      if (p.imageUrl) withImage++
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
      priceVat: {
        min: products.length ? minVat : 0,
        max: products.length ? maxVat : 0,
        avg: products.length ? Math.round(sumVat / products.length) : 0,
      },
      shipping: {
        rates: SHIPPING_RATES,
        averageParcel: SHIPPING_AVG,
      },
      updatedAt: new Date().toISOString(),
    }
  }

  const handler = async (
    req: { url?: string; method?: string },
    res: {
      statusCode: number
      setHeader: (k: string, v: string) => void
      end: (body?: string) => void
    },
    next: () => void,
  ) => {
    const url = req.url || ''
    if (!url.startsWith('/api/')) return next()
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    try {
      if (url.startsWith('/api/stats')) {
        const [accRows, prodRows] = await Promise.all([
          fetchAllRows('accessories', [Query.orderAsc('sortOrder')]),
          fetchAllRows('products'),
        ])
        const accessories = accRows
          .map(mapAccessory)
          .filter((a) => a.category !== 'Vlastní výroba' && a.slug !== 'zadni-zabrana')
        const products = prodRows.map(mapProduct).filter((p) => p.typeSlug !== 'zadni-zabrana')
        const stats = buildStats(accessories, products)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(stats))
        return
      }

      if (url.startsWith('/api/accessories')) {
        const rows = await fetchAllRows('accessories', [Query.orderAsc('sortOrder')])
        const items = rows
          .map(mapAccessory)
          .filter((a) => a.category !== 'Vlastní výroba' && a.slug !== 'zadni-zabrana')
          .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ items, updatedAt: new Date().toISOString() }))
        return
      }

      if (url.startsWith('/api/products')) {
        const u = new URL(url, 'http://localhost')
        const typeSlug = u.searchParams.get('type')
        const supplier = u.searchParams.get('supplier')
        const q = (u.searchParams.get('q') || '').trim().toLocaleLowerCase('cs')
        const extra: string[] = []
        if (typeSlug) extra.push(Query.equal('typeSlug', typeSlug))
        if (supplier) extra.push(Query.equal('supplier', supplier))
        let items = (await fetchAllRows('products', extra))
          .map(mapProduct)
          .filter((p) => p.typeSlug !== 'zadni-zabrana')
        if (q) {
          items = items.filter(
            (p) =>
              String(p.name).toLocaleLowerCase('cs').includes(q) ||
              String(p.supplier).toLocaleLowerCase('cs').includes(q) ||
              String(p.dimensions || '').toLocaleLowerCase('cs').includes(q) ||
              String(p.sku || '').toLocaleLowerCase('cs').includes(q),
          )
        }
        items.sort((a, b) => a.priceVat - b.priceVat)
        const suppliers = [...new Set(items.map((p) => String(p.supplier)))].sort()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ items, suppliers, total: items.length }))
        return
      }

      next()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: message }))
    }
  }

  return {
    name: 'acc-db-api',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [apiPlugin(env)],
    server: { port: 5173, host: true },
  }
})
