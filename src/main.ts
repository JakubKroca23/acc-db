import './style.css'
import type { AccessoryType, CartMap, CatalogUpdateStatus, PriceHistoryEntry, Product, RelatedGroup } from './types'
import { estimateShippingBySupplier, type ShippingEstimate } from './shipping'
import { mountChatWidget, type ChatAction } from './chat-widget'
import {
  findKitGaps,
  formatKitTipMessage,
  loadDismissedKitTips,
  saveDismissedKitTips,
  tipForAddedProduct,
  type KitTipGap,
} from './kit-tips'

const STORAGE_KEY = 'acc-db-cart-v2'
const NOTE_KEY = 'acc-db-quote-note'
const API_BASE = `${import.meta.env.BASE_URL}api`
const DEFAULT_LOGIN_URL = '/login?next=%2Facc-db%2F'

/** API call; an expired Manager session (401 from the auth gate) sends the user to the Manager login. */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init })
  if (res.status === 401) {
    const data = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { login?: string }
    window.location.href = data.login || DEFAULT_LOGIN_URL
    throw new Error('Nepřihlášen — přesměrovávám na přihlášení')
  }
  return res
}

/** Logged-in Manager user (when the server-side gate is on). */
let me: { id?: string; name: string; email: string; labels?: string[] } | null = null

/** Quote, note and chat are stored per Manager user: `<key>:<userId>` (unkeyed only when the auth gate is off). */
let userId = ''
const userKey = (base: string) => (userId ? `${base}:${userId}` : base)

/** one-time move of the old shared (unkeyed) data to the current user, then the old key is deleted */
function migrateToUser(store: Storage, base: string) {
  if (!userId) return
  try {
    const old = store.getItem(base)
    if (old === null) return
    if (store.getItem(userKey(base)) === null) store.setItem(userKey(base), old)
    store.removeItem(base)
  } catch {
    /* storage unavailable */
  }
}

async function loadMe() {
  try {
    const res = await apiFetch('/me')
    if (!res.ok) return
    const data = (await res.json()) as {
      user?: { id?: string; name: string; email: string; labels?: string[] } | null
      managerUrl?: string
    }
    me = data.user || null
    if (me?.id) {
      userId = me.id
      migrateToUser(localStorage, STORAGE_KEY)
      migrateToUser(localStorage, NOTE_KEY)
      cart = loadCart()
      quoteNote = loadNote()
    }
    renderHeaderActions()
  } catch {
    /* optional */
  } finally {
    startChat()
  }
}
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
    const raw = localStorage.getItem(userKey(STORAGE_KEY))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CartMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCart() {
  localStorage.setItem(userKey(STORAGE_KEY), JSON.stringify(cart))
}

function loadNote(): string {
  return localStorage.getItem(userKey(NOTE_KEY)) || ''
}

function saveNote(v: string) {
  localStorage.setItem(userKey(NOTE_KEY), v)
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

const pageParams = new URLSearchParams(location.search)
/** Opened from the order accessory row: pick one product and post it back. */
const pickMode = pageParams.get('pick') === '1'
const pickToken = pageParams.get('token') || ''

let selectedSlug: string | null = slugFromHash() === QUOTE_HASH ? null : slugFromHash()
let renderLimit = PAGE_SIZE
let searchQ = ''
/** Active supplier badges; empty Set = no products. Filled on first catalog load. */
let selectedSuppliers = new Set<string>()
let suppliersFilterReady = false
let knownSupplierSnapshot = new Set<string>()
let sortOrder: 'price_asc' | 'price_desc' = 'price_asc'
let viewMode: 'browse' | 'search' | 'quote' = slugFromHash() === QUOTE_HASH ? 'quote' : 'browse'
/** Pick-mode URL may preselect one supplier until the first supplier list arrives. */
let pendingPickSupplier = ''

if (pickMode) {
  const initialQ = (pageParams.get('q') || '').trim()
  const initialSupplier = (pageParams.get('supplier') || '').trim()
  if (initialQ) {
    searchQ = initialQ
    viewMode = 'search'
    selectedSlug = null
  }
  if (initialSupplier) pendingPickSupplier = initialSupplier
  document.title = 'Vybrat příslušenství · ContSystem'
}
let priceHistoryCache: Record<string, PriceHistoryEntry[]> = {}
let historyOpenId: string | null = null
let cartHydrated = false
/** true while the #/nabidka history entry was pushed by us → „Zpět do katalogu“ can use history.back() */
let quotePushed = false
let catalogScrollY = 0

let catalogItems: Product[] = []
let catalogSuppliers: string[] = []
/** Full supplier list for filter badges (not limited to current result set). */
let allCatalogSuppliers: string[] = []
let catalogLoading = false
let catalogError: string | null = null
let searchTimer: number | undefined

let updateStatus: CatalogUpdateStatus | null = null
/** Dev-only overlay while scrape+seed runs. */
let updateModalOpen = false
/** Modal open before POST — user picks suppliers / cancel. */
let updateAwaitingConfirm = false
const UPDATE_SUPPLIER_OPTIONS = ['ALSAP', 'Trans-Technik', 'Hydrotruck', 'Pavlínek', 'Olejspol', 'Hydrolider'] as const
let updateSelectedSuppliers: string[] = [...UPDATE_SUPPLIER_OPTIONS]
let updatePolling: number | undefined
let toastMsg = ''
let catalogInfoOpen = false
let catalogDevMenuOpen = false
let supplierMenuOpen = false
let dismissedKitTips = loadDismissedKitTips()
let activeKitTip: KitTipGap | null = null
let kitTipHideTimer: number | undefined

function cartTypeSlugs(): Set<string> {
  const slugs = new Set<string>()
  for (const [id, qty] of Object.entries(cart)) {
    if (!qty) continue
    const p = productsById.get(id)
    if (p?.typeSlug) slugs.add(p.typeSlug)
  }
  return slugs
}

function dismissKitMissing(slugs: string[]) {
  for (const s of slugs) dismissedKitTips.add(s)
  saveDismissedKitTips(dismissedKitTips)
}

function showKitTip(gap: KitTipGap | null) {
  activeKitTip = gap
  if (kitTipHideTimer) window.clearTimeout(kitTipHideTimer)
  kitTipHideTimer = undefined
  if (gap) {
    kitTipHideTimer = window.setTimeout(() => {
      activeKitTip = null
      renderNotices()
    }, 14000)
  }
  renderNotices()
}

function maybeTipAfterAdd(product: Product) {
  const gap = tipForAddedProduct(types, groups, cartTypeSlugs(), product.typeSlug, dismissedKitTips)
  if (gap) showKitTip(gap)
}

function kitTipBubbleHtml(): string {
  if (!activeKitTip) return ''
  const gap = activeKitTip
  const openBtns = gap.missing
    .map(
      (m) =>
        `<button type="button" class="btn btn-primary" data-action="kit-tip-open" data-slug="${escapeAttr(m.slug)}">${escapeHtml(m.name)}</button>`,
    )
    .join('')
  return `
    <aside class="kit-tip-bubble no-print" role="status" aria-label="Tip Kapitána Karla">
      <div class="kit-tip-head">
        <span class="kit-tip-name">Kapitán Karel</span>
        <button type="button" class="kit-tip-close" data-action="kit-tip-dismiss" aria-label="Zavřít tip">✕</button>
      </div>
      <p class="kit-tip-msg">${escapeHtml(formatKitTipMessage(gap))}</p>
      <div class="kit-tip-actions">
        ${openBtns}
        <button type="button" class="btn btn-outline" data-action="kit-tip-dismiss">Zavřít</button>
      </div>
    </aside>`
}

function quoteKitTipsHtml(): string {
  const gaps = findKitGaps(types, groups, cartTypeSlugs(), dismissedKitTips)
  if (!gaps.length) return ''
  const items = gaps
    .flatMap((g) =>
      g.missing.map(
        (m) =>
          `<li>
            <span>K <strong>${escapeHtml(g.triggerName)}</strong> chybí <strong>${escapeHtml(m.name)}</strong></span>
            <button type="button" class="btn btn-outline" data-action="kit-tip-open" data-slug="${escapeAttr(m.slug)}">Otevřít</button>
            <button type="button" class="link-btn" data-action="kit-tip-dismiss-slug" data-slug="${escapeAttr(m.slug)}">Ignorovat</button>
          </li>`,
      ),
    )
    .join('')
  return `
    <aside class="kit-tip-banner no-print" aria-label="Tipy Kapitána Karla k nabídce">
      <div class="kit-tip-banner-title">Kapitán Karel radí</div>
      <ul class="kit-tip-banner-list">${items}</ul>
    </aside>`
}

function isCatalogDev(): boolean {
  return (me?.labels ?? []).some((label) => label.toLowerCase() === 'dev')
}

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
      apiFetch(`/accessories`),
      apiFetch(`/stats`),
      loadMe(),
    ])
    const accData = await accRes.json()
    if (!accRes.ok) throw new Error(accData.error || `HTTP ${accRes.status}`)
    types = (accData.items as AccessoryType[]).sort((a, b) => a.sortOrder - b.sortOrder)
    groups = (accData.groups as RelatedGroup[]) || []
    if (statsRes.ok) {
      stats = (await statsRes.json()) as DbStats
      updateStatus = (stats as DbStats & { catalogUpdate?: CatalogUpdateStatus }).catalogUpdate || null
      if (updateStatus?.state === 'running') {
        updateModalOpen = true
        startUpdatePolling()
      }
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
    const res = await apiFetch(`/products`)
    const data = await res.json()
    if (!res.ok) return
    for (const p of data.items as Product[]) productsById.set(p.id, p)
  } catch {
    /* ignore */
  }
}

