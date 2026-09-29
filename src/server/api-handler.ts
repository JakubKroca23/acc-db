import type { IncomingMessage, ServerResponse } from 'node:http'
import { Client, TablesDB, Query } from 'node-appwrite'
import { SHIPPING_RATES, SHIPPING_AVG } from '../shipping.ts'

export function createApiHandler(env: Record<string, string>) {
  const databaseId = env.APPWRITE_DATABASE_ID || 'acc-db'

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
      id: row.$id as string,
      name: row.name as string,
      category: row.category as string,
      unit: row.unit as 'ks' | 'L',
      priceApprox: Number(row.priceApprox),
      sortOrder: Number(row.sortOrder),
      slug: row.slug as string,
      parentSlug: (row.parentSlug as string) || null,
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

  async function loadCatalog() {
    const [accRows, prodRows] = await Promise.all([
      fetchAllRows('accessories', [Query.orderAsc('sortOrder')]),
      fetchAllRows('products'),
    ])
    const accessories = accRows
      .map(mapAccessory)
      .filter((a) => a.category !== 'Vlastní výroba' && a.slug !== 'zadni-zabrana')
    const products = prodRows.map(mapProduct).filter((p) => p.typeSlug !== 'zadni-zabrana')
    return { accessories, products }
  }

  function buildStats(accessories: ReturnType<typeof mapAccessory>[], products: ReturnType<typeof mapProduct>[]) {
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
      shipping: { rates: SHIPPING_RATES, averageParcel: SHIPPING_AVG },
      updatedAt: new Date().toISOString(),
    }
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  }

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = req.url || ''
    const url = raw.replace(/^\/acc-db(?=\/)/, '')
    if (!url.startsWith('/api/')) return next()

    const method = (req.method || 'GET').toUpperCase()

    try {
      if (method === 'GET' && url.startsWith('/api/stats')) {
        const { accessories, products } = await loadCatalog()
        json(res, 200, buildStats(accessories, products))
        return
      }

      if (method === 'GET' && url.startsWith('/api/accessories')) {
        const { accessories } = await loadCatalog()
        const items = accessories.sort((a, b) => a.sortOrder - b.sortOrder)
        json(res, 200, { items, updatedAt: new Date().toISOString() })
        return
      }

      if (method === 'GET' && url.startsWith('/api/products')) {
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
              String(p.sku || '').toLocaleLowerCase('cs').includes(q),
          )
        }
        items.sort((a, b) => a.priceVat - b.priceVat)
        const suppliers = [...new Set(items.map((p) => p.supplier))].sort()
        json(res, 200, { items, suppliers, total: items.length })
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
