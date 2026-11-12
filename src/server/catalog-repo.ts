import { query } from './db.ts'

export type AccessoryRow = {
  id: string
  name: string
  category: string
  unit: 'ks' | 'L' | 'm'
  priceApprox: number
  sortOrder: number
  slug: string
  parentSlug: string | null
  relatedGroup: string | null
}

export type ProductRow = {
  id: string
  name: string
  typeSlug: string
  supplier: string
  price: number
  priceVat: number
  unit: 'ks' | 'L' | 'm'
  dimensions: string | null
  imageUrl: string | null
  productUrl: string | null
  sku: string | null
  note: string | null
  datasheetUrl: string | null
}

export type PriceHistoryRow = {
  id: string
  productId: string
  oldPrice: number
  newPrice: number
  oldPriceVat: number
  newPriceVat: number
  recordedAt: string
  supplier: string | null
  name: string | null
}

export type ProductQuery = {
  typeSlug?: string | null
  suppliers?: string[]
  q?: string | null
  sort?: 'price_asc' | 'price_desc'
  ids?: string[]
}

type ProductSqlRow = {
  id: string
  name: string
  type_slug: string
  supplier: string
  price: string
  price_vat: string
  unit: string
  dimensions: string | null
  image_url: string | null
  product_url: string | null
  sku: string | null
  note: string | null
  datasheet_url: string | null
}

function relatedFromNote(note: string | null): string | null {
  if (!note) return null
  const m = note.match(/^related:(.+)$/)
  return m ? m[1] : null
}

function mapProduct(r: ProductSqlRow): ProductRow {
  return {
    id: r.id,
    name: r.name,
    typeSlug: r.type_slug,
    supplier: r.supplier,
    price: Number(r.price),
    priceVat: Number(r.price_vat),
    unit: (r.unit as 'ks' | 'L' | 'm') || 'ks',
    dimensions: r.dimensions || null,
    imageUrl: r.image_url || null,
    productUrl: r.product_url || null,
    sku: r.sku || null,
    note: r.note || null,
    datasheetUrl: r.datasheet_url || null,
  }
}

const PRODUCT_COLS = `id, name, type_slug, supplier, price, price_vat, unit,
            dimensions, image_url, product_url, sku, note, datasheet_url`

export async function listAccessories(env?: Record<string, string>): Promise<AccessoryRow[]> {
  const { rows } = await query<{
    slug: string
    name: string
    category: string
    unit: string
    price_approx: string
    sort_order: number
    parent_slug: string | null
    note: string | null
  }>(
    `SELECT slug, name, category, unit, price_approx, sort_order, parent_slug, note
     FROM accessories
     WHERE category <> 'Vlastní výroba'
       AND slug <> 'zadni-zabrana'
     ORDER BY sort_order ASC`,
    undefined,
    env,
  )
  return rows.map((r) => ({
    id: r.slug,
    slug: r.slug,
    name: r.name,
    category: r.category,
    unit: (r.unit as 'ks' | 'L' | 'm') || 'ks',
    priceApprox: Number(r.price_approx),
    sortOrder: Number(r.sort_order),
    parentSlug: r.parent_slug || null,
    relatedGroup: relatedFromNote(r.note),
  }))
}

