#!/usr/bin/env node
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client, TablesDB, Permission, Role, Query } from 'node-appwrite'

const endpoint = process.env.APPWRITE_ENDPOINT
const projectId = process.env.APPWRITE_PROJECT_ID
const apiKey = process.env.APPWRITE_API_KEY
const databaseId = process.env.APPWRITE_DATABASE_ID || 'acc-db'

if (!endpoint || !projectId || !apiKey) {
  console.error('Missing APPWRITE_* env')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const products = JSON.parse(readFileSync(join(__dirname, 'scraped_products.json'), 'utf8'))
const categoryMap = JSON.parse(readFileSync(join(__dirname, 'category-map.json'), 'utf8'))

const accessories = categoryMap.accessories.map((a) => {
  const typeProducts = products.filter((p) => p.typeSlug === a.slug)
  const prices = typeProducts.map((p) => Number(p.price)).filter((n) => n > 0)
  const suppliers = [...new Set(typeProducts.map((p) => p.supplier).filter((s) => s !== 'tržní odhad'))]
  return {
    slug: a.slug,
    name: a.name,
    category: a.category,
    unit: a.unit,
    priceApprox: a.priceApprox,
    priceMin: prices.length ? Math.min(...prices) : a.priceApprox,
    priceMax: prices.length ? Math.max(...prices) : a.priceApprox,
    source: suppliers.join(' / ') || 'katalog',
    sourceUrl: null,
    note: a.relatedGroup ? `related:${a.relatedGroup}` : null,
    sortOrder: a.sortOrder,
    parentSlug: a.parentSlug,
  }
})

function productId(p) {
  const raw = `${p.supplier}|${p.productUrl || p.name}`
  return createHash('sha1').update(raw).digest('hex').slice(0, 32)
}

function safeUrl(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed.replace(/ /g, '%20'))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey)
const db = new TablesDB(client)

const REMOVE_ACCESSORIES = ['kos-na-sit', 'meziram', 'zadni-zabrana']
for (const id of REMOVE_ACCESSORIES) {
  try {
    await db.deleteRow({ databaseId, tableId: 'accessories', rowId: id })
    console.log('removed accessory', id)
  } catch {
    /* already gone */
  }
}

const keepSlugs = new Set(accessories.map((a) => a.slug))

for (const item of accessories) {
  try {
    await db.getRow({ databaseId, tableId: 'accessories', rowId: item.slug })
    await db.updateRow({ databaseId, tableId: 'accessories', rowId: item.slug, data: item })
    console.log('acc upd', item.slug)
  } catch {
    await db.createRow({
      databaseId,
      tableId: 'accessories',
      rowId: item.slug,
      data: item,
      permissions: [Permission.read(Role.any())],
    })
    console.log('acc new', item.slug)
  }
}

// Remove products whose typeSlug is no longer in taxonomy (except keep during partial runs)
let deletedProducts = 0
let cursor
const keepIds = new Set(products.filter((p) => p.typeSlug !== 'zadni-zabrana').map(productId))
for (;;) {
  const queries = [Query.limit(100)]
  if (cursor) queries.push(Query.cursorAfter(cursor))
  const batch = await db.listRows({ databaseId, tableId: 'products', queries })
  if (!batch.rows.length) break
  for (const row of batch.rows) {
    const typeSlug = row.typeSlug
    const shouldDelete =
      typeSlug === 'zadni-zabrana' ||
      (keepSlugs.has(typeSlug) === false && typeSlug) ||
      (keepSlugs.has(typeSlug) && !keepIds.has(row.$id))
    // Only aggressively delete unknown types that look obsolete; keep unknown during migration
    if (typeSlug === 'zadni-zabrana' || (keepSlugs.has(typeSlug) && !keepIds.has(row.$id))) {
      try {
        await db.deleteRow({ databaseId, tableId: 'products', rowId: row.$id })
        deletedProducts++
      } catch {
        /* ignore */
      }
    }
  }
  if (batch.rows.length < 100) break
  cursor = batch.rows[batch.rows.length - 1].$id
}
console.log('deleted stale products', deletedProducts)

let created = 0
let updated = 0
for (const p of products) {
  if (p.typeSlug === 'zadni-zabrana') continue
  if (!keepSlugs.has(p.typeSlug)) continue
  const rowId = productId(p)
  const data = {
    name: p.name,
    typeSlug: p.typeSlug,
    supplier: p.supplier,
    price: Number(p.price),
    priceVat: Number(p.priceVat),
    unit: p.unit || 'ks',
    dimensions: p.dimensions || null,
    imageUrl: safeUrl(p.imageUrl),
    productUrl: safeUrl(p.productUrl),
    sku: p.sku || null,
    note: p.note || null,
  }
  try {
    await db.getRow({ databaseId, tableId: 'products', rowId })
    await db.updateRow({ databaseId, tableId: 'products', rowId, data })
    updated++
  } catch {
    await db.createRow({
      databaseId,
      tableId: 'products',
      rowId,
      data,
      permissions: [Permission.read(Role.any())],
    })
    created++
  }
  if ((created + updated) % 100 === 0) {
    console.log(`products progress ${created + updated}/${products.length}`)
  }
}

const acc = await db.listRows({ databaseId, tableId: 'accessories', queries: [Query.limit(100)] })
const prod = await db.listRows({ databaseId, tableId: 'products', queries: [Query.limit(1)] })
console.log(`accessories: ${acc.total}`)
console.log(`products: ${prod.total} (created ${created}, updated ${updated})`)
console.log(
  JSON.stringify({
    ok: true,
    accessories: acc.total,
    products: prod.total,
    created,
    updated,
    deletedProducts,
  }),
)
