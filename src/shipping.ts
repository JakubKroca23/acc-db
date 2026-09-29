/** Average shipping estimates from public supplier price lists (CZ, parcel). */
export interface ShippingRate {
  supplier: string
  label: string
  priceExVat: number
  priceVat: number
  note: string
  freeFromExVat: number | null
  sourceUrl: string
}

export interface ShippingEstimate {
  supplier: string
  goodsExVat: number
  goodsVat: number
  shippingExVat: number
  shippingVat: number
  free: boolean
  note: string
}

/** Mid values from published tables (TT GLS, HT GLS/PPL). ALSAP has no fixed list → market estimate. */
export const SHIPPING_RATES: ShippingRate[] = [
  {
    supplier: 'Trans-Technik',
    label: 'GLS balík (průměr 5–30 kg)',
    priceExVat: Math.round((100 + 115 + 150 + 190) / 4 / 1.21),
    priceVat: Math.round((100 + 115 + 150 + 190) / 4),
    note: 'Zdarma od 5 000 Kč bez DPH (do 30 kg / 6 m). Parcel shop 75 Kč.',
    freeFromExVat: 5000,
    sourceUrl: 'https://www.trans-technik.cz/doprava-a-platba-napoveda',
  },
  {
    supplier: 'Hydrotruck',
    label: 'GLS/PPL balík (průměr do 31 kg)',
    priceExVat: Math.round((80 + 110 + 140 + 170) / 4),
    priceVat: Math.round(((80 + 110 + 140 + 170) / 4) * 1.21),
    note: 'Ceník GLS bez DPH: 80–170 Kč dle hmotnosti. Nad 50 kg paleta individuálně.',
    freeFromExVat: null,
    sourceUrl: 'https://www.hydrotruck.cz/doprava-a-platba',
  },
  {
    supplier: 'ALSAP',
    label: 'DPD / TOPTRANS (odhad)',
    priceExVat: 149,
    priceVat: Math.round(149 * 1.21),
    note: 'ALSAP neuvádí pevný ceník; odhad dle běžné DPD/TOPTRANS sazby pro balík do ~30 kg.',
    freeFromExVat: null,
    sourceUrl: 'https://www.alsap.cz/doprava_info/',
  },
]

/** Oversized / pallet-like accessory types → higher average freight. */
const OVERSIZE_TYPES = new Set([
  'blatniky',
  'olejova-nadrz',
  'bocni-zabrany',
  'box-na-naradi',
  'klece-na-podkladaci-desky',
  'zadni-zabrana',
])

const OVERSIZE_EX_VAT = 289 // ~ TOPTRANS mid + half-pallet feel
const OVERSIZE_VAT = Math.round(OVERSIZE_EX_VAT * 1.21)

export function rateForSupplier(supplier: string): ShippingRate | null {
  return SHIPPING_RATES.find((r) => r.supplier === supplier) || null
}

export function estimateShippingBySupplier(
  lines: { supplier: string; typeSlug: string; exVat: number; withVat: number }[],
): ShippingEstimate[] {
  const bySupplier = new Map<string, { ex: number; vat: number; oversize: boolean }>()
  for (const line of lines) {
    const cur = bySupplier.get(line.supplier) || { ex: 0, vat: 0, oversize: false }
    cur.ex += line.exVat
    cur.vat += line.withVat
    if (OVERSIZE_TYPES.has(line.typeSlug)) cur.oversize = true
    bySupplier.set(line.supplier, cur)
  }

  const estimates: ShippingEstimate[] = []
  for (const [supplier, totals] of bySupplier) {
    const rate = rateForSupplier(supplier)
    if (!rate) {
      // tržní odhad / unknown — skip or small flat
      if (supplier === 'tržní odhad') continue
      estimates.push({
        supplier,
        goodsExVat: totals.ex,
        goodsVat: totals.vat,
        shippingExVat: totals.oversize ? OVERSIZE_EX_VAT : 149,
        shippingVat: totals.oversize ? OVERSIZE_VAT : Math.round(149 * 1.21),
        free: false,
        note: 'Obecný odhad dopravy',
      })
      continue
    }

    const free = rate.freeFromExVat != null && totals.ex >= rate.freeFromExVat
    const shippingExVat = free ? 0 : totals.oversize ? Math.max(rate.priceExVat, OVERSIZE_EX_VAT) : rate.priceExVat
    const shippingVat = free ? 0 : totals.oversize ? Math.max(rate.priceVat, OVERSIZE_VAT) : rate.priceVat

    estimates.push({
      supplier,
      goodsExVat: totals.ex,
      goodsVat: totals.vat,
      shippingExVat,
      shippingVat,
      free,
      note: free
        ? `Doprava zdarma (práhy ${rate.freeFromExVat!.toLocaleString('cs-CZ')} Kč bez DPH)`
        : totals.oversize
          ? `${rate.label} + odhad nadrozměr / paleta`
          : rate.label,
    })
  }

  return estimates.sort((a, b) => a.supplier.localeCompare(b.supplier, 'cs'))
}

export const SHIPPING_AVG = {
  parcelExVat: Math.round(
    SHIPPING_RATES.reduce((s, r) => s + r.priceExVat, 0) / SHIPPING_RATES.length,
  ),
  parcelVat: Math.round(
    SHIPPING_RATES.reduce((s, r) => s + r.priceVat, 0) / SHIPPING_RATES.length,
  ),
  oversizeExVat: OVERSIZE_EX_VAT,
  oversizeVat: OVERSIZE_VAT,
}
