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

/** @type {Array<Record<string, unknown>>} */
const accessories = [
  { slug: 'blatniky', name: 'Blatníky', category: 'Podvozek', unit: 'ks', priceApprox: 1400, priceMin: 360, priceMax: 9300, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/blatniky-c10/', note: null, sortOrder: 10, parentSlug: null },
  { slug: 'zasterky-do-blatniku', name: 'Zástěrky do blatníků', category: 'Podvozek', unit: 'ks', priceApprox: 770, priceMin: 100, priceMax: 2800, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/zasterky-c76/', note: null, sortOrder: 11, parentSlug: 'blatniky' },
  { slug: 'drzaky-blatniku', name: 'Držáky blatníků', category: 'Podvozek', unit: 'ks', priceApprox: 400, priceMin: 80, priceMax: 1200, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-drzaky-blatniku', note: null, sortOrder: 12, parentSlug: 'blatniky' },
  { slug: 'bocni-zabrany', name: 'Boční zábrany', category: 'Podvozek', unit: 'ks', priceApprox: 1200, priceMin: 300, priceMax: 1800, source: 'ALSAP', sourceUrl: 'https://www.alsap.cz/bocni-zabrana-proti-podjeti-c5/', note: null, sortOrder: 20, parentSlug: null },
  { slug: 'box-na-naradi', name: 'Box na nářadí', category: 'Podvozek', unit: 'ks', priceApprox: 4600, priceMin: 500, priceMax: 29000, source: 'ALSAP / Hydrotruck / Trans-Technik', sourceUrl: 'https://www.alsap.cz/bedny-na-naradi-c34/', note: null, sortOrder: 30, parentSlug: null },
  { slug: 'drzak-rezervy', name: 'Držák rezervy', category: 'Podvozek', unit: 'ks', priceApprox: 2000, priceMin: 350, priceMax: 10000, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/drzaky-rezervy-c77/', note: null, sortOrder: 40, parentSlug: null },
  { slug: 'hasici-pristroj', name: 'Hasicí přístroj', category: 'Podvozek', unit: 'ks', priceApprox: 2500, priceMin: 800, priceMax: 4500, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/bedny-na-hasici-pristroj-c235/', note: null, sortOrder: 50, parentSlug: null },
  { slug: 'majak', name: 'Maják', category: 'Podvozek', unit: 'ks', priceApprox: 2400, priceMin: 1300, priceMax: 3100, source: 'ALSAP', sourceUrl: 'https://www.alsap.cz/led-majaky-c934/', note: null, sortOrder: 60, parentSlug: null },
  { slug: 'nadoba-na-vodu', name: 'Nádoba na vodu', category: 'Podvozek', unit: 'ks', priceApprox: 610, priceMin: 90, priceMax: 4500, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/kanystry-na-vodu-c234/', note: null, sortOrder: 70, parentSlug: null },
  { slug: 'uzivatelska-zasuvka', name: 'Uživatelská zásuvka', category: 'Podvozek', unit: 'ks', priceApprox: 800, priceMin: 70, priceMax: 2500, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/zasuvky-zastrcky-a-konektory-c520/', note: null, sortOrder: 80, parentSlug: null },
  { slug: 'cerpadlo', name: 'Čerpadlo', category: 'Všechny nástavby', unit: 'ks', priceApprox: 12000, priceMin: 2200, priceMax: 28500, source: 'ALSAP / Hydrotruck / Trans-Technik', sourceUrl: 'https://www.alsap.cz/hydraulicka-cerpadla-spx-c598/', note: null, sortOrder: 110, parentSlug: null },
  { slug: 'hydraulicky-olej', name: 'Hydraulický olej', category: 'Všechny nástavby', unit: 'L', priceApprox: 95, priceMin: 60, priceMax: 150, source: 'Hydrotruck / ALSAP', sourceUrl: 'https://www.hydrotruck.cz/', note: null, sortOrder: 120, parentSlug: null },
  { slug: 'kamery', name: 'Kamery', category: 'Všechny nástavby', unit: 'ks', priceApprox: 5950, priceMin: 820, priceMax: 6500, source: 'ALSAP / Trans-Technik', sourceUrl: 'https://www.alsap.cz/parkovaci-kamery-c1228/', note: null, sortOrder: 130, parentSlug: null },
  { slug: 'olejova-nadrz', name: 'Olejová nádrž', category: 'Všechny nástavby', unit: 'ks', priceApprox: 15000, priceMin: 5000, priceMax: 35000, source: 'Hydrotruck / Trans-Technik', sourceUrl: 'https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove', note: null, sortOrder: 140, parentSlug: null },
  { slug: 'pracovni-svetla', name: 'Pracovní světla', category: 'Všechny nástavby', unit: 'ks', priceApprox: 1440, priceMin: 180, priceMax: 2500, source: 'ALSAP / Hydrotruck / Trans-Technik', sourceUrl: 'https://www.alsap.cz/led-pracovni-osvetleni-c134/', note: null, sortOrder: 150, parentSlug: null },
  { slug: 'navarovaci-oko', name: 'Navařovací oko', category: 'Hákový nosič kontejneru', unit: 'ks', priceApprox: 450, priceMin: 90, priceMax: 2400, source: 'ALSAP', sourceUrl: 'https://www.alsap.cz/oka-upevnovaci-c31/', note: null, sortOrder: 160, parentSlug: null },
  { slug: 'klece-na-podkladaci-desky', name: 'Klece na podkládací desky', category: 'Ostatní', unit: 'ks', priceApprox: 8500, priceMin: 5000, priceMax: 20000, source: 'ALSAP', sourceUrl: 'https://www.alsap.cz/kose-na-palety-c604/', note: null, sortOrder: 190, parentSlug: null },
  { slug: 'podkladaci-desky', name: 'Podkládací desky', category: 'Ostatní', unit: 'ks', priceApprox: 1200, priceMin: 400, priceMax: 3500, source: 'tržní odhad', sourceUrl: null, note: null, sortOrder: 200, parentSlug: null },
  { slug: 'vazaci-prostredky', name: 'Vázací prostředky', category: 'Ostatní', unit: 'ks', priceApprox: 800, priceMin: 65, priceMax: 1500, source: 'ALSAP', sourceUrl: 'https://www.alsap.cz/upinaci-popruhy-c1320/', note: null, sortOrder: 210, parentSlug: null },
]

function productId(p) {
  const raw = `${p.supplier}|${p.productUrl || p.name}`
  return createHash('sha1').update(raw).digest('hex').slice(0, 32)
}

function safeUrl(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    // Encode spaces/unsafe chars while keeping already-encoded sequences
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

// delete products for removed types + re-seed
let deletedProducts = 0
let cursor
for (;;) {
  const queries = [Query.limit(100)]
  if (cursor) queries.push(Query.cursorAfter(cursor))
  const batch = await db.listRows({ databaseId, tableId: 'products', queries })
  if (!batch.rows.length) break
  for (const row of batch.rows) {
    const typeSlug = row.typeSlug
    if (typeSlug === 'zadni-zabrana' || !keepSlugs.has(typeSlug)) {
      // only delete zadni-zabrana explicitly; keep unknown types for safety except zadni
      if (typeSlug === 'zadni-zabrana') {
        try {
          await db.deleteRow({ databaseId, tableId: 'products', rowId: row.$id })
          deletedProducts++
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (batch.rows.length < 100) break
  cursor = batch.rows[batch.rows.length - 1].$id
}
console.log('deleted zadni products', deletedProducts)

let created = 0
let updated = 0
for (const p of products) {
  if (p.typeSlug === 'zadni-zabrana') continue
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
}

const acc = await db.listRows({ databaseId, tableId: 'accessories', queries: [Query.limit(100)] })
const prod = await db.listRows({ databaseId, tableId: 'products', queries: [Query.limit(1)] })
console.log(`accessories: ${acc.total}`)
console.log(`products: ${prod.total} (created ${created}, updated ${updated})`)
