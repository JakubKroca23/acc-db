import './style.css'
import type { AccessoryType, CartMap, CatalogUpdateStatus, Product, RelatedGroup } from './types'
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

let selectedSlug: string | null = null
let searchQ = ''
let supplierFilter = ''
let viewMode: 'browse' | 'search' | 'quote' = 'browse'
let cartOpen = false

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
    if (!selectedSlug && types.length) {
      selectedSlug = types.find((t) => !t.parentSlug)?.slug || types[0].slug
    }
    statusText = stats
      ? `${stats.products} produktů · ${stats.types} druhů · aktualizováno ${new Date(stats.updatedAt).toLocaleString('cs-CZ')}`
      : `Katalog načten · ${types.length} druhů`
    statusError = false
    await hydrateCartProducts()
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
    } else if (selectedSlug) {
      params.set('type', selectedSlug)
    }
    if (supplierFilter) params.set('supplier', supplierFilter)
    const res = await fetch(`${API_BASE}/products?${params}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    catalogItems = data.items as Product[]
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
  supplierFilter = ''
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
  toastMsg = `Přidáno: ${product.name.slice(0, 48)}`
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
  viewMode = 'quote'
  cartOpen = true
  render()
  window.setTimeout(() => window.print(), 120)
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

// ── render helpers ────────────────────────────────────────────────
function navHtml(): string {
  const cats = [...new Set(types.map((t) => t.category))]
  const order = ['Podvozek', 'Všechny nástavby', 'Hákový nosič kontejneru', 'Ostatní']
  const sorted = [...cats].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

  return sorted
    .map((cat) => {
      const roots = types
        .filter((t) => t.category === cat && (!t.parentSlug || !types.some((x) => x.slug === t.parentSlug)))
        .sort((a, b) => a.sortOrder - b.sortOrder)
      return `
        <div class="nav-group">
          <div class="nav-group-title">${escapeHtml(cat)}</div>
          ${roots
            .map((t) => {
              const children = types
                .filter((c) => c.parentSlug === t.slug)
                .sort((a, b) => a.sortOrder - b.sortOrder)
              const active = selectedSlug === t.slug && viewMode === 'browse'
              return `
                <button type="button" class="nav-item ${active ? 'active' : ''}" data-type="${escapeAttr(t.slug)}">
                  <span>${escapeHtml(t.name)}</span>
                </button>
                ${children
                  .map((c) => {
                    const cActive = selectedSlug === c.slug && viewMode === 'browse'
                    return `<button type="button" class="nav-item nested ${cActive ? 'active' : ''}" data-type="${escapeAttr(c.slug)}">
                      <span>${escapeHtml(c.name)}</span>
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

function productCardHtml(p: Product): string {
  const qty = cart[p.id] || 0
  const img = p.imageUrl
    ? `<img src="${escapeAttr(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="img-fallback">${escapeHtml(p.supplier.slice(0, 1))}</div>`
  return `
    <article class="product-card ${qty ? 'in-cart' : ''}">
      <div class="thumb">${img}</div>
      <div class="product-body">
        <div class="product-name">${escapeHtml(p.name)}</div>
        <div class="product-meta">
          <span class="supplier">${escapeHtml(p.supplier)}</span>
          ${p.dimensions ? `<span>${escapeHtml(p.dimensions)}</span>` : ''}
          ${p.sku ? `<span>SKU ${escapeHtml(p.sku)}</span>` : ''}
        </div>
        <div class="product-price">${dualPrice(p.price, p.priceVat)} <span class="muted">/ ${escapeHtml(p.unit)}</span></div>
        <div class="product-actions">
          ${
            qty
              ? `<div class="qty" data-qty="${escapeAttr(p.id)}">
                  <button type="button" data-dec aria-label="Snížit">−</button>
                  <input type="number" min="0" value="${qty}" />
                  <button type="button" data-inc aria-label="Zvýšit">+</button>
                </div>`
              : `<button class="primary-btn" type="button" data-add="${escapeAttr(p.id)}">Přidat</button>`
          }
          ${
            p.productUrl
              ? `<a class="link" href="${escapeAttr(p.productUrl)}" target="_blank" rel="noopener noreferrer">Detail</a>`
              : ''
          }
        </div>
      </div>
    </article>`
}

function quotePanelHtml(embedded = false): string {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const goodsEx = lines.reduce((a, l) => a + l.lineExVat, 0)
  const goodsVat = lines.reduce((a, l) => a + l.lineVat, 0)
  const shipEx = shipping.reduce((a, s) => a + s.shippingExVat, 0)
  const shipVat = shipping.reduce((a, s) => a + s.shippingVat, 0)
  const now = new Date().toLocaleString('cs-CZ')

  if (!lines.length) {
    return `<div class="quote-empty">
      <h2>Cenová nabídka</h2>
      <p>Zatím nic ve výběru. Vyberte produkty v katalogu.</p>
    </div>`
  }

  const groupsHtml = groupLinesBySupplier(lines)
    .map(([supplier, group]) => {
      const subEx = group.reduce((a, l) => a + l.lineExVat, 0)
      const subVat = group.reduce((a, l) => a + l.lineVat, 0)
      const ship = shipping.find((s) => s.supplier === supplier)
      return `
        <section class="quote-supplier">
          <h3>${escapeHtml(supplier)}</h3>
          <table class="quote-table">
            <thead>
              <tr>
                <th>Položka</th>
                <th>Mj</th>
                <th>Cena bez / s DPH</th>
                <th>Počet</th>
                <th>Řádek bez / s DPH</th>
                <th class="no-print"></th>
              </tr>
            </thead>
            <tbody>
              ${group
                .map(
                  (l) => `<tr>
                    <td>
                      <div class="q-name">${escapeHtml(l.product.name)}</div>
                      <div class="q-meta">${escapeHtml(typeName(l.product.typeSlug))}
                        ${l.product.dimensions ? ` · ${escapeHtml(l.product.dimensions)}` : ''}
                        ${l.product.sku ? ` · SKU ${escapeHtml(l.product.sku)}` : ''}
                      </div>
                    </td>
                    <td>${escapeHtml(l.product.unit)}</td>
                    <td class="num">${formatCzkExact(l.product.price)}<br /><span class="muted">${formatCzkExact(l.product.priceVat)}</span></td>
                    <td>
                      <div class="qty compact no-print" data-qty="${escapeAttr(l.product.id)}">
                        <button type="button" data-dec aria-label="Snížit">−</button>
                        <input type="number" min="0" value="${l.qty}" />
                        <button type="button" data-inc aria-label="Zvýšit">+</button>
                      </div>
                      <span class="print-only">${l.qty}</span>
                    </td>
                    <td class="num"><strong>${formatCzkExact(l.lineExVat)}</strong><br /><span class="muted">${formatCzkExact(l.lineVat)}</span></td>
                    <td class="no-print"><button type="button" class="ghost-btn tiny" data-remove="${escapeAttr(l.product.id)}" aria-label="Odebrat">✕</button></td>
                  </tr>`,
                )
                .join('')}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4">Mezisoučet zboží ${escapeHtml(supplier)}</td>
                <td class="num"><strong>${formatCzkExact(subEx)}</strong><br /><span class="muted">${formatCzkExact(subVat)}</span></td>
                <td class="no-print"></td>
              </tr>
              ${
                ship
                  ? `<tr class="ship-row">
                      <td colspan="4">Doprava ${escapeHtml(supplier)} <span class="muted">— ${escapeHtml(ship.note)}${ship.free ? ' · zdarma' : ''}</span></td>
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
    <div class="quote ${embedded ? 'embedded' : ''}" id="quote-print">
      <header class="quote-head">
        <div>
          <div class="quote-kicker">ACC-DB · orientační nabídka</div>
          <h2>Cenová nabídka příslušenství</h2>
          <p class="quote-date">${escapeHtml(now)}</p>
        </div>
        <div class="quote-actions no-print">
          <button type="button" class="ghost-btn" data-action="copy-quote">Kopírovat do schránky</button>
          <button type="button" class="ghost-btn" data-action="csv-quote">Stáhnout CSV</button>
          <button type="button" class="primary-btn" data-action="print-quote">Tisk / PDF</button>
        </div>
      </header>
      <p class="quote-disclaimer">Ceny jsou orientační z veřejných katalogů dodavatelů — nejde o závazný ceník. Před předáním obchodníkům zkontrolujte množství a položky.</p>
      <label class="quote-note no-print">
        <span>Poznámka pro obchodníky</span>
        <textarea data-quote-note rows="2" placeholder="např. zakázka XY, termín, specifikace nástavby…">${escapeHtml(quoteNote)}</textarea>
      </label>
      ${quoteNote.trim() ? `<div class="quote-note-print print-only"><strong>Poznámka:</strong> ${escapeHtml(quoteNote)}</div>` : ''}
      ${groupsHtml}
      <div class="quote-totals">
        <div class="qt-row"><span>Zboží celkem</span><span>${formatCzkExact(goodsEx)} <span class="muted">bez DPH</span> · <strong>${formatCzkExact(goodsVat)}</strong> <span class="muted">s DPH</span></span></div>
        <div class="qt-row"><span>Doprava celkem</span><span>${formatCzkExact(shipEx)} <span class="muted">bez DPH</span> · <strong>${formatCzkExact(shipVat)}</strong> <span class="muted">s DPH</span></span></div>
        <div class="qt-row grand"><span>Celkem</span><span>${formatCzkExact(goodsEx + shipEx)} <span class="muted">bez DPH</span> · <strong>${formatCzkExact(goodsVat + shipVat)}</strong> <span class="muted">s DPH</span></span></div>
      </div>
      <div class="quote-foot no-print">
        <button type="button" class="ghost-btn" data-action="clear" ${lines.length ? '' : 'disabled'}>Vymazat nabídku</button>
      </div>
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

function render() {
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const goodsVat = lines.reduce((a, l) => a + l.lineVat, 0)
  const shipVat = shipping.reduce((a, s) => a + s.shippingVat, 0)
  const t = currentType()
  const heading =
    viewMode === 'search'
      ? `Hledání: „${searchQ.trim() || '…'}“`
      : viewMode === 'quote'
        ? 'Cenová nabídka'
        : t?.name || 'Katalog'

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-block">
          <div class="brand">ACC-DB</div>
          <div class="brand-sub">Kalkulačka příslušenství</div>
        </div>
        <nav class="nav" aria-label="Kategorie">${navHtml()}</nav>
        <div class="sidebar-foot">
          <button type="button" class="ghost-btn block" data-action="update-catalog">Aktualizovat katalog</button>
          <div class="status tiny ${statusError ? 'error' : ''}">${escapeHtml(statusText)}</div>
        </div>
      </aside>

      <div class="main-col">
        <header class="topbar">
          <div class="search-wrap">
            <input class="search" type="search" placeholder="Hledat v celém katalogu…" value="${escapeAttr(searchQ)}" aria-label="Hledat produkty" data-global-search />
            <select data-supplier aria-label="Dodavatel" ${viewMode === 'quote' ? 'disabled' : ''}>
              <option value="">Všichni dodavatelé</option>
              ${catalogSuppliers
                .map(
                  (s) =>
                    `<option value="${escapeAttr(s)}" ${s === supplierFilter ? 'selected' : ''}>${escapeHtml(s)}</option>`,
                )
                .join('')}
            </select>
          </div>
          <div class="top-actions">
            <button type="button" class="ghost-btn ${viewMode === 'quote' ? 'active' : ''}" data-action="open-quote">
              Nabídka${cartCount() ? ` (${cartCount()})` : ''}
            </button>
            <button type="button" class="primary-btn cart-fab" data-action="toggle-cart" aria-expanded="${cartOpen}">
              Košík · ${formatCzk(goodsVat + shipVat)}
            </button>
          </div>
        </header>

        ${updateStatusHtml()}
        ${toastMsg ? `<div class="toast" role="status">${escapeHtml(toastMsg)}</div>` : ''}

        ${
          viewMode === 'quote'
            ? `<main class="content quote-view">${quotePanelHtml()}</main>`
            : `<main class="content">
                <div class="content-head">
                  <h1>${escapeHtml(heading)}</h1>
                  <p class="lead">${
                    viewMode === 'search'
                      ? `${catalogItems.length} výsledků`
                      : t
                        ? `Procházejte produkty · ceny bez DPH i s DPH · ${catalogItems.length} položek`
                        : ''
                  }</p>
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
                          : catalogItems.map((p) => productCardHtml(p)).join('')
                  }
                </div>
              </main>`
        }
      </div>

      <aside class="cart-drawer ${cartOpen || viewMode === 'quote' ? 'open' : ''}" aria-label="Košík a nabídka">
        <div class="cart-drawer-inner">
          <div class="cart-drawer-head no-print">
            <h2>Nabídka / košík</h2>
            <button type="button" class="ghost-btn" data-action="toggle-cart">Zavřít</button>
          </div>
          ${quotePanelHtml(true)}
        </div>
      </aside>
      ${cartOpen && viewMode !== 'quote' ? `<div class="backdrop no-print" data-action="toggle-cart"></div>` : ''}
    </div>
  `

  bindEvents()
}

function bindEvents() {
  app.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => selectType(btn.dataset.type!))
  })

  const search = app.querySelector<HTMLInputElement>('[data-global-search]')
  search?.addEventListener('input', () => {
    searchQ = search.value
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      if (searchQ.trim()) {
        viewMode = 'search'
        selectedSlug = null
      } else {
        viewMode = 'browse'
        if (!selectedSlug && types.length) selectedSlug = types[0].slug
      }
      void loadProductsForCurrent()
    }, 280)
  })

  app.querySelector<HTMLSelectElement>('[data-supplier]')?.addEventListener('change', (e) => {
    supplierFilter = (e.target as HTMLSelectElement).value
    void loadProductsForCurrent()
  })

  app.querySelectorAll('[data-action="toggle-cart"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      cartOpen = !cartOpen
      if (!cartOpen && viewMode === 'quote') viewMode = 'browse'
      render()
    })
  })

  app.querySelector('[data-action="open-quote"]')?.addEventListener('click', () => {
    viewMode = 'quote'
    cartOpen = true
    render()
  })

  app.querySelector('[data-action="clear"]')?.addEventListener('click', clearAll)
  app.querySelector('[data-action="copy-quote"]')?.addEventListener('click', () => void copyQuote())
  app.querySelector('[data-action="csv-quote"]')?.addEventListener('click', downloadCsv)
  app.querySelector('[data-action="print-quote"]')?.addEventListener('click', printQuote)
  app.querySelector('[data-action="update-catalog"]')?.addEventListener('click', () => void triggerUpdate())

  app.querySelectorAll<HTMLTextAreaElement>('[data-quote-note]').forEach((ta) => {
    ta.addEventListener('change', () => saveNote(ta.value))
    ta.addEventListener('blur', () => saveNote(ta.value))
  })

  app.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.add!
      const product = catalogItems.find((p) => p.id === id) || productsById.get(id)
      if (product) addOne(product)
    })
  })

  app.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => setQty(btn.dataset.remove!, 0))
  })

  app.querySelectorAll<HTMLElement>('[data-qty]').forEach((el) => {
    const id = el.dataset.qty!
    el.querySelector('[data-dec]')?.addEventListener('click', () => setQty(id, (cart[id] || 0) - 1))
    el.querySelector('[data-inc]')?.addEventListener('click', () => setQty(id, (cart[id] || 0) + 1))
    el.querySelector('input')?.addEventListener('change', (e) => {
      setQty(id, Number((e.target as HTMLInputElement).value))
    })
  })
}

render()
void loadBootstrap()
