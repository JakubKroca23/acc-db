import './style.css'
import type { AccessoryType, CartMap, CatalogUpdateStatus, PriceHistoryEntry, Product, RelatedGroup } from './types'
import { estimateShippingBySupplier, type ShippingEstimate } from './shipping'

const STORAGE_KEY = 'acc-db-cart-v2'
const NOTE_KEY = 'acc-db-quote-note'
const API_BASE = `${import.meta.env.BASE_URL}api`
const app = document.querySelector<HTMLDivElement>('#app')!
if (!app) throw new Error('#app missing')

function formatCzk(value: number): string {
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency',
    currency: 'CZK',
    maximumFractionDigits: 0,
  }).format(value)
}

function formatCzkExact(value: number): string {
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency',
    currency: 'CZK',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function dualPrice(exVat: number, withVat: number): string {
  return `<span class="dual-price"><strong>${formatCzk(withVat)}</strong> <span class="muted">s DPH</span><br /><span>${formatCzk(exVat)}</span> <span class="muted">bez DPH</span></span>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;')
}

function loadCart(): CartMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CartMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCart() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cart))
}

function loadNote(): string {
  return localStorage.getItem(NOTE_KEY) || ''
}

function saveNote(v: string) {
  localStorage.setItem(NOTE_KEY, v)
  quoteNote = v
}

function clampQty(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(9999, Math.floor(n))
}

// ── state ─────────────────────────────────────────────────────────
let types: AccessoryType[] = []
let groups: RelatedGroup[] = []
let productsById = new Map<string, Product>()
let cart: CartMap = loadCart()
let quoteNote = loadNote()
let statusText = 'Načítám…'
let statusError = false

/** Pseudo-category „Vše“ — the whole catalogue across all categories. */
const ALL_SLUG = 'vse'
const PAGE_SIZE = 60

function slugFromHash(): string | null {
  const m = location.hash.match(/^#\/?([a-z0-9-]+)$/i)
  return m ? decodeURIComponent(m[1]) : null
}

// The quote („Cenová nabídka“) is a full-page view at #/nabidka (deep-linkable, browser Back returns to the catalog).
const QUOTE_HASH = 'nabidka'

let selectedSlug: string | null = slugFromHash() === QUOTE_HASH ? null : slugFromHash()
let renderLimit = PAGE_SIZE
let searchQ = ''
let supplierFilter = ''
let viewMode: 'browse' | 'search' | 'quote' = slugFromHash() === QUOTE_HASH ? 'quote' : 'browse'
let priceHistoryCache: Record<string, PriceHistoryEntry[]> = {}
let historyOpenId: string | null = null
let cartHydrated = false
/** true while the #/nabidka history entry was pushed by us → „Zpět do katalogu“ can use history.back() */
let quotePushed = false
let catalogScrollY = 0

let catalogItems: Product[] = []
let catalogSuppliers: string[] = []
let catalogLoading = false
let catalogError: string | null = null
let searchTimer: number | undefined

let updateStatus: CatalogUpdateStatus | null = null
let updatePolling: number | undefined
let toastMsg = ''

type DbStats = {
  types: number
  products: number
  suppliers: number
  bySupplier: Record<string, number>
  withImage: number
  updatedAt: string
}

let stats: DbStats | null = null

// ── data ──────────────────────────────────────────────────────────
async function loadBootstrap() {
  statusText = 'Načítám katalog…'
  statusError = false
  render()
  try {
    const [accRes, statsRes] = await Promise.all([
      fetch(`${API_BASE}/accessories`),
      fetch(`${API_BASE}/stats`),
    ])
    const accData = await accRes.json()
    if (!accRes.ok) throw new Error(accData.error || `HTTP ${accRes.status}`)
    types = (accData.items as AccessoryType[]).sort((a, b) => a.sortOrder - b.sortOrder)
    groups = (accData.groups as RelatedGroup[]) || []
    if (statsRes.ok) {
      stats = (await statsRes.json()) as DbStats
      updateStatus = (stats as DbStats & { catalogUpdate?: CatalogUpdateStatus }).catalogUpdate || null
    }
    // Default view = „Vše“, unless a (valid) category is already selected via #/slug.
    if (!selectedSlug || (selectedSlug !== ALL_SLUG && !types.some((t) => t.slug === selectedSlug))) {
      selectedSlug = ALL_SLUG
    }
    statusText = stats
      ? `${stats.products} produktů · ${stats.types} druhů · aktualizováno ${new Date(stats.updatedAt).toLocaleString('cs-CZ')}`
      : `Katalog načten · ${types.length} druhů`
    statusError = false
    await hydrateCartProducts()
    cartHydrated = true
    if (viewMode === 'quote') render()
    await loadProductsForCurrent()
  } catch (err) {
    statusText = err instanceof Error ? err.message : 'Chyba načtení'
    statusError = true
    render()
  }
}

async function hydrateCartProducts() {
  const missing = Object.keys(cart).filter((id) => !productsById.has(id))
  if (!missing.length) return
  try {
    const res = await fetch(`${API_BASE}/products`)
    const data = await res.json()
    if (!res.ok) return
    for (const p of data.items as Product[]) productsById.set(p.id, p)
  } catch {
    /* ignore */
  }
}

async function loadProductsForCurrent() {
  catalogLoading = true
  catalogError = null
  render()
  try {
    const params = new URLSearchParams()
    if (viewMode === 'search' && searchQ.trim()) {
      params.set('q', searchQ.trim())
    } else if (selectedSlug && selectedSlug !== ALL_SLUG) {
      params.set('type', selectedSlug)
    }
    if (supplierFilter) params.set('supplier', supplierFilter)
    const res = await fetch(`${API_BASE}/products?${params}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    catalogItems = data.items as Product[]
    renderLimit = PAGE_SIZE
    catalogSuppliers = data.suppliers as string[]
    for (const p of catalogItems) productsById.set(p.id, p)
    catalogLoading = false
  } catch (err) {
    catalogLoading = false
    catalogError = err instanceof Error ? err.message : 'Chyba'
  }
  render()
}

function currentType(): AccessoryType | undefined {
  return types.find((t) => t.slug === selectedSlug)
}

