export type Unit = 'ks' | 'L'

export interface AccessoryType {
  id: string
  name: string
  category: string
  unit: Unit
  priceApprox: number
  sortOrder: number
  slug: string
  parentSlug: string | null
  relatedGroup?: string | null
  relatedSlugs?: string[]
  productCount?: number
}

export interface RelatedGroup {
  id: string
  label: string
  slugs: string[]
}

export interface Product {
  id: string
  name: string
  typeSlug: string
  supplier: string
  price: number
  priceVat: number
  unit: Unit
  dimensions: string | null
  imageUrl: string | null
  productUrl: string | null
  sku: string | null
  note: string | null
}

export interface CartLine {
  productId: string
  qty: number
}

export type CartMap = Record<string, number>

export interface CatalogUpdateStatus {
  state: 'idle' | 'running' | 'ok' | 'error'
  phase: string
  startedAt: string | null
  finishedAt: string | null
  logs: string[]
  error: string | null
  counts: {
    total: number
    bySupplier: Record<string, number>
    byType: Record<string, number>
  } | null
  seed: { accessories: number; products: number; created: number; updated: number } | null
}

export interface PriceHistoryEntry {
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
