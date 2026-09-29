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