function relatedFor(slug: string | null): AccessoryType[] {
  if (!slug) return []
  const t = types.find((x) => x.slug === slug)
  if (!t) return []
  const slugs =
    t.relatedSlugs?.length
      ? t.relatedSlugs
      : groups.find((g) => g.id === t.relatedGroup)?.slugs.filter((s) => s !== slug) || []
  // also include siblings under same parent
  const extras = types.filter(
    (x) =>
      (t.parentSlug && x.parentSlug === t.parentSlug && x.slug !== slug) ||
      (x.parentSlug === slug) ||
      (t.parentSlug && x.slug === t.parentSlug),
  )
  const bySlug = new Map<string, AccessoryType>()
  for (const s of slugs) {
    const found = types.find((x) => x.slug === s)
    if (found) bySlug.set(found.slug, found)
  }
  for (const e of extras) bySlug.set(e.slug, e)
  return [...bySlug.values()].sort((a, b) => a.sortOrder - b.sortOrder)
}

function selectType(slug: string) {
  selectedSlug = slug
  viewMode = 'browse'
  searchQ = ''
  searchEl.value = ''
  supplierFilter = ''
  history.replaceState(null, '', slug === ALL_SLUG ? location.pathname + location.search : `#/${slug}`)
  window.scrollTo({ top: 0 })
  void loadProductsForCurrent()
}

function setQty(productId: string, value: number) {
  const next = clampQty(value)
  if (next === 0) delete cart[productId]
  else cart[productId] = next
  saveCart()
  render()
}

function addOne(product: Product) {
  productsById.set(product.id, product)
  setQty(product.id, (cart[product.id] || 0) + 1)
  toastMsg = `Přidáno do nabídky: ${product.name.slice(0, 48)}`
  window.setTimeout(() => {
    toastMsg = ''
    render()
  }, 1800)
}

function clearAll() {
  cart = {}
  saveCart()
  render()
}

function cartLines() {
  const lines: {
    product: Product
    qty: number
    lineExVat: number
    lineVat: number
  }[] = []
  for (const [id, qty] of Object.entries(cart)) {
    const product = productsById.get(id)
    if (!product || !qty) continue
    lines.push({
      product,
      qty,
      lineExVat: qty * product.price,
      lineVat: qty * product.priceVat,
    })
  }
  lines.sort((a, b) => a.product.name.localeCompare(b.product.name, 'cs'))
  return lines
}

function shippingForCart(lines: ReturnType<typeof cartLines>): ShippingEstimate[] {
  return estimateShippingBySupplier(
    lines.map((l) => ({
      supplier: l.product.supplier,
      typeSlug: l.product.typeSlug,
      exVat: l.lineExVat,
      withVat: l.lineVat,
    })),
  )
}

function typeName(slug: string): string {
  return types.find((t) => t.slug === slug)?.name || slug
}

function groupLinesBySupplier(lines: ReturnType<typeof cartLines>) {
  const map = new Map<string, typeof lines>()
  for (const l of lines) {
    const arr = map.get(l.product.supplier) || []
    arr.push(l)
    map.set(l.product.supplier, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'cs'))
}

// ── quote export ──────────────────────────────────────────────────
function buildQuoteText(): string {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const goodsEx = lines.reduce((a, l) => a + l.lineExVat, 0)
  const goodsVat = lines.reduce((a, l) => a + l.lineVat, 0)
  const shipEx = shipping.reduce((a, s) => a + s.shippingExVat, 0)
  const shipVat = shipping.reduce((a, s) => a + s.shippingVat, 0)
  const now = new Date().toLocaleString('cs-CZ')
  const out: string[] = []
  out.push('CENOVÁ NABÍDKA / ODHAD PŘÍSLUŠENSTVÍ')
  out.push(`Datum: ${now}`)
  out.push('Pozn.: Ceny jsou orientační z veřejných katalogů — ne závazný ceník.')
  if (quoteNote.trim()) {
    out.push('')
    out.push(`Poznámka: ${quoteNote.trim()}`)
  }
  out.push('')
  for (const [supplier, group] of groupLinesBySupplier(lines)) {
    out.push(`── ${supplier} ──`)
    for (const l of group) {
      const dims = l.product.dimensions ? ` [${l.product.dimensions}]` : ''
      const sku = l.product.sku ? ` SKU ${l.product.sku}` : ''
      out.push(
        `• ${l.product.name}${dims}${sku}`,
      )
      out.push(
        `  ${l.qty} ${l.product.unit} × ${formatCzkExact(l.product.price)} bez DPH / ${formatCzkExact(l.product.priceVat)} s DPH = ${formatCzkExact(l.lineExVat)} bez DPH / ${formatCzkExact(l.lineVat)} s DPH`,
      )
    }
    const subEx = group.reduce((a, l) => a + l.lineExVat, 0)
    const subVat = group.reduce((a, l) => a + l.lineVat, 0)
    const ship = shipping.find((s) => s.supplier === supplier)
    out.push(`  Mezisoučet zboží: ${formatCzkExact(subEx)} bez DPH / ${formatCzkExact(subVat)} s DPH`)
    if (ship) {
      out.push(
        `  Doprava: ${formatCzkExact(ship.shippingExVat)} bez DPH / ${formatCzkExact(ship.shippingVat)} s DPH (${ship.note})`,
      )
    }
    out.push('')
  }
  out.push('════════════════════════')
  out.push(`Zboží celkem:   ${formatCzkExact(goodsEx)} bez DPH / ${formatCzkExact(goodsVat)} s DPH`)
  out.push(`Doprava celkem: ${formatCzkExact(shipEx)} bez DPH / ${formatCzkExact(shipVat)} s DPH`)
  out.push(`CELKEM:         ${formatCzkExact(goodsEx + shipEx)} bez DPH / ${formatCzkExact(goodsVat + shipVat)} s DPH`)
  return out.join('\n')
}