/** Active products with optional filters — filtering happens in SQL, not in JS. */
export async function queryProducts(
  opts: ProductQuery = {},
  env?: Record<string, string>,
): Promise<ProductRow[]> {
  const where: string[] = [`is_active = true`, `type_slug <> 'zadni-zabrana'`]
  const params: unknown[] = []

  if (opts.ids?.length) {
    params.push(opts.ids)
    where.push(`id = ANY($${params.length}::text[])`)
  }
  if (opts.typeSlug) {
    params.push(opts.typeSlug)
    where.push(`type_slug = $${params.length}`)
  }
  if (opts.suppliers?.length) {
    params.push(opts.suppliers)
    where.push(`supplier = ANY($${params.length}::text[])`)
  }
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim()}%`)
    const i = params.length
    where.push(
      `(name ILIKE $${i} OR supplier ILIKE $${i} OR COALESCE(dimensions,'') ILIKE $${i} OR COALESCE(sku,'') ILIKE $${i} OR type_slug ILIKE $${i})`,
    )
  }

  const sort = opts.sort === 'price_desc' ? 'price_desc' : 'price_asc'
  const order =
    sort === 'price_desc'
      ? `(price > 0) DESC, price_vat DESC NULLS LAST, name ASC`
      : `(price > 0) DESC, price_vat ASC NULLS LAST, name ASC`

  const { rows } = await query<ProductSqlRow>(
    `SELECT ${PRODUCT_COLS}
     FROM products
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}`,
    params,
    env,
  )
  return rows.map(mapProduct)
}

export async function listAllSuppliers(env?: Record<string, string>): Promise<string[]> {
  const { rows } = await query<{ supplier: string }>(
    `SELECT DISTINCT supplier
     FROM products
     WHERE is_active = true
       AND type_slug <> 'zadni-zabrana'
       AND supplier <> ''
       AND supplier <> 'tržní odhad'
     ORDER BY supplier ASC`,
    undefined,
    env,
  )
  return rows.map((r) => r.supplier)
}

export async function productCountsByType(env?: Record<string, string>): Promise<Record<string, number>> {
  const { rows } = await query<{ type_slug: string; n: string }>(
    `SELECT type_slug, count(*)::int AS n
     FROM products
     WHERE is_active = true AND type_slug <> 'zadni-zabrana'
     GROUP BY type_slug`,
    undefined,
    env,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.type_slug] = Number(r.n)
  return out
}

export async function catalogStats(env?: Record<string, string>) {
  const [acc, prod, bySupplier, byType, imgBySup] = await Promise.all([
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accessories
       WHERE category <> 'Vlastní výroba' AND slug <> 'zadni-zabrana'`,
      undefined,
      env,
    ),
    query<{
      n: number
      with_image: number
      min_vat: string | null
      max_vat: string | null
      avg_vat: string | null
      categories: number
    }>(
      `SELECT
         count(*)::int AS n,
         count(*) FILTER (WHERE image_url IS NOT NULL AND image_url <> '')::int AS with_image,
         min(price_vat) FILTER (WHERE price_vat > 0) AS min_vat,
         max(price_vat) FILTER (WHERE price_vat > 0) AS max_vat,
         avg(price_vat) FILTER (WHERE price_vat > 0) AS avg_vat,
         (SELECT count(DISTINCT category)::int FROM accessories
           WHERE category <> 'Vlastní výroba' AND slug <> 'zadni-zabrana') AS categories
       FROM products
       WHERE is_active = true AND type_slug <> 'zadni-zabrana'`,
      undefined,
      env,
    ),
    query<{ supplier: string; n: number }>(
      `SELECT supplier, count(*)::int AS n
       FROM products
       WHERE is_active = true AND type_slug <> 'zadni-zabrana'
       GROUP BY supplier`,
      undefined,
      env,
    ),
    productCountsByType(env),
    query<{ supplier: string; n: number }>(
      `SELECT supplier, count(*)::int AS n
       FROM products
       WHERE is_active = true AND type_slug <> 'zadni-zabrana'
         AND image_url IS NOT NULL AND image_url <> ''
       GROUP BY supplier`,
      undefined,
      env,
    ),
  ])
  const bySupplierMap: Record<string, number> = {}
  for (const r of bySupplier.rows) bySupplierMap[r.supplier] = Number(r.n)
  const withImageBySupplier: Record<string, number> = {}
  for (const r of imgBySup.rows) withImageBySupplier[r.supplier] = Number(r.n)

  const p = prod.rows[0]
  return {
    types: Number(acc.rows[0]?.n || 0),
    products: Number(p?.n || 0),
    categories: Number(p?.categories || 0),
    suppliers: Object.keys(bySupplierMap).filter((s) => s !== 'tržní odhad').length,
    bySupplier: bySupplierMap,
    byType,
    withImage: Number(p?.with_image || 0),
    withImageBySupplier,
    priceVat: {
      min: p?.min_vat != null ? Number(p.min_vat) : 0,
      max: p?.max_vat != null ? Number(p.max_vat) : 0,
      avg: p?.avg_vat != null ? Math.round(Number(p.avg_vat)) : 0,
    },
  }
}

export async function priceHistory(
  productId: string,
  env?: Record<string, string>,
): Promise<PriceHistoryRow[]> {
  const { rows } = await query<{
    id: string
    product_id: string
    old_price: string
    new_price: string
    old_price_vat: string
    new_price_vat: string
    recorded_at: Date
    supplier: string | null
    name: string | null
  }>(
    `SELECT id::text, product_id, old_price, new_price, old_price_vat, new_price_vat,
            recorded_at, supplier, name
     FROM price_history
     WHERE product_id = $1
     ORDER BY recorded_at DESC`,
    [productId],
    env,
  )
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    oldPrice: Number(r.old_price),
    newPrice: Number(r.new_price),
    oldPriceVat: Number(r.old_price_vat),
    newPriceVat: Number(r.new_price_vat),
    recordedAt: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : String(r.recorded_at),
    supplier: r.supplier || null,
    name: r.name || null,
  }))
}