function mergeKnownSuppliers(list: string[]) {
  const filtered = list.filter((s) => s && s !== 'tržní odhad')
  allCatalogSuppliers = [...filtered].sort((a, b) => a.localeCompare(b, 'cs'))
  if (!suppliersFilterReady) {
    if (pendingPickSupplier && filtered.includes(pendingPickSupplier)) {
      selectedSuppliers = new Set([pendingPickSupplier])
    } else {
      selectedSuppliers = new Set(filtered)
    }
    knownSupplierSnapshot = new Set(filtered)
    suppliersFilterReady = true
    pendingPickSupplier = ''
    return
  }
  for (const s of filtered) {
    if (!knownSupplierSnapshot.has(s)) {
      knownSupplierSnapshot.add(s)
      selectedSuppliers.add(s)
    }
  }
}

function selectAllSuppliers() {
  selectedSuppliers = new Set(allCatalogSuppliers)
}

function supplierFilterParam(): string | null {
  if (!suppliersFilterReady || !allCatalogSuppliers.length) return null
  if (selectedSuppliers.size === 0) return null
  const allOn = allCatalogSuppliers.every((s) => selectedSuppliers.has(s))
  if (allOn) return null
  return [...selectedSuppliers].join(',')
}

function supplierFilterLabel(): string {
  if (!suppliersFilterReady) return 'všichni'
  if (selectedSuppliers.size === 0) return 'žádný'
  if (allCatalogSuppliers.length && allCatalogSuppliers.every((s) => selectedSuppliers.has(s))) {
    return 'všichni'
  }
  return [...selectedSuppliers].sort((a, b) => a.localeCompare(b, 'cs')).join(', ')
}