function buildQuoteCsv(): string {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const rows: string[][] = [
    [
      'Dodavatel',
      'Kategorie',
      'Název',
      'SKU',
      'Rozměry',
      'Množství',
      'Jednotka',
      'Cena bez DPH',
      'Cena s DPH',
      'Řádek bez DPH',
      'Řádek s DPH',
    ],
  ]
  for (const l of lines) {
    rows.push([
      l.product.supplier,
      typeName(l.product.typeSlug),
      l.product.name,
      l.product.sku || '',
      l.product.dimensions || '',
      String(l.qty),
      l.product.unit,
      String(l.product.price).replace('.', ','),
      String(l.product.priceVat).replace('.', ','),
      String(Math.round(l.lineExVat * 100) / 100).replace('.', ','),
      String(Math.round(l.lineVat * 100) / 100).replace('.', ','),
    ])
  }
  for (const s of shipping) {
    rows.push([
      s.supplier,
      'Doprava',
      s.note,
      '',
      '',
      '1',
      'ks',
      String(s.shippingExVat).replace('.', ','),
      String(s.shippingVat).replace('.', ','),
      String(s.shippingExVat).replace('.', ','),
      String(s.shippingVat).replace('.', ','),
    ])
  }
  if (quoteNote.trim()) {
    rows.push(['', 'Poznámka', quoteNote.trim(), '', '', '', '', '', '', '', ''])
  }
  const esc = (c: string) => `"${c.replaceAll('"', '""')}"`
  return rows.map((r) => r.map(esc).join(';')).join('\n')
}

async function copyQuote() {
  const text = buildQuoteText()
  try {
    await navigator.clipboard.writeText(text)
    toastMsg = 'Nabídka zkopírována do schránky'
  } catch {
    toastMsg = 'Nepodařilo se zkopírovat — otevřete tisk a zkopírujte ručně'
  }
  render()
  window.setTimeout(() => {
    toastMsg = ''
    render()
  }, 2000)
}

function downloadCsv() {
  const blob = new Blob(['\uFEFF' + buildQuoteCsv()], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `nabidka-prislusenstvi-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

function printQuote() {
  // Print from the full-page quote view, after thumbnails load.
  if (viewMode !== 'quote') openQuoteView()
  const imgs = [...document.querySelectorAll<HTMLImageElement>('#quote-print img')]
  const ready = imgs.map((img) =>
    img.complete
      ? Promise.resolve()
      : new Promise<void>((r) => {
          img.addEventListener('load', () => r(), { once: true })
          img.addEventListener('error', () => r(), { once: true })
        }),
  )
  imgs.forEach((img) => (img.loading = 'eager'))
  void Promise.race([Promise.all(ready), new Promise((r) => window.setTimeout(r, 2500))]).then(() => window.print())
}

// ── catalog update ────────────────────────────────────────────────
async function triggerUpdate() {
  try {
    const headers: Record<string, string> = {}
    let token = localStorage.getItem('acc-db-update-token') || ''
    if (!token) {
      const entered = window.prompt(
        'Volitelný update token (ACC_DB_UPDATE_TOKEN). Nechte prázdné, pokud server token nevyžaduje:',
        '',
      )
      if (entered === null) return
      token = entered.trim()
      if (token) localStorage.setItem('acc-db-update-token', token)
    }
    if (token) headers['X-Update-Token'] = token
    const res = await fetch(`${API_BASE}/catalog/update`, { method: 'POST', headers })
    const data = await res.json()
    if (res.status === 401) {
      localStorage.removeItem('acc-db-update-token')
      throw new Error('Neplatný update token — zkuste znovu')
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    updateStatus = data.status as CatalogUpdateStatus
    toastMsg = data.started ? 'Aktualizace katalogu spuštěna…' : 'Aktualizace už běží'
    startUpdatePolling()
    render()
  } catch (err) {
    toastMsg = err instanceof Error ? err.message : 'Chyba aktualizace'
    render()
  }
}

function startUpdatePolling() {
  window.clearInterval(updatePolling)
  updatePolling = window.setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/catalog/update/status`)
      if (!res.ok) return
      updateStatus = (await res.json()) as CatalogUpdateStatus
      render()
      if (updateStatus.state === 'ok' || updateStatus.state === 'error') {
        window.clearInterval(updatePolling)
        if (updateStatus.state === 'ok') {
          toastMsg = 'Katalog aktualizován'
          await loadBootstrap()
        }
      }
    } catch {
      /* ignore */
    }
  }, 2000)
}

// ── supplier colours & images ─────────────────────────────────────
/** Stable CSS modifier for a supplier — ALSAP red, Trans-Technik blue, Hydrotruck green. */
function supplierKey(supplier: string): string {
  const s = supplier.toLocaleLowerCase('cs')
  if (s.includes('alsap')) return 'alsap'
  if (s.includes('trans')) return 'tt'
  if (s.includes('hydro')) return 'ht'
  return 'other'
}

function supplierBadge(supplier: string, extra = ''): string {
  return `<span class="sup-badge sup-${supplierKey(supplier)} ${extra}"><span class="sup-dot" aria-hidden="true"></span>${escapeHtml(supplier)}</span>`
}

/** All supplier thumbnails go through our own origin (cache, allowlist, jpg→webp repair). */
function imgSrc(url: string): string {
  return `${API_BASE}/img?url=${encodeURIComponent(url)}`
}

function thumbHtml(p: Product, cls = 'thumb-img'): string {
  if (!p.imageUrl) return `<div class="img-fallback sup-${supplierKey(p.supplier)}">${escapeHtml(p.supplier.slice(0, 1))}</div>`
  return `<img class="${cls}" src="${escapeAttr(imgSrc(p.imageUrl))}" alt="" loading="lazy" decoding="async" data-fallback="${escapeAttr(p.supplier.slice(0, 1))}" data-sup="${supplierKey(p.supplier)}" />`
}

// ── render helpers ────────────────────────────────────────────────
function itemsWord(n: number): string {
  return n === 1 ? 'položka' : n >= 2 && n <= 4 ? 'položky' : 'položek'
}

/** Per category (type slug): distinct items + pieces currently in the quote. */
function quoteCountsByType(): Map<string, { items: number; pcs: number }> {
  const m = new Map<string, { items: number; pcs: number }>()
  for (const [id, qty] of Object.entries(cart)) {
    const p = productsById.get(id)
    if (!p || !qty) continue
    const c = m.get(p.typeSlug) || { items: 0, pcs: 0 }
    c.items += 1
    c.pcs += qty
    m.set(p.typeSlug, c)
  }
  return m
}

