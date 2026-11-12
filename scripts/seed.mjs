#!/usr/bin/env node
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const databaseUrl = (process.env.DATABASE_URL || '').trim()
if (!databaseUrl) {
  console.error('Missing DATABASE_URL')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const products = JSON.parse(readFileSync(join(__dirname, 'scraped_products.json'), 'utf8'))
const categoryMap = JSON.parse(readFileSync(join(__dirname, 'category-map.json'), 'utf8'))
const initSql = readFileSync(join(__dirname, 'sql', '001_init.sql'), 'utf8')

const UNIT_ELEMENTS = ['ks', 'L', 'm']

function normalizeUnit(unit) {
  const u = String(unit || 'ks').trim()
  return UNIT_ELEMENTS.includes(u) ? u : 'ks'
}

function buildAccessories() {
  return categoryMap.accessories.map((a) => {
    const typeProducts = products.filter((p) => p.typeSlug === a.slug)
    const prices = typeProducts.map((p) => Number(p.price)).filter((n) => n > 0)
    const suppliers = [...new Set(typeProducts.map((p) => p.supplier).filter((s) => s !== 'tržní odhad'))]
    return {
      slug: a.slug,
      name: a.name,
      category: a.category,
      unit: normalizeUnit(a.unit),
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
}

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

const client = new pg.Client({ connectionString: databaseUrl })

async function main() {
  await client.connect()
  await client.query(initSql)

  const accessories = buildAccessories()
  const REMOVE_ACCESSORIES = ['kos-na-sit', 'meziram', 'zadni-zabrana']
  for (const id of REMOVE_ACCESSORIES) {
    await client.query('DELETE FROM accessories WHERE slug = $1', [id])
    console.log('removed accessory', id)
  }

  const keepSlugs = new Set(accessories.map((a) => a.slug))

  for (const item of accessories) {
    await client.query(
      `INSERT INTO accessories (
         slug, name, category, unit, price_approx, price_min, price_max,
         source, source_url, note, sort_order, parent_slug
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         unit = EXCLUDED.unit,
         price_approx = EXCLUDED.price_approx,
         price_min = EXCLUDED.price_min,
         price_max = EXCLUDED.price_max,
         source = EXCLUDED.source,
         source_url = EXCLUDED.source_url,
         note = EXCLUDED.note,
         sort_order = EXCLUDED.sort_order,
         parent_slug = EXCLUDED.parent_slug`,
      [
        item.slug,
        item.name,
        item.category,
        item.unit,
        item.priceApprox,
        item.priceMin,
        item.priceMax,
        item.source,
        item.sourceUrl,
        item.note,
        item.sortOrder,
        item.parentSlug,
      ],
    )
    console.log('acc upsert', item.slug)
  }

  const keepIds = new Set(products.filter((p) => p.typeSlug !== 'zadni-zabrana').map(productId))

  const { rows: existingProducts } = await client.query(
    'SELECT id, supplier, is_active FROM products',
  )
  const dbBySupplier = {}
  const newBySupplier = {}
  for (const row of existingProducts) {
    dbBySupplier[row.supplier] = (dbBySupplier[row.supplier] || 0) + 1
  }
  for (const p of products) newBySupplier[p.supplier] = (newBySupplier[p.supplier] || 0) + 1

  const protectedSuppliers = new Set(
    Object.keys(dbBySupplier).filter(
      (s) =>
        dbBySupplier[s] >= 20 &&
        (newBySupplier[s] || 0) < dbBySupplier[s] * 0.5 &&
        process.env.SEED_FORCE_DELETE !== '1',
    ),
  )
  if (protectedSuppliers.size) {
    console.warn(
      `WARN: scrape looks incomplete for ${[...protectedSuppliers].join(', ')} ` +
        `(db ${[...protectedSuppliers].map((s) => dbBySupplier[s]).join('/')} → new ${[...protectedSuppliers]
          .map((s) => newBySupplier[s] || 0)
          .join('/')}); ` +
        'keeping their active products (set SEED_FORCE_DELETE=1 to deactivate)',
    )
  }

  let deactivated = 0
  for (const row of existingProducts) {
    // Soft-deactivate active products missing from this scrape (unless supplier protected)
    if (!row.is_active) continue
    if (keepIds.has(row.id)) continue
    if (protectedSuppliers.has(row.supplier)) continue
    await client.query('UPDATE products SET is_active = false WHERE id = $1', [row.id])
    deactivated++
  }
  // Also deactivate products whose typeSlug is zadni-zabrana or not in keepSlugs
  const { rowCount: typeDeact } = await client.query(
    `UPDATE products SET is_active = false
     WHERE is_active = true
       AND (type_slug = 'zadni-zabrana' OR type_slug <> ALL($1::text[]))
       AND NOT (supplier = ANY($2::text[]))`,
    [[...keepSlugs], [...protectedSuppliers]],
  )
  deactivated += typeDeact || 0
  console.log('deactivated products', deactivated)

  let created = 0
  let updated = 0
  let priceChanges = 0

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
      unit: normalizeUnit(p.unit),
      dimensions: p.dimensions || null,
      imageUrl: safeUrl(p.imageUrl),
      productUrl: safeUrl(p.productUrl),
      sku: p.sku || null,
      note: p.note || null,
      datasheetUrl: safeUrl(p.datasheetUrl) || null,
    }

    const existing = await client.query(
      'SELECT id, price, price_vat FROM products WHERE id = $1',
      [rowId],
    )

    if (existing.rows.length) {
      const old = existing.rows[0]
      const oldPrice = Number(old.price)
      const oldPriceVat = Number(old.price_vat)
      const priceChanged =
        Number.isFinite(oldPrice) &&
        Number.isFinite(oldPriceVat) &&
        (Math.abs(oldPrice - data.price) > 0.009 || Math.abs(oldPriceVat - data.priceVat) > 0.009)
      if (priceChanged) {
        await client.query(
          `INSERT INTO price_history (
             product_id, old_price, new_price, old_price_vat, new_price_vat,
             recorded_at, supplier, name
           ) VALUES ($1,$2,$3,$4,$5, now(), $6, $7)`,
          [rowId, oldPrice, data.price, oldPriceVat, data.priceVat, data.supplier, data.name],
        )
        priceChanges++
      }
      await client.query(
        `UPDATE products SET
           name = $2, type_slug = $3, supplier = $4, price = $5, price_vat = $6, unit = $7,
           dimensions = $8, image_url = $9, product_url = $10, sku = $11, note = $12,
           datasheet_url = $13, is_active = true, last_seen_at = now()
         WHERE id = $1`,
        [
          rowId,
          data.name,
          data.typeSlug,
          data.supplier,
          data.price,
          data.priceVat,
          data.unit,
          data.dimensions,
          data.imageUrl,
          data.productUrl,
          data.sku,
          data.note,
          data.datasheetUrl,
        ],
      )
      updated++
    } else {
      await client.query(
        `INSERT INTO products (
           id, name, type_slug, supplier, price, price_vat, unit,
           dimensions, image_url, product_url, sku, note, datasheet_url,
           is_active, last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, true, now())`,
        [
          rowId,
          data.name,
          data.typeSlug,
          data.supplier,
          data.price,
          data.priceVat,
          data.unit,
          data.dimensions,
          data.imageUrl,
          data.productUrl,
          data.sku,
          data.note,
          data.datasheetUrl,
        ],
      )
      created++
    }

    if ((created + updated) % 100 === 0) {
      console.log(`products progress ${created + updated}/${products.length}`)
    }
  }

  const accCount = (await client.query('SELECT count(*)::int AS n FROM accessories')).rows[0].n
  const prodCount = (
    await client.query('SELECT count(*)::int AS n FROM products WHERE is_active = true')
  ).rows[0].n
  const historyTotal = (await client.query('SELECT count(*)::int AS n FROM price_history')).rows[0].n

  console.log(`accessories: ${accCount}`)
  console.log(`products (active): ${prodCount} (created ${created}, updated ${updated}, deactivated ${deactivated})`)
  console.log(`price_history: ${historyTotal} (new changes this run ${priceChanges})`)
  console.log(
    JSON.stringify({
      ok: true,
      accessories: accCount,
      products: prodCount,
      created,
      updated,
      deactivated,
      priceChanges,
      priceHistoryTotal: historyTotal,
    }),
  )
}

try {
  await main()
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