let loadSeq = 0
async function loadProductsForCurrent() {
  const seq = ++loadSeq // a newer load (e.g. category then supplier filter from Kapitán Karel) wins
  catalogLoading = true
  catalogError = null
  render()
  if (suppliersFilterReady && selectedSuppliers.size === 0) {
    catalogItems = []
    catalogLoading = false
    if (seq === loadSeq) render()
    return
  }
  try {
    const params = new URLSearchParams()
    if (viewMode === 'search' && searchQ.trim()) {
      params.set('q', searchQ.trim())
    } else if (selectedSlug && selectedSlug !== ALL_SLUG) {
      params.set('type', selectedSlug)
    }
    const supplierParam = supplierFilterParam()
    if (supplierParam) params.set('supplier', supplierParam)
    params.set('sort', sortOrder)
    const res = await apiFetch(`/products?${params}`)
    const data = await res.json()
    if (seq !== loadSeq) return
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    let items = data.items as Product[]
    renderLimit = PAGE_SIZE
    catalogSuppliers = data.suppliers as string[]
    if (Array.isArray(data.allSuppliers) && data.allSuppliers.length) {
      mergeKnownSuppliers(data.allSuppliers as string[])
    } else {
      const fallback = [
        ...new Set([
          ...allCatalogSuppliers,
          ...catalogSuppliers.filter((s) => s !== 'tržní odhad'),
        ]),
      ]
      mergeKnownSuppliers(fallback)
    }
    // After first init (e.g. pick-mode single supplier), re-filter if we loaded unfiltered.
    if (suppliersFilterReady && selectedSuppliers.size && selectedSuppliers.size < allCatalogSuppliers.length) {
      items = items.filter((p) => selectedSuppliers.has(p.supplier))
    }
    if (suppliersFilterReady && selectedSuppliers.size === 0) items = []
    catalogItems = items
    for (const p of catalogItems) productsById.set(p.id, p)
    catalogLoading = false
  } catch (err) {
    if (seq !== loadSeq) return
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

function priceKnown(product: Product): boolean {
  return product.price > 0 && product.priceVat > 0
}

function addOne(product: Product) {
  if (!priceKnown(product)) return
  productsById.set(product.id, product)
  setQty(product.id, (cart[product.id] || 0) + 1)
  maybeTipAfterAdd(product)
  if (!activeKitTip) {
    toastMsg = `Přidáno do nabídky: ${product.name.slice(0, 48)}`
    window.setTimeout(() => {
      toastMsg = ''
      render()
    }, 1800)
  }
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
function updatePhaseMeta(phase: string, state: CatalogUpdateStatus['state']): {
  step: number
  label: string
  pct: number
} {
  const p = (phase || '').toLowerCase()
  if (state === 'ok') return { step: 3, label: 'Hotovo', pct: 100 }
  if (p.includes('stopped') || (state === 'error' && p.includes('stop')))
    return { step: p.includes('seed') ? 2 : 1, label: 'Zastaveno', pct: p.includes('seed') ? 72 : 35 }
  if (state === 'error') return { step: p.includes('seed') ? 2 : 1, label: 'Chyba', pct: p.includes('seed') ? 72 : 35 }
  if (p.includes('seed')) return { step: 2, label: 'Ukládám do databáze', pct: 72 }
  if (p.includes('scrape')) return { step: 1, label: 'Stahuji katalogy dodavatelů', pct: 38 }
  if (p.includes('start')) return { step: 0, label: 'Připravuji aktualizaci', pct: 8 }
  return { step: 0, label: phase || 'Běží…', pct: 15 }
}

function updateElapsed(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return ''
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const sec = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s} s`
}

function updateModalHtml(): string {
  if (!updateModalOpen) return ''
  if (updateAwaitingConfirm) {
    const boxes = UPDATE_SUPPLIER_OPTIONS.map((name) => {
      const checked = updateSelectedSuppliers.includes(name)
      const hint =
        name === 'Pavlínek' ? ' · Shopify, ~5–10 min, při 429 dlouhá pauza' : name === 'Hydrotruck' ? ' · občas SSL' : ''
      return `<label class="upd-supplier-opt">
        <input type="checkbox" data-update-supplier="${escapeAttr(name)}" ${checked ? 'checked' : ''} />
        <span class="sup-badge lg sup-${supplierKey(name)}"><span class="sup-dot" aria-hidden="true"></span>${escapeHtml(name)}</span>
        <span class="upd-supplier-hint">${escapeHtml(hint)}</span>
      </label>`
    }).join('')
    return `
    <div class="upd-modal-root" role="dialog" aria-modal="true" aria-labelledby="upd-modal-title" data-update-modal>
      <div class="upd-modal-backdrop" data-action="close-update-modal"></div>
      <div class="upd-modal">
        <header class="upd-modal-head">
          <div class="upd-modal-brand">
            <span class="upd-modal-icon run" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </span>
            <div>
              <h2 id="upd-modal-title">Aktualizovat katalog</h2>
              <p class="upd-modal-sub">Vyberte dodavatele ke scrapu. Nezaškrtnutí zůstanou z poslední aktualizace.</p>
            </div>
          </div>
          <button type="button" class="upd-modal-close" data-action="close-update-modal" aria-label="Zavřít">×</button>
        </header>
        <div class="upd-supplier-list" role="group" aria-label="Dodavatelé">
          ${boxes}
        </div>
        <div class="upd-quick-row">
          <button type="button" class="link-btn" data-action="update-suppliers-all">Všichni</button>
          <button type="button" class="link-btn" data-action="update-suppliers-pavlinek">Jen Pavlínek</button>
          <button type="button" class="link-btn" data-action="update-suppliers-no-pav">Bez Pavlínek</button>
        </div>
        <footer class="upd-modal-foot">
          <button type="button" class="btn btn-ghost" data-action="close-update-modal">Zrušit</button>
          <button type="button" class="btn btn-primary" data-action="confirm-update-catalog">Spustit aktualizaci</button>
        </footer>
      </div>
    </div>`
  }
  const st = updateStatus
  const state = st?.state || 'running'
  const phase = st?.phase || 'starting'
  const stopped = phase === 'stopped' || (st?.error || '').includes('Zastaveno')
  const meta = updatePhaseMeta(phase, state === 'idle' ? 'running' : state)
  const elapsed = updateElapsed(st?.startedAt || null, st?.finishedAt || null)
  const logs = (st?.logs || []).slice(-40)
  const bySup = st?.counts?.bySupplier || {}
  const supplierChips = Object.entries(bySup)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, n]) =>
        `<span class="upd-chip"><span class="sup-badge sup-${supplierKey(name)}"><span class="sup-dot" aria-hidden="true"></span>${escapeHtml(name)}</span><span class="upd-chip-n">${n}</span></span>`,
    )
    .join('')
  const seed = st?.seed
  const steps = [
    { id: 0, title: 'Start' },
    { id: 1, title: 'Scrape' },
    { id: 2, title: 'Seed' },
    { id: 3, title: 'Hotovo' },
  ]
  const canClose = state === 'ok' || state === 'error'
  const running = state === 'running'
  const title =
    state === 'ok'
      ? 'Katalog je aktuální'
      : stopped
        ? 'Aktualizace zastavena'
        : state === 'error'
          ? 'Aktualizace selhala'
          : 'Aktualizace katalogu'
  const subtitle =
    state === 'ok'
      ? 'Scrape i zápis do Appwrite doběhly úspěšně.'
      : stopped
        ? 'Proces byl ukončen. Částečný scrape mohl zůstat v souboru — znovu spusťte, nebo přeskočte Pavlínek.'
        : state === 'error'
          ? st?.error || 'Došlo k chybě — detaily v logu níže.'
          : 'Stahuji veřejné katalogy a synchronizuji Appwrite. Pavlínek běží pomalu kvůli limitům Shopify.'

  return `
    <div class="upd-modal-root" role="dialog" aria-modal="true" aria-labelledby="upd-modal-title" data-update-modal>
      <div class="upd-modal-backdrop"${canClose ? ' data-action="close-update-modal"' : ''}></div>
      <div class="upd-modal">
        <header class="upd-modal-head">
          <div class="upd-modal-brand">
            <span class="upd-modal-icon ${state === 'ok' ? 'ok' : state === 'error' ? 'err' : 'run'}" aria-hidden="true">
              ${
                state === 'ok'
                  ? '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                  : state === 'error'
                    ? '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5h.01M12 3l9.5 16.5H2.5L12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                    : '<svg viewBox="0 0 24 24" class="upd-spin"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
              }
            </span>
            <div>
              <h2 id="upd-modal-title">${escapeHtml(title)}</h2>
              <p class="upd-modal-sub">${escapeHtml(subtitle)}</p>
            </div>
          </div>
          ${
            canClose
              ? `<button type="button" class="upd-modal-close" data-action="close-update-modal" aria-label="Zavřít">×</button>`
              : elapsed
                ? `<span class="upd-elapsed" title="Uplynulý čas">${escapeHtml(elapsed)}</span>`
                : ''
          }
        </header>

        <ol class="upd-steps" aria-label="Fáze aktualizace">
          ${steps
            .map((s) => {
              const done = state === 'ok' ? true : meta.step > s.id
              const active = state !== 'ok' && state !== 'error' && meta.step === s.id
              const bad = state === 'error' && meta.step === s.id
              return `<li class="upd-step ${done ? 'done' : ''} ${active ? 'active' : ''} ${bad ? 'bad' : ''}"><span class="upd-step-dot">${done && !bad ? '✓' : s.id + 1}</span><span class="upd-step-label">${s.title}</span></li>`
            })
            .join('')}
        </ol>

        <div class="upd-progress-block">
          <div class="upd-progress-meta">
            <span class="upd-phase">${escapeHtml(meta.label)}</span>
            <span class="upd-pct">${meta.pct} %</span>
          </div>
          <div class="upd-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${meta.pct}">
            <div class="upd-progress-bar ${state === 'error' ? 'err' : state === 'ok' ? 'ok' : ''}" style="width:${meta.pct}%"></div>
          </div>
        </div>

        ${
          supplierChips || st?.counts?.total
            ? `<div class="upd-stats">
                ${st?.counts?.total != null ? `<div class="upd-stat"><span class="upd-stat-k">Produktů ve scrape</span><span class="upd-stat-v">${st.counts.total}</span></div>` : ''}
                ${seed ? `<div class="upd-stat"><span class="upd-stat-k">Vytvořeno / upraveno</span><span class="upd-stat-v">${seed.created} / ${seed.updated}</span></div>` : ''}
                ${supplierChips ? `<div class="upd-suppliers">${supplierChips}</div>` : ''}
              </div>`
            : ''
        }

        <div class="upd-log-wrap">
          <div class="upd-log-head">Průběh</div>
          <pre class="upd-log" data-update-log>${
            logs.length
              ? logs.map((l) => escapeHtml(l)).join('\n')
              : 'Čekám na první výstup ze serveru…'
          }</pre>
        </div>

        <footer class="upd-modal-foot">
          ${
            running
              ? `<span class="upd-foot-hint">Aktualizace běží na serveru.</span>
                 <button type="button" class="btn btn-danger" data-action="stop-update-catalog">Zastavit</button>`
              : canClose
                ? `<button type="button" class="btn btn-primary" data-action="close-update-modal">${state === 'ok' ? 'Hotovo' : 'Zavřít'}</button>`
                : ''
          }
        </footer>
      </div>
    </div>`
}

function renderUpdateModal() {
  const el = region('update-modal')
  el.innerHTML = updateModalHtml()
  const log = el.querySelector<HTMLElement>('[data-update-log]')
  if (log) log.scrollTop = log.scrollHeight
}

function loadSavedUpdateSuppliers(): string[] {
  try {
    const raw = localStorage.getItem('acc-db-update-suppliers')
    if (!raw) return [...UPDATE_SUPPLIER_OPTIONS]
    const parsed = JSON.parse(raw) as string[]
    const allowed = new Set<string>(UPDATE_SUPPLIER_OPTIONS)
    const next = parsed.filter((s) => allowed.has(s))
    return next.length ? next : [...UPDATE_SUPPLIER_OPTIONS]
  } catch {
    return [...UPDATE_SUPPLIER_OPTIONS]
  }
}

function readUpdateSupplierChecks(): string[] {
  const boxes = [...app.querySelectorAll<HTMLInputElement>('[data-update-supplier]')]
  return boxes.filter((b) => b.checked).map((b) => b.dataset.updateSupplier || '').filter(Boolean)
}

function openUpdateConfirm() {
  updateModalOpen = true
  updateAwaitingConfirm = true
  updateSelectedSuppliers = loadSavedUpdateSuppliers()
  renderUpdateModal()
}

async function updateAuthHeaders(): Promise<Record<string, string> | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let token = localStorage.getItem('acc-db-update-token') || ''
  if (!token) {
    const entered = window.prompt(
      'Volitelný update token (ACC_DB_UPDATE_TOKEN). Nechte prázdné, pokud server token nevyžaduje:',
      '',
    )
    if (entered === null) return null
    token = entered.trim()
    if (token) localStorage.setItem('acc-db-update-token', token)
  }
  if (token) headers['X-Update-Token'] = token
  return headers
}

async function triggerUpdate() {
  updateAwaitingConfirm = false
  updateModalOpen = true
  updateStatus = {
    state: 'running',
    phase: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [`Připravuji aktualizaci (${updateSelectedSuppliers.join(', ') || 'nikdo'})…`],
    error: null,
    counts: null,
    seed: null,
  }
  render()
  try {
    if (!updateSelectedSuppliers.length) throw new Error('Vyberte alespoň jednoho dodavatele')
    const headers = await updateAuthHeaders()
    if (!headers) {
      updateModalOpen = false
      updateStatus = null
      render()
      return
    }
    const res = await apiFetch(`/catalog/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ suppliers: updateSelectedSuppliers }),
    })
    const data = await res.json()
    if (res.status === 401) {
      localStorage.removeItem('acc-db-update-token')
      throw new Error('Neplatný update token — zkuste znovu')
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    updateStatus = data.status as CatalogUpdateStatus
    startUpdatePolling()
    render()
  } catch (err) {
    updateStatus = {
      state: 'error',
      phase: 'error',
      startedAt: updateStatus?.startedAt || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      logs: [...(updateStatus?.logs || []), err instanceof Error ? err.message : 'Chyba aktualizace'],
      error: err instanceof Error ? err.message : 'Chyba aktualizace',
      counts: null,
      seed: null,
    }
    render()
  }
}