/** Badge + screen-reader text for a nav item that has products in the quote (not colour-only). */
function navQuoteBadge(c: { items: number; pcs: number } | undefined): string {
  if (!c) return ''
  const label = `${c.items} ${itemsWord(c.items)} v nabídce (${c.pcs} ks)`
  return `<span class="nav-q" aria-hidden="true" title="${escapeAttr(label)}">${c.items}</span><span class="sr-only">, ${escapeHtml(label)}</span>`
}

function navHtml(): string {
  const qc = quoteCountsByType()
  const quoteTitle = (c: { items: number; pcs: number } | undefined) =>
    c ? `title="${escapeAttr(`${c.items} ${itemsWord(c.items)} v nabídce (${c.pcs} ks)`)}"` : ''
  const cats = [...new Set(types.map((t) => t.category))]
  const order = ['Podvozek', 'Všechny nástavby', 'Hákový nosič kontejneru', 'Ostatní']
  const sorted = [...cats].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

  const allActive = selectedSlug === ALL_SLUG && viewMode === 'browse'
  const total = stats?.products ?? 0
  let allQ: { items: number; pcs: number } | undefined
  for (const c of qc.values()) allQ = { items: (allQ?.items || 0) + c.items, pcs: (allQ?.pcs || 0) + c.pcs }
  const allBtn = `
    <div class="nav-group nav-group-all">
      <button type="button" class="nav-item nav-all ${allActive ? 'active' : ''} ${allQ ? 'in-quote' : ''}" data-type="${ALL_SLUG}" ${allActive ? 'aria-current="page"' : ''} ${quoteTitle(allQ)}>
        <span class="nav-label">Vše</span>${navQuoteBadge(allQ)}${total ? `<span class="nav-count" title="${total} produktů v katalogu">${total}</span>` : ''}
      </button>
    </div>`
  return allBtn + sorted
    .map((cat) => {
      const roots = types
        .filter((t) => t.category === cat && (!t.parentSlug || !types.some((x) => x.slug === t.parentSlug)))
        .sort((a, b) => a.sortOrder - b.sortOrder)
      const groupHasQuote = types.some((t) => t.category === cat && qc.has(t.slug))
      return `
        <div class="nav-group">
          <div class="nav-group-title ${groupHasQuote ? 'has-quote' : ''}">${escapeHtml(cat)}${
            groupHasQuote ? `<span class="nav-dot" aria-hidden="true" title="Obsahuje položky z nabídky"></span>` : ''
          }</div>
          ${roots
            .map((t) => {
              const children = types
                .filter((c) => c.parentSlug === t.slug)
                .sort((a, b) => a.sortOrder - b.sortOrder)
              const active = selectedSlug === t.slug && viewMode === 'browse'
              const q = qc.get(t.slug)
              const childQ = !q && children.some((c) => qc.has(c.slug))
              return `
                <button type="button" class="nav-item ${active ? 'active' : ''} ${q ? 'in-quote' : ''} ${childQ ? 'child-in-quote' : ''}" data-type="${escapeAttr(t.slug)}" ${active ? 'aria-current="page"' : ''} ${
                  q ? quoteTitle(q) : childQ ? 'title="Podkategorie obsahuje položky z nabídky"' : ''
                }>
                  <span class="nav-label">${escapeHtml(t.name)}</span>${navQuoteBadge(q)}${
                    childQ ? `<span class="nav-dot" aria-hidden="true"></span><span class="sr-only">, podkategorie obsahuje položky z nabídky</span>` : ''
                  }
                </button>
                ${children
                  .map((c) => {
                    const cActive = selectedSlug === c.slug && viewMode === 'browse'
                    const cq = qc.get(c.slug)
                    return `<button type="button" class="nav-item nested ${cActive ? 'active' : ''} ${cq ? 'in-quote' : ''}" data-type="${escapeAttr(c.slug)}" ${cActive ? 'aria-current="page"' : ''} ${quoteTitle(cq)}>
                      <span class="nav-label">${escapeHtml(c.name)}</span>${navQuoteBadge(cq)}
                    </button>`
                  })
                  .join('')}
              `
            })
            .join('')}
        </div>`
    })
    .join('')
}

function relatedStripHtml(): string {
  if (viewMode !== 'browse' || !selectedSlug) return ''
  const related = relatedFor(selectedSlug)
  if (!related.length) return ''
  const t = currentType()
  const groupLabel =
    groups.find((g) => g.id === t?.relatedGroup)?.label || 'Související příslušenství'
  return `
    <section class="related" aria-label="Související">
      <div class="related-label">${escapeHtml(groupLabel)}</div>
      <div class="related-chips">
        ${related
          .map(
            (r) =>
              `<button type="button" class="chip-btn" data-type="${escapeAttr(r.slug)}">${escapeHtml(r.name)}</button>`,
          )
          .join('')}
      </div>
    </section>`
}

function formatHistoryDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return iso
  }
}

function quoteHistoryHint(productId: string): string {
  const rows = priceHistoryCache[productId]
  if (!rows || !rows.length) return ''
  const last = rows[0]
  return `<div class="muted q-hist">Poslední změna ceny: ${escapeHtml(formatHistoryDate(last.recordedAt))} · ${formatCzkExact(last.oldPriceVat)} → ${formatCzkExact(last.newPriceVat)} s DPH</div>`
}

function historyPanelHtml(p: Product): string {
  if (historyOpenId !== p.id) return ''
  const rows = priceHistoryCache[p.id]
  if (!rows) {
    return `<div class="price-history" data-history-panel="${escapeAttr(p.id)}"><span class="muted">Načítám historii…</span></div>`
  }
  if (!rows.length) {
    return `<div class="price-history" data-history-panel="${escapeAttr(p.id)}"><span class="muted">Zatím žádná změna ceny (aktuálně ${dualPrice(p.price, p.priceVat)}).</span></div>`
  }
  return `<div class="price-history" data-history-panel="${escapeAttr(p.id)}">
    <div class="price-history-title">Historie cen</div>
    <ul>
      ${rows
        .map(
          (h) => `<li>
            <span class="ph-date">${escapeHtml(formatHistoryDate(h.recordedAt))}</span>
            <span class="ph-change">${formatCzkExact(h.oldPriceVat)} → <strong>${formatCzkExact(h.newPriceVat)}</strong> s DPH
              <span class="muted">(${formatCzkExact(h.oldPrice)} → ${formatCzkExact(h.newPrice)} bez DPH)</span>
            </span>
          </li>`,
        )
        .join('')}
    </ul>
  </div>`
}

