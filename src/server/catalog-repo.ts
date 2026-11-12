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

function relatedFromNote(note: string | null): string | null {
  if (!note) return null
  const m = note.match(/^related:(.+)$/)
  return m ? m[1] : null
}

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
     ORDER BY sort_order ASC`,
    undefined,
    env,
  )
  return rows
    .filter((r) => r.category !== 'Vlastní výroba' && r.slug !== 'zadni-zabrana')
    .map((r) => ({
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

export async function listProducts(env?: Record<string, string>): Promise<ProductRow[]> {
  const { rows } = await query<{
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
  }>(
    `SELECT id, name, type_slug, supplier, price, price_vat, unit,
            dimensions, image_url, product_url, sku, note, datasheet_url
     FROM products
     WHERE is_active = true`,
    undefined,
    env,
  )
  return rows
    .filter((r) => r.type_slug !== 'zadni-zabrana')
    .map((r) => ({
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
    }))
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