async function stopUpdate() {
  try {
    const headers = await updateAuthHeaders()
    if (!headers) return
    const res = await apiFetch(`/catalog/update/stop`, { method: 'POST', headers, body: '{}' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    updateStatus = (data.status || data) as CatalogUpdateStatus
    window.clearInterval(updatePolling)
    render()
  } catch (err) {
    toastMsg = err instanceof Error ? err.message : 'Nepodařilo se zastavit'
    render()
  }
}

function startUpdatePolling() {
  window.clearInterval(updatePolling)
  updatePolling = window.setInterval(async () => {
    try {
      const res = await apiFetch(`/catalog/update/status`)
      if (!res.ok) return
      updateStatus = (await res.json()) as CatalogUpdateStatus
      updateModalOpen = true
      render()
      if (updateStatus.state === 'ok' || updateStatus.state === 'error') {
        window.clearInterval(updatePolling)
        if (updateStatus.state === 'ok') {
          await loadBootstrap()
          render()
        }
      }
    } catch {
      /* ignore */
    }
  }, 1500)
}

// ── supplier colours & images ─────────────────────────────────────
/** Stable CSS modifier for a supplier — ALSAP / TT / HT / Pavlínek / Olejspol. */
function supplierKey(supplier: string): string {
  const s = supplier.toLocaleLowerCase('cs')
  if (s.includes('alsap')) return 'alsap'
  if (s.includes('trans')) return 'tt'
  if (s.includes('olejspol')) return 'olej'
  if (s.includes('hydrolider')) return 'hl'
  if (s.includes('hydro')) return 'ht'
  if (s.includes('pavlínek') || s.includes('pavlinek')) return 'pav'
  return 'other'
}

function supplierBadge(supplier: string, extra = ''): string {
  return `<span class="sup-badge sup-${supplierKey(supplier)} ${extra}"><span class="sup-dot" aria-hidden="true"></span>${escapeHtml(supplier)}</span>`
}

function suppliersAllOn(): boolean {
  return (
    suppliersFilterReady &&
    allCatalogSuppliers.length > 0 &&
    allCatalogSuppliers.every((s) => selectedSuppliers.has(s))
  )
}

function supplierFilterHtml(_counts: Map<string, number>): string {
  const disabled = viewMode === 'quote'
  const list = allCatalogSuppliers.length ? allCatalogSuppliers : []
  const subset = suppliersFilterReady && !suppliersAllOn()
  const countBadge =
    subset && selectedSuppliers.size
      ? `<span class="supplier-filter-count" aria-hidden="true">${selectedSuppliers.size}</span>`
      : ''
  const options = list
    .map((s) => {
      const active = selectedSuppliers.has(s)
      return `<label class="supplier-filter-option sup-${supplierKey(s)}">
        <input type="checkbox" data-supplier-check="${escapeAttr(s)}" ${active ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span class="supplier-filter-option-label">${escapeHtml(s)}</span>
      </label>`
    })
    .join('')
  const showClear =
    suppliersFilterReady &&
    (subset || (viewMode === 'browse' && !!selectedSlug && selectedSlug !== ALL_SLUG))
  const panel =
    supplierMenuOpen && !disabled
      ? `<div class="supplier-filter-panel" id="supplier-filter-panel" role="dialog" aria-label="Filtrovat podle výrobce">
          <div class="supplier-filter-panel-actions">
            <button type="button" class="link-btn" data-action="supplier-select-all">Vybrat vše</button>
            <span class="supplier-filter-panel-sep" aria-hidden="true">·</span>
            <button type="button" class="link-btn" data-action="supplier-select-none">Zrušit výběr</button>
          </div>
          <div class="supplier-filter-list" role="group">${options || '<span class="muted supplier-filter-empty">Žádní výrobci</span>'}</div>
        </div>`
      : ''
  return `<div class="filter-mfr supplier-filter">
    <div class="supplier-filter-dropdown">
      <button type="button" class="supplier-filter-btn ${subset ? 'is-filtered' : ''}" data-action="toggle-supplier-menu" aria-expanded="${supplierMenuOpen && !disabled ? 'true' : 'false'}" aria-controls="supplier-filter-panel" aria-haspopup="dialog" ${disabled ? 'disabled' : ''} title="${disabled ? 'Filtr výrobce platí pro katalog' : 'Filtrovat podle výrobce'}">
        <span>Výrobci</span>${countBadge}
        <svg class="supplier-filter-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      ${panel}
    </div>
    ${showClear ? `<button type="button" class="link-btn filter-clear-all" data-action="clear-filters">Vymazat vše</button>` : ''}
  </div>`
}

function sortControlHtml(): string {
  const disabled = viewMode === 'quote'
  return `<label class="sort-field">
    <span class="filter-label">Seřadit podle</span>
    <select class="sort-select-mock" data-sort aria-label="Řazení podle ceny" ${disabled ? 'disabled' : ''}>
      <option value="price_asc" ${sortOrder === 'price_asc' ? 'selected' : ''}>Cena: vzestupně</option>
      <option value="price_desc" ${sortOrder === 'price_desc' ? 'selected' : ''}>Cena: sestupně</option>
    </select>
  </label>`
}

function categoryFilterChipHtml(): string {
  const t = currentType()
  if (viewMode !== 'browse' || !selectedSlug || selectedSlug === ALL_SLUG || !t) return ''
  return `<button type="button" class="mfr-chip cat-chip on" data-action="clear-category" title="Zrušit filtr kategorie">
    <span class="mfr-chip-label">${escapeHtml(t.name)}</span>
    <span class="mfr-chip-x" aria-hidden="true">×</span>
  </button>`
}

function clearCatalogFilters() {
  selectAllSuppliers()
  if (viewMode === 'browse' && selectedSlug && selectedSlug !== ALL_SLUG) {
    selectType(ALL_SLUG)
    return
  }
  void loadProductsForCurrent()
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
    .map((cat, catIdx) => {
      const roots = types
        .filter((t) => t.category === cat && (!t.parentSlug || !types.some((x) => x.slug === t.parentSlug)))
        .sort((a, b) => a.sortOrder - b.sortOrder)
      const groupHasQuote = types.some((t) => t.category === cat && qc.has(t.slug))
      const body = roots
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
            .join('')
      return `
        <div class="nav-group nav-group-cat" data-cat-tone="${catIdx % 5}">
          <div class="nav-group-title ${groupHasQuote ? 'has-quote' : ''}">${escapeHtml(cat)}${
            groupHasQuote ? `<span class="nav-dot" aria-hidden="true" title="Obsahuje položky z nabídky"></span>` : ''
          }</div>
          <div class="nav-group-body">${body}</div>
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

function productSpecLines(p: Product): string[] {
  const lines: string[] = []
  if (showCategoryOnCards()) {
    const cat = typeName(p.typeSlug)
    if (cat) lines.push(cat)
  }
  if (p.dimensions) lines.push(p.dimensions)
  if (p.note) lines.push(p.note)
  return lines.slice(0, 3)
}

function productCardHtml(p: Product): string {
  const qty = cart[p.id] || 0
  const specs = productSpecLines(p)
  return `
    <article class="product-card ${qty ? 'in-quote' : ''}">
      <div class="thumb">
        ${thumbHtml(p)}
        <span class="thumb-sup sup-${supplierKey(p.supplier)}">${escapeHtml(p.supplier)}</span>
      </div>
      <div class="product-body">
        <div class="product-name">${escapeHtml(p.name)}</div>
        ${p.sku ? `<div class="sku">${escapeHtml(p.sku)}</div>` : ''}
        ${
          specs.length
            ? `<ul class="product-specs">${specs.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
            : ''
        }
        <div class="product-price-row">
          <div class="product-price-block">
            ${
              priceKnown(p)
                ? `<strong>${formatCzk(p.price)}</strong>
            <span class="muted">bez DPH</span>
            <span class="muted price-vat">${formatCzk(p.priceVat)} s DPH / ${escapeHtml(p.unit)}</span>`
                : `<strong>Cena po přihlášení</strong>
            <span class="muted">na webu dodavatele</span>`
            }
          </div>
          ${
            priceKnown(p)
              ? `<button type="button" class="link-btn history-link" data-history="${escapeAttr(p.id)}" aria-expanded="${historyOpenId === p.id}">Historie</button>`
              : ''
          }
        </div>
        <div class="product-actions">
          ${
            !priceKnown(p)
              ? ''
              : pickMode
              ? `<button class="btn btn-primary" type="button" data-pick="${escapeAttr(p.id)}">Vybrat</button>`
              : qty
              ? `<div class="qty" data-qty="${escapeAttr(p.id)}">
                  <button type="button" data-dec aria-label="Snížit">−</button>
                  <input type="number" min="0" step="${p.unit === 'L' ? '1' : '1'}" value="${qty}" aria-label="${p.unit === 'L' ? 'Litry' : 'Množství'}" title="${p.unit === 'L' ? 'Množství v litrech' : 'Množství'}" />
                  <span class="qty-unit muted" aria-hidden="true">${escapeHtml(p.unit)}</span>
                  <button type="button" data-inc aria-label="Zvýšit">+</button>
                </div>`
              : `<button class="btn btn-primary" type="button" data-add="${escapeAttr(p.id)}" aria-label="Přidat do nabídky"><span class="btn-label-full">Přidat</span><span class="btn-label-short">Přidat</span></button>`
          }
          ${
            p.productUrl
              ? `<a class="link-btn" href="${escapeAttr(p.productUrl)}" target="_blank" rel="noopener noreferrer">Detail ↗</a>`
              : ''
          }
          ${
            p.datasheetUrl
              ? `<a class="link-btn" href="${escapeAttr(p.datasheetUrl)}" target="_blank" rel="noopener noreferrer">Technický list ↗</a>`
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
      ${quoteKitTipsHtml()}
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
  // Compact strip only when modal is closed but a finished status remains.
  if (updateModalOpen || !updateStatus || updateStatus.state === 'idle' || updateStatus.state === 'running') return ''
  return `
    <div class="update-status state-${escapeAttr(updateStatus.state)}">
      <strong>Poslední aktualizace:</strong> ${escapeHtml(updateStatus.phase)}
      ${updateStatus.error ? ` — ${escapeHtml(updateStatus.error)}` : ''}
      ${updateStatus.counts ? ` · ${updateStatus.counts.total} produktů` : ''}
      <button type="button" class="link-btn" data-action="open-update-modal" style="margin-left:8px">Zobrazit detail</button>
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
        <img class="brand-logo" src="${BASE}contsystem-logo.svg" alt="ContSystem" width="120" height="32" />
        <span class="brand-divider" aria-hidden="true"></span>
        <span class="brand-app">Katalog příslušenství</span>
      </a>
      <div class="header-search">
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input class="search" type="search" placeholder="Hledat podle názvu, čísla dílu nebo specifikace…" aria-label="Hledat produkty" data-global-search />
      </div>
      <div class="header-actions" data-region="header-actions"></div>
    </header>
    <div class="body-row">
      <aside class="sidebar">
        <nav class="nav" aria-label="Kategorie" data-region="nav"></nav>
        <div class="sidebar-foot">
          <div class="sidebar-meta">
            <strong>ContSystem · Katalog</strong>
            Příslušenství dodavatelů
          </div>
          <div class="status tiny" data-region="status" hidden></div>
        </div>
      </aside>
      <div class="main-col">
        <div data-region="notices"></div>
        <main class="content" data-region="main"></main>
      </div>
    </div>
    <div data-region="update-modal"></div>
  </div>
`

const region = (name: string) => app.querySelector<HTMLElement>(`[data-region="${name}"]`)!
const searchEl = app.querySelector<HTMLInputElement>('[data-global-search]')!
const appHeaderEl = app.querySelector<HTMLElement>('.app-header')!

function syncAppHeaderHeight() {
  if (!appHeaderEl) return
  document.documentElement.style.setProperty('--app-header-h', `${appHeaderEl.offsetHeight}px`)
}
syncAppHeaderHeight()
if (typeof ResizeObserver !== 'undefined' && appHeaderEl) {
  new ResizeObserver(() => syncAppHeaderHeight()).observe(appHeaderEl)
}
window.addEventListener('resize', syncAppHeaderHeight)

function renderHeaderFilter() {
  /* supplier filter moved to clickable badges in content-head */
}

function renderHeaderActions() {
  if (pickMode) {
    region('header-actions').innerHTML = `
      <span class="pick-header-label">Výběr do zakázky</span>`
    return
  }
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const totalEx = lines.reduce((a, l) => a + l.lineExVat, 0) + shipping.reduce((a, s) => a + s.shippingExVat, 0)
  const totalVat = lines.reduce((a, l) => a + l.lineVat, 0) + shipping.reduce((a, s) => a + s.shippingVat, 0)
  const pieces = cartCount()
  const n = lines.length
  const title = n
    ? `Cenová nabídka: ${n} ${itemsWord(n)} (${pieces} ks) · celkem ${formatCzkExact(totalEx)} bez DPH / ${formatCzkExact(totalVat)} s DPH (vč. dopravy)`
    : 'Cenová nabídka je zatím prázdná'
  const devActions = isCatalogDev()
    ? `<div class="catalog-dev-actions">
        <button type="button" class="catalog-dev-gear" data-action="toggle-catalog-dev-menu" aria-expanded="${catalogDevMenuOpen ? 'true' : 'false'}" aria-controls="catalog-dev-menu" aria-label="Nastavení katalogu (dev)" title="Nastavení katalogu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13a7.8 7.8 0 0 0 .05-2l2.05-1.6-2-3.46-2.45.98a7.9 7.9 0 0 0-1.73-1L15 2h-6l-.32 2.92a7.9 7.9 0 0 0-1.73 1L4.5 4.94l-2 3.46L4.55 11a7.8 7.8 0 0 0 0 2l-2.05 1.6 2 3.46 2.45-.98a7.9 7.9 0 0 0 1.73 1L9 22h6l.32-2.92a7.9 7.9 0 0 0 1.73-1l2.45.98 2-3.46L19.4 13Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </button>
        ${
          catalogDevMenuOpen
            ? `<div class="catalog-dev-menu" id="catalog-dev-menu" role="menu" aria-label="Nastavení katalogu">
                <button type="button" class="btn btn-outline" data-action="toggle-catalog-info" aria-expanded="${catalogInfoOpen ? 'true' : 'false'}" aria-controls="catalog-info-panel">Údaje o katalogu</button>
                <button type="button" class="btn btn-outline" data-action="update-catalog">Aktualizovat katalog</button>
                ${
                  catalogInfoOpen
                    ? `<div class="catalog-info-panel" id="catalog-info-panel" role="dialog" aria-label="Údaje o katalogu">
                        <p class="catalog-info-summary">${escapeHtml(statusText || 'Katalog se načítá…')}</p>
                        ${updateStatusHtml()}
                      </div>`
                    : ''
                }
              </div>`
            : ''
        }
      </div>`
    : ''
  region('header-actions').innerHTML = `
    ${devActions}
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
  st.textContent = statusError ? statusText : ''
  st.classList.toggle('error', statusError)
  st.hidden = !statusError
}

function renderNotices() {
  const banner = pickMode
    ? `<div class="pick-banner" role="status">
        <span>Vyberte položku tlačítkem <strong>Vybrat</strong>. Okno se zavře a popis se doplní do příslušenství zakázky. U ALSAP jsou jednotlivé rozměry a provedení samostatně.</span>
        <button type="button" class="btn btn-outline" data-action="cancel-pick">Zavřít</button>
      </div>`
    : ''
  const toast = toastMsg ? `<div class="toast" role="status">${escapeHtml(toastMsg)}</div>` : ''
  region('notices').innerHTML = banner + toast + kitTipBubbleHtml()
}

const PICK_CHANNEL = 'acc-db-accessory-pick'

/** Popup (window.opener) nebo katalog vložený v aplikaci (window.parent). */
function pickHost(): Window | null {
  try {
    if (window.opener && !window.opener.closed) return window.opener
  } catch {
    /* cross-origin opener */
  }
  try {
    if (window.parent && window.parent !== window) return window.parent
  } catch {
    /* cross-origin parent */
  }
  return null
}

function emitPickMessage(payload: { type: string; token: string; item?: unknown }) {
  const host = pickHost()
  if (host) {
    try {
      host.postMessage(payload, window.location.origin)
      return true
    } catch {
      /* fall through to BroadcastChannel */
    }
  }
  try {
    const ch = new BroadcastChannel(PICK_CHANNEL)
    ch.postMessage(payload)
    ch.close()
    return true
  } catch {
    return false
  }
}

function closePickWindow() {
  // Popup / Tauri child window — zavřít i bez window.opener (BroadcastChannel pick).
  try {
    window.close()
  } catch {
    /* ignore */
  }
}

/** Manager zrušil úpravu příslušenství → zavřít toto pick okno. */
function onPickDismissMessage(data: { type?: string; token?: string } | null) {
  if (!pickMode || !pickToken) return
  if (data?.type !== 'acc-db-pick-dismiss') return
  if (!data.token || data.token !== pickToken) return
  closePickWindow()
}

if (pickMode && pickToken) {
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return
    onPickDismissMessage(event.data as { type?: string; token?: string } | null)
  })
  try {
    const dismissCh = new BroadcastChannel(PICK_CHANNEL)
    dismissCh.onmessage = (event) =>
      onPickDismissMessage(event.data as { type?: string; token?: string } | null)
  } catch {
    /* BroadcastChannel unavailable */
  }
}

function postPick(product: Product) {
  const item = {
    $id: product.id,
    supplier: product.supplier,
    code: product.sku || '',
    name: product.name,
    url: product.productUrl || '',
    image_url: product.imageUrl,
    price: product.price,
    price_vat: product.priceVat,
    currency: 'CZK',
    category: typeName(product.typeSlug) || null,
  }
  if (!emitPickMessage({ type: 'acc-db-pick', token: pickToken, item })) {
    toastMsg = 'Tohle okno nebylo otevřené z příslušenství zakázky.'
    renderNotices()
    return
  }
  closePickWindow()
}

function cancelPick() {
  emitPickMessage({ type: 'acc-db-pick-cancel', token: pickToken })
  closePickWindow()
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
  const lead =
    suppliersFilterReady && selectedSuppliers.size === 0
      ? 'Žádný dodavatel není zapnutý'
      : catalogLoading
        ? 'Načítám…'
        : viewMode === 'search'
          ? `${catalogItems.length} výsledků`
          : isAll
            ? `${catalogItems.length} položek ze všech ${types.length} kategorií`
            : t
              ? `${catalogItems.length} položek`
              : ''
  main.innerHTML = `
    <div class="content-head">
      <div>
        <h1>${escapeHtml(heading)}</h1>
        <p class="lead">${
          viewMode === 'browse' && t && !isAll
            ? `Katalog ${escapeHtml(t.category)} · ${lead}`
            : lead
        }</p>
      </div>
    </div>
    <div class="filter-bar">
      <div class="filter-bar-left">
        ${categoryFilterChipHtml()}
        ${supplierFilterHtml(supplierCounts)}
      </div>
      ${sortControlHtml()}
    </div>
    ${relatedStripHtml()}
    <div class="product-grid">
      ${
        catalogLoading
          ? `<div class="empty">Načítám produkty…</div>`
          : catalogError
            ? `<div class="empty error">${escapeHtml(catalogError)}</div>`
            : !catalogItems.length
              ? `<div class="empty">${
                  suppliersFilterReady && selectedSuppliers.size === 0
                    ? 'Žádné produkty — zapněte alespoň jednoho dodavatele'
                    : 'Žádné produkty'
                }</div>`
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
  renderUpdateModal()
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
      const res = await apiFetch(`/price-history?productId=${encodeURIComponent(productId)}`)
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
        const res = await apiFetch(`/price-history?productId=${encodeURIComponent(id)}`)
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
  if ((catalogDevMenuOpen || catalogInfoOpen) && !target.closest('.catalog-dev-actions')) {
    catalogDevMenuOpen = false
    catalogInfoOpen = false
    renderHeaderActions()
  }
  if (supplierMenuOpen && !target.closest('.supplier-filter-dropdown')) {
    supplierMenuOpen = false
    renderMain()
  }
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
  const sortBtn = target.closest<HTMLElement>('[data-sort-set]')
  if (sortBtn && !sortBtn.hasAttribute('disabled')) {
    const v = sortBtn.dataset.sortSet
    const next = v === 'price_desc' ? 'price_desc' : 'price_asc'
    if (next !== sortOrder) {
      sortOrder = next
      void loadProductsForCurrent()
    }
    return
  }
  const pickBtn = target.closest<HTMLElement>('[data-pick]')
  if (pickBtn) {
    const id = pickBtn.dataset.pick!
    const product = catalogItems.find((p) => p.id === id) || productsById.get(id)
    if (product) postPick(product)
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
    case 'cancel-pick':
      cancelPick()
      break
    case 'clear-category':
      selectType(ALL_SLUG)
      break
    case 'clear-filters':
      clearCatalogFilters()
      break
    case 'toggle-supplier-menu':
      if (viewMode === 'quote') break
      supplierMenuOpen = !supplierMenuOpen
      renderMain()
      break
    case 'supplier-select-all':
      selectAllSuppliers()
      supplierMenuOpen = true
      void loadProductsForCurrent()
      break
    case 'supplier-select-none':
      selectedSuppliers.clear()
      supplierMenuOpen = true
      void loadProductsForCurrent()
      break
    case 'kit-tip-dismiss':
      if (activeKitTip) dismissKitMissing(activeKitTip.missing.map((m) => m.slug))
      showKitTip(null)
      if (viewMode === 'quote') renderMain()
      break
    case 'kit-tip-dismiss-slug': {
      const slug = actionEl.dataset.slug
      if (slug) {
        dismissKitMissing([slug])
        if (activeKitTip) {
          activeKitTip = {
            ...activeKitTip,
            missing: activeKitTip.missing.filter((m) => m.slug !== slug),
          }
          if (!activeKitTip.missing.length) showKitTip(null)
          else renderNotices()
        }
        if (viewMode === 'quote') renderMain()
      }
      break
    }
    case 'kit-tip-open': {
      const slug = actionEl.dataset.slug
      if (slug) {
        showKitTip(null)
        toCatalogView()
        selectType(slug)
      }
      break
    }
    case 'update-catalog':
      if (!isCatalogDev()) break
      openUpdateConfirm()
      break
    case 'confirm-update-catalog':
      if (!isCatalogDev()) break
      updateSelectedSuppliers = readUpdateSupplierChecks()
      localStorage.setItem('acc-db-update-suppliers', JSON.stringify(updateSelectedSuppliers))
      if (!updateSelectedSuppliers.length) {
        toastMsg = 'Vyberte alespoň jednoho dodavatele'
        render()
        break
      }
      void triggerUpdate()
      break
    case 'update-suppliers-all':
      updateSelectedSuppliers = [...UPDATE_SUPPLIER_OPTIONS]
      renderUpdateModal()
      break
    case 'update-suppliers-pavlinek':
      updateSelectedSuppliers = ['Pavlínek']
      renderUpdateModal()
      break
    case 'update-suppliers-no-pav':
      updateSelectedSuppliers = UPDATE_SUPPLIER_OPTIONS.filter((s) => s !== 'Pavlínek')
      renderUpdateModal()
      break
    case 'stop-update-catalog':
      if (!isCatalogDev()) break
      void stopUpdate()
      break
    case 'close-update-modal':
      updateModalOpen = false
      updateAwaitingConfirm = false
      renderUpdateModal()
      break
    case 'open-update-modal':
      if (updateStatus && updateStatus.state !== 'idle') {
        updateModalOpen = true
        updateAwaitingConfirm = false
        renderUpdateModal()
      }
      break
    case 'toggle-catalog-dev-menu':
      if (!isCatalogDev()) break
      catalogDevMenuOpen = !catalogDevMenuOpen
      if (!catalogDevMenuOpen) catalogInfoOpen = false
      renderHeaderActions()
      break
    case 'toggle-catalog-info':
      if (!isCatalogDev()) break
      catalogInfoOpen = !catalogInfoOpen
      catalogDevMenuOpen = true
      renderHeaderActions()
      break
    case 'more':
      appendMore()
      break
  }
})

app.addEventListener('change', (e) => {
  const target = e.target as HTMLElement
  if (target.matches('[data-supplier-check]')) {
    const name = (target as HTMLInputElement).dataset.supplierCheck || ''
    if (!name) return
    if ((target as HTMLInputElement).checked) selectedSuppliers.add(name)
    else selectedSuppliers.delete(name)
    void loadProductsForCurrent()
    return
  }
  if (target.matches('[data-sort]')) {
    const v = (target as HTMLSelectElement).value
    sortOrder = v === 'price_desc' ? 'price_desc' : 'price_asc'
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
// ── AI assistant: compact snapshot of what the user sees (sent with every chat question) ──
// Kept small on purpose: the VPS CPU evaluates prompts at only ~30 tokens/s.
const CHAT_CTX_MAX = 4000 // bytes of JSON; the server caps at 8 kB

const bothPrices = (ex: number, vat: number) => `${formatCzkExact(ex)} bez DPH / ${formatCzkExact(vat)} s DPH`

function chatProductLine(p: Product, withCategory: boolean): string {
  return [
    p.name.slice(0, 80),
    p.supplier,
    ...(p.sku ? [`kód ${p.sku}`] : []),
    ...(withCategory ? [typeName(p.typeSlug)] : []),
    `${bothPrices(p.price, p.priceVat)} za ${p.unit}`,
  ].join(' · ')
}

/** Products whose cards are (at least partly) on screen; fallback = the top of the list. */
function visibleProducts(limit: number): Product[] {
  const ids: string[] = []
  const vh = window.innerHeight
  for (const btn of region('main').querySelectorAll<HTMLElement>('.product-card [data-history]')) {
    const r = btn.closest('.product-card')!.getBoundingClientRect()
    if (r.bottom > 0 && r.top < vh && r.width > 0) ids.push(btn.dataset.history!)
    if (ids.length >= limit) break
  }
  const list = ids.map((id) => productsById.get(id)).filter((p): p is Product => !!p)
  return list.length ? list : catalogItems.slice(0, limit)
}

function chatContext(): Record<string, unknown> {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const goodsEx = lines.reduce((a, l) => a + l.lineExVat, 0)
  const goodsVat = lines.reduce((a, l) => a + l.lineVat, 0)
  const shipEx = shipping.reduce((a, s) => a + s.shippingExVat, 0)
  const shipVat = shipping.reduce((a, s) => a + s.shippingVat, 0)
  const t = currentType()
  const open = historyOpenId ? productsById.get(historyOpenId) : undefined
  const history = open ? priceHistoryCache[open.id] : undefined

  const quote = (maxItems: number): Record<string, unknown> | string => {
    if (!lines.length) return 'prázdná'
    return {
      'Počet položek': lines.length,
      ...(maxItems
        ? {
            Položky: [
              ...lines
                .slice(0, maxItems)
                .map((l) => `${l.qty} ${l.product.unit} × ${l.product.name.slice(0, 70)}, ${l.product.supplier}, ${formatCzkExact(l.product.price)}/${l.product.unit} bez DPH, řádek ${bothPrices(l.lineExVat, l.lineVat)}`),
              ...(lines.length > maxItems ? [`… a dalších ${lines.length - maxItems} položek`] : []),
            ],
          }
        : {}),
      'Zboží celkem': bothPrices(goodsEx, goodsVat),
      'Doprava (odhad)': bothPrices(shipEx, shipVat),
      'Celkem včetně dopravy': bothPrices(goodsEx + shipEx, goodsVat + shipVat),
      ...(quoteNote.trim() ? { Poznámka: quoteNote.trim().slice(0, 150) } : {}),
    }
  }

  const build = (maxProducts: number, maxItems: number): Record<string, unknown> => {
    const ctx: Record<string, unknown> = {
      Stránka: viewMode === 'quote' ? 'Cenová nabídka (#/nabidka)' : viewMode === 'search' ? 'Katalog – výsledky hledání' : 'Katalog',
    }
    if (viewMode !== 'quote') {
      if (viewMode === 'browse') {
        ctx.Kategorie = selectedSlug === ALL_SLUG ? 'Vše (celý katalog)' : t ? `${t.name} (skupina ${t.category})` : '—'
        const related = selectedSlug === ALL_SLUG ? [] : relatedFor(selectedSlug).map((r) => r.name)
        if (related.length) ctx['Související kategorie'] = related.slice(0, 6).join(', ')
      }
      ctx['Filtr dodavatele'] = supplierFilterLabel()
      ctx['Řazení'] = sortOrder === 'price_desc' ? 'cena ↓' : 'cena ↑'
      if (searchQ.trim()) ctx['Hledaný text'] = searchQ.trim().slice(0, 80)
      ctx['Počet produktů v seznamu'] = catalogLoading ? 'načítá se' : catalogItems.length
      if (open) {
        ctx['Otevřený detail produktu (Historie cen)'] = [
          chatProductLine(open, true),
          ...(open.dimensions ? [`rozměry ${open.dimensions.slice(0, 60)}`] : []),
          ...(history
            ? [
                history.length
                  ? `změny ceny: ${history.slice(0, 3).map((h) => `${formatHistoryDate(h.recordedAt)} ${formatCzkExact(h.oldPriceVat)} → ${formatCzkExact(h.newPriceVat)} s DPH`).join('; ')}`
                  : 'cena se zatím neměnila',
              ]
            : []),
        ].join(' · ')
      }
      if (maxProducts) {
        ctx['Produkty na obrazovce'] = visibleProducts(maxProducts).map((p) => chatProductLine(p, viewMode === 'search' || selectedSlug === ALL_SLUG))
      }
    }
    ctx['Cenová nabídka'] = quote(maxItems)
    return ctx
  }
  // shrink until it fits (fewer visible products first, then fewer quote lines)
  for (const [mp, mi] of [[6, 12], [4, 8], [2, 5], [0, 5], [0, 0]]) {
    const ctx = build(mp, mi)
    if (new TextEncoder().encode(JSON.stringify(ctx)).length <= CHAT_CTX_MAX) return ctx
  }
  return { Stránka: viewMode === 'quote' ? 'Cenová nabídka (#/nabidka)' : 'Katalog' }
}

// ── Kapitán Karel actions: tool calls the server validated, applied to this browser's state ──
function chatQuote() {
  return Object.entries(cart)
    .filter(([, q]) => q > 0)
    .map(([id, qty]) => ({ id, qty }))
}

/** leave the quote page without touching history (the chat drives navigation) */
function toCatalogView() {
  if (viewMode === 'quote') {
    quotePushed = false
    history.replaceState(null, '', catalogUrl())
  }
}

async function focusProduct(p: Product) {
  productsById.set(p.id, p)
  toCatalogView()
  selectedSlug = p.typeSlug
  viewMode = 'browse'
  searchQ = ''
  searchEl.value = ''
  // Ensure the product's supplier is visible (keep other toggles).
  if (p.supplier) selectedSuppliers.add(p.supplier)
  else selectAllSuppliers()
  history.replaceState(null, '', `#/${p.typeSlug}`)
  await loadProductsForCurrent()
  const idx = catalogItems.findIndex((x) => x.id === p.id)
  if (idx >= renderLimit) renderLimit = idx + 1
  historyOpenId = null
  void togglePriceHistory(p.id) // opens „Historie cen“ (renders)
  const card = app.querySelector(`[data-history="${CSS.escape(p.id)}"]`)?.closest<HTMLElement>('.product-card')
  if (card) {
    card.scrollIntoView({ block: 'center' })
    card.classList.add('is-flash')
    window.setTimeout(() => card.classList.remove('is-flash'), 2400)
  }
}

function applyChatAction(a: ChatAction): { undo?: () => void } | void {
  const args = a.args || {}
  const product = (): Product | undefined => {
    const id = String(args.id || '')
    if (a.product && a.product.id === id) productsById.set(id, a.product as unknown as Product)
    return productsById.get(id)
  }
  switch (a.name) {
    case 'otevrit_kategorii': {
      const slug = String(args.slug || '')
      toCatalogView()
      if (slug === ALL_SLUG || types.some((t) => t.slug === slug)) selectType(slug)
      return
    }
    case 'nastavit_filtr_dodavatele': {
      toCatalogView()
      const raw = String(args.dodavatel || '').trim()
      if (!raw || raw.toLocaleLowerCase('cs').startsWith('vsich')) {
        selectAllSuppliers()
      } else {
        selectedSuppliers = new Set([raw])
        if (!allCatalogSuppliers.includes(raw)) {
          allCatalogSuppliers = [...allCatalogSuppliers, raw].sort((a, b) => a.localeCompare(b, 'cs'))
          knownSupplierSnapshot.add(raw)
        }
        suppliersFilterReady = true
      }
      viewMode = searchQ.trim() ? 'search' : 'browse'
      if (viewMode === 'browse' && !selectedSlug) selectedSlug = ALL_SLUG
      void loadProductsForCurrent()
      return
    }
    case 'hledat_v_katalogu': {
      toCatalogView()
      searchQ = String(args.text || '').slice(0, 80)
      searchEl.value = searchQ
      viewMode = 'search'
      selectedSlug = null
      window.scrollTo({ top: 0 })
      void loadProductsForCurrent()
      return
    }
    case 'otevrit_detail_produktu': {
      const p = product()
      if (p) void focusProduct(p)
      return
    }
    case 'pridat_do_nabidky':
    case 'zmenit_mnozstvi_v_nabidce':
    case 'odebrat_z_nabidky': {
      const p = product()
      if (!p) return
      const prev = cart[p.id] || 0
      const next = Number(args.mnozstvi) || 0
      setQty(p.id, next)
      if (a.name === 'pridat_do_nabidky' || (next > 0 && prev === 0)) maybeTipAfterAdd(p)
      return { undo: () => setQty(p.id, prev) }
    }
    case 'otevrit_nabidku':
      openQuoteView()
      return
  }
}

// the chat starts once the user is known (its history is stored per user)
let chatStarted = false
function startChat() {
  if (pickMode || chatStarted) return
  chatStarted = true
  mountChatWidget(apiFetch, { getContext: chatContext, getQuote: chatQuote, applyAction: applyChatAction, userId })
}