function showCategoryOnCards(): boolean {
  return viewMode === 'search' || selectedSlug === ALL_SLUG
}

function productCardHtml(p: Product): string {
  const qty = cart[p.id] || 0
  return `
    <article class="product-card ${qty ? 'in-quote' : ''}">
      <div class="thumb">${thumbHtml(p)}</div>
      <div class="product-body">
        <div class="product-meta-top">${supplierBadge(p.supplier)}${p.sku ? `<span class="sku">${escapeHtml(p.sku)}</span>` : ''}</div>
        ${showCategoryOnCards() ? `<div class="product-cat">${escapeHtml(typeName(p.typeSlug))}</div>` : ''}
        <div class="product-name">${escapeHtml(p.name)}</div>
        ${p.dimensions ? `<div class="product-dims">${escapeHtml(p.dimensions)}</div>` : ''}
        <div class="product-price">
          <div>${dualPrice(p.price, p.priceVat)} <span class="muted">/ ${escapeHtml(p.unit)}</span></div>
          <button type="button" class="link-btn history-link" data-history="${escapeAttr(p.id)}" aria-expanded="${historyOpenId === p.id}">Historie cen</button>
        </div>
        <div class="product-actions">
          ${
            qty
              ? `<div class="qty" data-qty="${escapeAttr(p.id)}">
                  <button type="button" data-dec aria-label="Snížit">−</button>
                  <input type="number" min="0" value="${qty}" aria-label="Množství" />
                  <button type="button" data-inc aria-label="Zvýšit">+</button>
                </div>`
              : `<button class="btn btn-primary" type="button" data-add="${escapeAttr(p.id)}">Přidat do nabídky</button>`
          }
          <span class="spacer"></span>
          ${
            p.productUrl
              ? `<a class="link-btn" href="${escapeAttr(p.productUrl)}" target="_blank" rel="noopener noreferrer">Detail ↗</a>`
              : ''
          }
        </div>
        ${historyPanelHtml(p)}
      </div>
    </article>`
}

function quotePanelHtml(): string {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const goodsEx = lines.reduce((a, l) => a + l.lineExVat, 0)
  const goodsVat = lines.reduce((a, l) => a + l.lineVat, 0)
  const shipEx = shipping.reduce((a, s) => a + s.shippingExVat, 0)
  const shipVat = shipping.reduce((a, s) => a + s.shippingVat, 0)
  const now = new Date().toLocaleString('cs-CZ')

  const backBtn = `<div class="quote-back no-print">
      <button type="button" class="btn btn-outline back-btn" data-action="back-to-catalog">← Zpět do katalogu</button>
    </div>`

  if (!lines.length) {
    const loading = !cartHydrated && Object.keys(cart).length > 0
    return `${backBtn}<div class="quote-empty">
      <h2>Cenová nabídka</h2>
      <p>${loading ? 'Načítám nabídku…' : 'Nabídka je zatím prázdná. Vyberte produkty v katalogu tlačítkem „Přidat do nabídky“.'}</p>
    </div>`
  }

  const groupsHtml = groupLinesBySupplier(lines)
    .map(([supplier, group]) => {
      const subEx = group.reduce((a, l) => a + l.lineExVat, 0)
      const subVat = group.reduce((a, l) => a + l.lineVat, 0)
      const ship = shipping.find((s) => s.supplier === supplier)
      return `
        <section class="quote-supplier sup-${supplierKey(supplier)}">
          <h3>${supplierBadge(supplier, 'lg')}<span class="qs-count">${group.length} ${group.length === 1 ? 'položka' : group.length < 5 ? 'položky' : 'položek'}</span></h3>
          <table class="quote-table">
            <thead>
              <tr>
                <th class="q-thumb-col c-thumb" aria-hidden="true"></th>
                <th>Položka</th>
                <th class="num q-unit-col c-unit">Cena bez / s DPH</th>
                <th class="q-qty-col c-qty">Počet</th>
                <th class="num c-line">Řádek bez / s DPH</th>
                <th class="no-print c-rm"></th>
              </tr>
            </thead>
            <tbody>
              ${group
                .map(
                  (l) => `<tr>
                    <td class="q-thumb-col"><div class="q-thumb">${thumbHtml(l.product, 'q-thumb-img')}</div></td>
                    <td>
                      <div class="q-name">${escapeHtml(l.product.name)}</div>
                      <div class="q-meta">${escapeHtml(typeName(l.product.typeSlug))}${l.product.dimensions ? ` · ${escapeHtml(l.product.dimensions)}` : ''}${l.product.sku ? ` · SKU ${escapeHtml(l.product.sku)}` : ''}</div>
                      <div class="q-unit-inline">${formatCzkExact(l.product.price)} bez DPH · ${formatCzkExact(l.product.priceVat)} s DPH / ${escapeHtml(l.product.unit)}</div>
                      ${quoteHistoryHint(l.product.id)}
                    </td>
                    <td class="num q-unit-col">${formatCzkExact(l.product.price)}<br /><span class="muted">${formatCzkExact(l.product.priceVat)} / ${escapeHtml(l.product.unit)}</span></td>
                    <td class="q-qty-col">
                      <div class="qty compact no-print" data-qty="${escapeAttr(l.product.id)}">
                        <button type="button" data-dec aria-label="Snížit">−</button>
                        <input type="number" min="0" value="${l.qty}" aria-label="Množství" />
                        <button type="button" data-inc aria-label="Zvýšit">+</button>
                      </div>
                      <span class="print-only">${l.qty} ${escapeHtml(l.product.unit)}</span>
                    </td>
                    <td class="num"><strong>${formatCzkExact(l.lineExVat)}</strong><br /><span class="muted">${formatCzkExact(l.lineVat)}</span></td>
                    <td class="no-print"><button type="button" class="btn btn-ghost btn-icon" data-remove="${escapeAttr(l.product.id)}" aria-label="Odebrat" title="Odebrat">✕</button></td>
                  </tr>`,
                )
                .join('')}
            </tbody>
            <tfoot>
              <tr>
                <td class="q-thumb-col"></td>
                <td>Mezisoučet zboží</td>
                <td class="q-unit-col"></td>
                <td class="q-qty-col"></td>
                <td class="num"><strong>${formatCzkExact(subEx)}</strong><br /><span class="muted">${formatCzkExact(subVat)}</span></td>
                <td class="no-print"></td>
              </tr>
              ${
                ship
                  ? `<tr class="ship-row">
                      <td class="q-thumb-col"></td>
                      <td>Doprava <span class="muted">— ${escapeHtml(ship.note)}${ship.free ? ' · zdarma' : ''}</span></td>
                      <td class="q-unit-col"></td>
                      <td class="q-qty-col"></td>
                      <td class="num">${formatCzkExact(ship.shippingExVat)}<br /><span class="muted">${formatCzkExact(ship.shippingVat)}</span></td>
                      <td class="no-print"></td>
                    </tr>`
                  : ''
              }
            </tfoot>
          </table>
        </section>`
    })
    .join('')

  return `
    ${backBtn}
    <div class="quote" id="quote-print">
      <div class="print-brand print-only-block">
        <div class="print-brand-title">Katalog příslušenství</div>
        <div class="print-brand-meta">${escapeHtml(now)}</div>
      </div>
      <header class="quote-head">
        <div>
          <div class="quote-kicker">Orientační nabídka</div>
          <h2>Cenová nabídka příslušenství</h2>
          <p class="quote-date">${escapeHtml(now)}</p>
        </div>
        <div class="quote-actions no-print">
          <button type="button" class="btn btn-outline" data-action="copy-quote">Kopírovat</button>
          <button type="button" class="btn btn-outline" data-action="csv-quote">CSV</button>
          <button type="button" class="btn btn-primary" data-action="print-quote">Tisk / PDF</button>
        </div>
      </header>
      <p class="quote-disclaimer">Ceny jsou orientační z veřejných katalogů dodavatelů — nejde o závazný ceník. Před předáním zkontrolujte množství a položky.</p>
      <label class="quote-note no-print">
        <span>Poznámka k nabídce</span>
        <textarea data-quote-note rows="2" placeholder="např. zakázka XY, termín, specifikace nástavby…">${escapeHtml(quoteNote)}</textarea>
      </label>
      ${quoteNote.trim() ? `<div class="quote-note-print print-only-block"><strong>Poznámka:</strong> ${escapeHtml(quoteNote)}</div>` : ''}
      ${groupsHtml}
      <div class="quote-totals">
        <div class="qt-row"><span>Zboží celkem</span><span>${formatCzkExact(goodsEx)} <span class="muted">bez DPH</span> · <strong>${formatCzkExact(goodsVat)}</strong> <span class="muted">s DPH</span></span></div>
        <div class="qt-row"><span>Doprava celkem</span><span>${formatCzkExact(shipEx)} <span class="muted">bez DPH</span> · <strong>${formatCzkExact(shipVat)}</strong> <span class="muted">s DPH</span></span></div>
        <div class="qt-row grand"><span>Celkem</span><span>${formatCzkExact(goodsEx + shipEx)} <span class="muted">bez DPH</span> · <strong>${formatCzkExact(goodsVat + shipVat)}</strong> <span class="muted">s DPH</span></span></div>
      </div>
      <div class="quote-foot no-print">
        <button type="button" class="btn btn-ghost danger" data-action="clear">Vymazat nabídku</button>
      </div>
      <div class="print-foot print-only-block">ContSystem · Katalog příslušenství · ceny orientační, platné ke dni vystavení</div>
    </div>`
}

function updateStatusHtml(): string {
  if (!updateStatus || updateStatus.state === 'idle') return ''
  const logs = (updateStatus.logs || []).slice(-8).map((l) => escapeHtml(l)).join('<br />')
  return `
    <div class="update-status state-${escapeAttr(updateStatus.state)}">
      <strong>Aktualizace katalogu:</strong> ${escapeHtml(updateStatus.phase)}
      ${updateStatus.error ? ` — ${escapeHtml(updateStatus.error)}` : ''}
      ${updateStatus.counts ? ` · ${updateStatus.counts.total} produktů ve scrape` : ''}
      ${logs ? `<div class="update-logs">${logs}</div>` : ''}
    </div>`
}

function cartCount(): number {
  return Object.values(cart).reduce((a, n) => a + n, 0)
}

// ── layout: static shell + region renders ─────────────────────────
// The shell (header with supplier filter, search box) is created ONCE. Regions are
// re-rendered individually so the search input keeps focus while typing.
const BASE = import.meta.env.BASE_URL

app.innerHTML = `
  <div class="shell">
    <header class="app-header">
      <a class="brand" href="${BASE}">
        <span class="brand-app">Katalog příslušenství</span>
      </a>
      <div class="header-filter" data-region="header-filter"></div>
      <div class="header-search">
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input class="search" type="search" placeholder="Hledat v katalogu…" aria-label="Hledat produkty" data-global-search />
      </div>
      <div class="header-actions" data-region="header-actions"></div>
    </header>
    <div class="body-row">
      <aside class="sidebar">
        <nav class="nav" aria-label="Kategorie" data-region="nav"></nav>
        <div class="sidebar-foot">
          <button type="button" class="btn btn-sidebar block" data-action="update-catalog">Aktualizovat katalog</button>
          <div class="status tiny" data-region="status"></div>
        </div>
      </aside>
      <div class="main-col">
        <div data-region="notices"></div>
        <main class="content" data-region="main"></main>
      </div>
    </div>
  </div>
`

const region = (name: string) => app.querySelector<HTMLElement>(`[data-region="${name}"]`)!
const searchEl = app.querySelector<HTMLInputElement>('[data-global-search]')!

function renderHeaderFilter() {
  region('header-filter').innerHTML = `
    <select class="select" data-supplier aria-label="Dodavatel" title="${viewMode === 'quote' ? 'Filtr dodavatele platí pro katalog' : 'Filtrovat podle dodavatele'}" ${viewMode === 'quote' ? 'disabled' : ''}>
      <option value="">Všichni dodavatelé</option>
      ${catalogSuppliers
        .map((s) => `<option value="${escapeAttr(s)}" ${s === supplierFilter ? 'selected' : ''}>${escapeHtml(s)}</option>`)
        .join('')}
    </select>`
}

function renderHeaderActions() {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const totalEx = lines.reduce((a, l) => a + l.lineExVat, 0) + shipping.reduce((a, s) => a + s.shippingExVat, 0)
  const totalVat = lines.reduce((a, l) => a + l.lineVat, 0) + shipping.reduce((a, s) => a + s.shippingVat, 0)
  const pieces = cartCount()
  const n = lines.length
  const title = n
    ? `Cenová nabídka: ${n} ${itemsWord(n)} (${pieces} ks) · celkem ${formatCzkExact(totalEx)} bez DPH / ${formatCzkExact(totalVat)} s DPH (vč. dopravy)`
    : 'Cenová nabídka je zatím prázdná'
  region('header-actions').innerHTML = `
    <button type="button" class="quote-btn ${viewMode === 'quote' ? 'active' : ''}" data-action="open-quote" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}" ${viewMode === 'quote' ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M14 3v5h5 M9 13h6 M9 17h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="quote-btn-label">Cenová nabídka</span>
      ${n ? `<span class="quote-badge">${formatCzk(totalEx)}</span>` : ''}
    </button>`
}

function renderNav() {
  const nav = region('nav')
  const prevLeft = nav.scrollLeft
  nav.innerHTML = navHtml()
  // Mobile: nav is a horizontal chip strip — keep position, reveal the active chip.
  if (nav.scrollWidth > nav.clientWidth + 4) {
    nav.scrollLeft = prevLeft
    const active = nav.querySelector<HTMLElement>('.nav-item.active')
    if (active) {
      const left = active.offsetLeft - nav.offsetLeft
      if (left < nav.scrollLeft || left + active.offsetWidth > nav.scrollLeft + nav.clientWidth) {
        nav.scrollLeft = left - 12
      }
    }
  }
  const st = region('status')
  st.textContent = statusText
  st.classList.toggle('error', statusError)
}

function renderNotices() {
  region('notices').innerHTML = `${updateStatusHtml()}${toastMsg ? `<div class="toast" role="status">${escapeHtml(toastMsg)}</div>` : ''}`
}

function renderMain() {
  const t = currentType()
  const main = region('main')
  main.classList.toggle('quote-view', viewMode === 'quote')
  if (viewMode === 'quote') {
    main.innerHTML = quotePanelHtml()
    return
  }
  const isAll = viewMode === 'browse' && selectedSlug === ALL_SLUG
  const heading = viewMode === 'search' ? `Hledání: „${searchQ.trim() || '…'}“` : isAll ? 'Vše' : t?.name || 'Katalog'
  const supplierCounts = new Map<string, number>()
  for (const p of catalogItems) supplierCounts.set(p.supplier, (supplierCounts.get(p.supplier) || 0) + 1)
  main.innerHTML = `
    <div class="content-head">
      <div>
        ${isAll ? `<div class="crumb">Celý katalog</div>` : viewMode === 'browse' && t ? `<div class="crumb">${escapeHtml(t.category)}</div>` : ''}
        <h1>${escapeHtml(heading)}</h1>
        <p class="lead">${
          viewMode === 'search'
            ? `${catalogItems.length} výsledků`
            : isAll
              ? `${catalogItems.length} položek ze všech ${types.length} kategorií${supplierFilter ? ` · ${escapeHtml(supplierFilter)}` : ''} · seřazeno podle ceny`
              : t
              ? `${catalogItems.length} položek · ceny bez DPH i s DPH`
              : ''
        }</p>
      </div>
      <div class="supplier-legend" aria-label="Dodavatelé v seznamu">
        ${[...supplierCounts.entries()].map(([s, n]) => `${supplierBadge(s)}<span class="legend-n">${n}</span>`).join('')}
      </div>
    </div>
    ${relatedStripHtml()}
    <div class="product-grid">
      ${
        catalogLoading
          ? `<div class="empty">Načítám produkty…</div>`
          : catalogError
            ? `<div class="empty error">${escapeHtml(catalogError)}</div>`
            : !catalogItems.length
              ? `<div class="empty">Žádné produkty</div>`
              : catalogItems.slice(0, renderLimit).map((p) => productCardHtml(p)).join('')
      }
    </div>
    ${moreHtml()}`
  observeMore()
}

// Progressive rendering: PAGE_SIZE cards at a time; the next batch is appended
// (not re-rendered) when the sentinel scrolls near the viewport.
function moreHtml(): string {
  if (catalogLoading || catalogError || renderLimit >= catalogItems.length) return ''
  return `<div class="load-more" data-more>
    <button type="button" class="btn btn-outline" data-action="more">Zobrazit další (${Math.min(PAGE_SIZE, catalogItems.length - renderLimit)} z ${catalogItems.length - renderLimit} zbývajících)</button>
  </div>`
}

let moreObserver: IntersectionObserver | null = null
function observeMore() {
  moreObserver?.disconnect()
  const sentinel = region('main').querySelector('[data-more]')
  if (!sentinel || !('IntersectionObserver' in window)) return
  moreObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) appendMore()
    },
    { rootMargin: '800px 0px' },
  )
  moreObserver.observe(sentinel)
}

function appendMore() {
  if (renderLimit >= catalogItems.length) return
  const grid = region('main').querySelector('.product-grid')
  if (!grid) return
  const next = catalogItems.slice(renderLimit, renderLimit + PAGE_SIZE)
  renderLimit += next.length
  grid.insertAdjacentHTML('beforeend', next.map((p) => productCardHtml(p)).join(''))
  const old = region('main').querySelector('[data-more]')
  if (old) old.outerHTML = moreHtml()
  observeMore()
}

function render() {
  renderHeaderFilter()
  renderHeaderActions()
  renderNav()
  renderNotices()
  renderMain()
  if (searchEl.value !== searchQ && document.activeElement !== searchEl) searchEl.value = searchQ
}

async function togglePriceHistory(productId: string) {
  if (historyOpenId === productId) {
    historyOpenId = null
    render()
    return
  }
  historyOpenId = productId
  render()
  if (!priceHistoryCache[productId]) {
    try {
      const res = await fetch(`${API_BASE}/price-history?productId=${encodeURIComponent(productId)}`)
      const data = (await res.json()) as { items?: PriceHistoryEntry[] }
      priceHistoryCache[productId] = data.items || []
    } catch {
      priceHistoryCache[productId] = []
    }
    if (historyOpenId === productId) render()
  }
}

async function prefetchCartHistory() {
  const ids = Object.keys(cart).filter((id) => cart[id] > 0 && !priceHistoryCache[id])
  await Promise.all(
    ids.slice(0, 30).map(async (id) => {
      try {
        const res = await fetch(`${API_BASE}/price-history?productId=${encodeURIComponent(id)}`)
        const data = (await res.json()) as { items?: PriceHistoryEntry[] }
        priceHistoryCache[id] = data.items || []
      } catch {
        priceHistoryCache[id] = []
      }
    }),
  )
}

function catalogUrl(): string {
  return selectedSlug && selectedSlug !== ALL_SLUG ? `#/${selectedSlug}` : location.pathname + location.search
}

function openQuoteView(push = true) {
  if (viewMode !== 'quote') catalogScrollY = window.scrollY
  viewMode = 'quote'
  if (push && slugFromHash() !== QUOTE_HASH) {
    history.pushState(null, '', `#/${QUOTE_HASH}`)
    quotePushed = true
  }
  render()
  window.scrollTo({ top: 0 })
  void prefetchCartHistory().then(() => {
    if (viewMode === 'quote') render()
  })
}

/** Back from the quote to where the user was in the catalog (category / search, scroll position). */
function leaveQuote() {
  quotePushed = false
  viewMode = searchQ.trim() ? 'search' : 'browse'
  if (viewMode === 'browse' && !selectedSlug) selectedSlug = ALL_SLUG
  render()
  if (!catalogItems.length && !catalogLoading) void loadProductsForCurrent()
  window.scrollTo({ top: catalogScrollY })
}

function backToCatalog() {
  if (quotePushed && slugFromHash() === QUOTE_HASH) {
    history.back() // → hashchange → leaveQuote()
    return
  }
  history.replaceState(null, '', catalogUrl())
  leaveQuote()
}

// ── events (delegated once; regions re-render freely) ─────────────
app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const typeBtn = target.closest<HTMLElement>('[data-type]')
  if (typeBtn) {
    selectType(typeBtn.dataset.type!)
    return
  }
  const historyBtn = target.closest<HTMLElement>('[data-history]')
  if (historyBtn) {
    void togglePriceHistory(historyBtn.dataset.history!)
    return
  }
  const addBtn = target.closest<HTMLElement>('[data-add]')
  if (addBtn) {
    const id = addBtn.dataset.add!
    const product = catalogItems.find((p) => p.id === id) || productsById.get(id)
    if (product) addOne(product)
    return
  }
  const removeBtn = target.closest<HTMLElement>('[data-remove]')
  if (removeBtn) {
    setQty(removeBtn.dataset.remove!, 0)
    return
  }
  const qtyWrap = target.closest<HTMLElement>('[data-qty]')
  if (qtyWrap && target.closest('[data-dec], [data-inc]')) {
    const id = qtyWrap.dataset.qty!
    setQty(id, (cart[id] || 0) + (target.closest('[data-inc]') ? 1 : -1))
    return
  }
  const actionEl = target.closest<HTMLElement>('[data-action]')
  if (!actionEl) return
  switch (actionEl.dataset.action) {
    case 'open-quote':
      openQuoteView()
      break
    case 'back-to-catalog':
      backToCatalog()
      break
    case 'clear':
      if (window.confirm('Opravdu vymazat celou nabídku?')) clearAll()
      break
    case 'copy-quote':
      void copyQuote()
      break
    case 'csv-quote':
      downloadCsv()
      break
    case 'print-quote':
      printQuote()
      break
    case 'update-catalog':
      void triggerUpdate()
      break
    case 'more':
      appendMore()
      break
  }
})

app.addEventListener('change', (e) => {
  const target = e.target as HTMLElement
  if (target.matches('[data-supplier]')) {
    supplierFilter = (target as HTMLSelectElement).value
    void loadProductsForCurrent()
    return
  }
  if (target.matches('[data-qty] input')) {
    const id = target.closest<HTMLElement>('[data-qty]')!.dataset.qty!
    setQty(id, Number((target as HTMLInputElement).value))
    return
  }
  if (target.matches('[data-quote-note]')) saveNote((target as HTMLTextAreaElement).value)
})

app.addEventListener('focusout', (e) => {
  const target = e.target as HTMLElement
  if (target.matches('[data-quote-note]')) saveNote((target as HTMLTextAreaElement).value)
})

searchEl.addEventListener('input', () => {
  searchQ = searchEl.value
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    // typing a search from the quote view leaves the quote (keep the URL in sync)
    if (viewMode === 'quote') {
      history.replaceState(null, '', catalogUrl())
      quotePushed = false
    }
    if (searchQ.trim()) {
      viewMode = 'search'
      selectedSlug = null
    } else {
      viewMode = 'browse'
      if (!selectedSlug) selectedSlug = ALL_SLUG
    }
    void loadProductsForCurrent()
  }, 280)
})

window.addEventListener('hashchange', () => {
  const hashSlug = slugFromHash()
  if (hashSlug === QUOTE_HASH) {
    if (viewMode !== 'quote') openQuoteView(false)
    return
  }
  if (viewMode === 'quote') leaveQuote()
  const slug = hashSlug || ALL_SLUG
  if (slug !== selectedSlug && (slug === ALL_SLUG || types.some((t) => t.slug === slug))) selectType(slug)
})

// Broken/missing thumbnails → supplier-coloured letter tile (error does not bubble → capture).
app.addEventListener(
  'error',
  (e) => {
    const img = e.target as HTMLElement
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return
    const tile = document.createElement('div')
    tile.className = `img-fallback sup-${img.dataset.sup || 'other'}`
    tile.textContent = img.dataset.fallback
    img.replaceWith(tile)
  },
  true,
)

document.addEventListener('keydown', (e) => {
  // Esc in the quote view → back to the catalog (not while typing in a field)
  if (e.key === 'Escape' && viewMode === 'quote' && !(e.target as HTMLElement).closest('input, textarea, select')) {
    e.preventDefault()
    backToCatalog()
  }
})

render()
void loadBootstrap()
