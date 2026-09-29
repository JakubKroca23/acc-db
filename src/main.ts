import './style.css'
import type { AccessoryType, CartMap, Product } from './types'
import { estimateShippingBySupplier, SHIPPING_AVG, type ShippingEstimate } from './shipping'

const STORAGE_KEY = 'acc-db-cart-v2'
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

function dualPrice(exVat: number, withVat: number): string {
  return `<span class="dual-price"><strong>${formatCzk(withVat)}</strong> <span class="muted">s DPH</span> · <span>${formatCzk(exVat)}</span> <span class="muted">bez DPH</span></span>`
}

type DbStats = {
  types: number
  products: number
  categories: number
  suppliers: number
  bySupplier: Record<string, number>
  withImage: number
  priceVat: { min: number; max: number; avg: number }
  shipping: {
    rates: {
      supplier: string
      label: string
      priceExVat: number
      priceVat: number
      note: string
      freeFromExVat: number | null
    }[]
    averageParcel: typeof SHIPPING_AVG
  }
  updatedAt: string
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

function clampQty(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(9999, Math.floor(n))
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

let types: AccessoryType[] = []
let productsById = new Map<string, Product>()
let cart: CartMap = loadCart()
let statusText = 'Načítám…'
let statusError = false
let typeQuery = ''
let stats: DbStats | null = null

type PickerState = {
  type: AccessoryType
  q: string
  supplier: string
  items: Product[]
  suppliers: string[]
  loading: boolean
  error: string | null
} | null

let picker: PickerState = null

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    stats = data as DbStats
  } catch {
    stats = null
  }
}

async function loadTypes() {
  statusText = 'Načítám typy příslušenství…'
  statusError = false
  render()
  try {
    const [res] = await Promise.all([fetch(`${API_BASE}/accessories`), loadStats()])
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    types = data.items as AccessoryType[]
    statusText = stats
      ? `Aktualizováno ${new Date(stats.updatedAt).toLocaleString('cs-CZ')}`
      : `Katalog načten · ${types.length} druhů`
    statusError = false
  } catch (err) {
    statusText = err instanceof Error ? err.message : 'Chyba načtení'
    statusError = true
  }
  render()
}

async function openPicker(type: AccessoryType) {
  picker = {
    type,
    q: '',
    supplier: '',
    items: [],
    suppliers: [],
    loading: true,
    error: null,
  }
  render()
  await refreshPicker()
}

async function refreshPicker() {
  if (!picker) return
  picker.loading = true
  picker.error = null
  render()
  try {
    const params = new URLSearchParams({ type: picker.type.slug })
    if (picker.q.trim()) params.set('q', picker.q.trim())
    if (picker.supplier) params.set('supplier', picker.supplier)
    const res = await fetch(`${API_BASE}/products?${params}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    picker.items = data.items as Product[]
    picker.suppliers = data.suppliers as string[]
    for (const p of picker.items) productsById.set(p.id, p)
    picker.loading = false
  } catch (err) {
    picker.loading = false
    picker.error = err instanceof Error ? err.message : 'Chyba'
  }
  render()
}

function closePicker() {
  picker = null
  render()
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

function statsPanelHtml(): string {
  if (!stats) {
    return `<div class="db-stats"><div class="db-stats-loading">Načítám stav databáze…</div></div>`
  }
  const supplierBits = Object.entries(stats.bySupplier)
    .filter(([s]) => s !== 'tržní odhad')
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${escapeHtml(s)} ${n}`)
    .join(' · ')
  const rates = stats.shipping.rates
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.supplier)}</strong> — ${escapeHtml(r.label)}:
          ${formatCzk(r.priceVat)} s DPH / ${formatCzk(r.priceExVat)} bez DPH
          ${r.freeFromExVat ? ` <span class="muted">(zdarma od ${formatCzk(r.freeFromExVat)} bez DPH)</span>` : ''}
        </li>`,
    )
    .join('')
  const avg = stats.shipping.averageParcel
  return `
    <section class="db-stats" aria-label="Stav databáze příslušenství">
      <div class="db-stats-title">Stav databáze příslušenství</div>
      <div class="db-stats-grid">
        <div class="stat"><span class="stat-value">${stats.products}</span><span class="stat-label">produktů</span></div>
        <div class="stat"><span class="stat-value">${stats.types}</span><span class="stat-label">druhů</span></div>
        <div class="stat"><span class="stat-value">${stats.suppliers}</span><span class="stat-label">dodavatelů</span></div>
        <div class="stat"><span class="stat-value">${stats.categories}</span><span class="stat-label">kategorií</span></div>
        <div class="stat"><span class="stat-value">${stats.withImage}</span><span class="stat-label">s náhledem</span></div>
        <div class="stat"><span class="stat-value">${formatCzk(stats.priceVat.avg)}</span><span class="stat-label">prům. cena s DPH</span></div>
      </div>
      <div class="db-stats-suppliers">${supplierBits}</div>
      <div class="db-stats-shipping">
        <div class="db-stats-title">Průměrná doprava příslušenství (CZ)</div>
        <p class="db-stats-note">
          Balík typicky ~ ${formatCzk(avg.parcelVat)} s DPH / ${formatCzk(avg.parcelExVat)} bez DPH.
          Nadrozměr / paleta ~ ${formatCzk(avg.oversizeVat)} s DPH / ${formatCzk(avg.oversizeExVat)} bez DPH.
          Zdroj: ceníky Trans-Technik a Hydrotruck; ALSAP bez pevného ceníku → odhad.
        </p>
        <ul class="shipping-rates">${rates}</ul>
      </div>
    </section>
  `
}

async function hydrateCartProducts() {
  const missing = Object.keys(cart).filter((id) => !productsById.has(id))
  if (!missing.length) return
  // fetch all products once and fill map
  try {
    const res = await fetch(`${API_BASE}/products`)
    const data = await res.json()
    if (!res.ok) return
    for (const p of data.items as Product[]) productsById.set(p.id, p)
  } catch {
    /* ignore */
  }
}

function filteredTypes(): AccessoryType[] {
  const q = typeQuery.trim().toLocaleLowerCase('cs')
  if (!q) return types
  return types.filter(
    (t) =>
      t.name.toLocaleLowerCase('cs').includes(q) ||
      t.category.toLocaleLowerCase('cs').includes(q),
  )
}

function groupTypes(list: AccessoryType[]): [string, AccessoryType[]][] {
  const map = new Map<string, AccessoryType[]>()
  for (const item of list) {
    const arr = map.get(item.category) || []
    arr.push(item)
    map.set(item.category, arr)
  }
  return [...map.entries()]
}

/** Top-level items first; children nest under parentSlug. */
function nestTypes(list: AccessoryType[]): { parent: AccessoryType; children: AccessoryType[] }[] {
  const bySlug = new Map(list.map((t) => [t.slug, t]))
  const childrenByParent = new Map<string, AccessoryType[]>()
  for (const t of list) {
    if (!t.parentSlug) continue
    if (!bySlug.has(t.parentSlug)) continue
    const arr = childrenByParent.get(t.parentSlug) || []
    arr.push(t)
    childrenByParent.set(t.parentSlug, arr)
  }
  const roots = list
    .filter((t) => !t.parentSlug || !bySlug.has(t.parentSlug))
    .sort((a, b) => a.sortOrder - b.sortOrder)
  return roots.map((parent) => ({
    parent,
    children: (childrenByParent.get(parent.slug) || []).sort((a, b) => a.sortOrder - b.sortOrder),
  }))
}

function selectedForType(slug: string) {
  return cartLines().filter((l) => l.product.typeSlug === slug)
}

function render() {
  const groups = groupTypes(filteredTypes())
  const lines = cartLines()
  const shipping = shippingForCart(lines)
  const goodsEx = lines.reduce((acc, l) => acc + l.lineExVat, 0)
  const goodsVat = lines.reduce((acc, l) => acc + l.lineVat, 0)
  const shipEx = shipping.reduce((acc, s) => acc + s.shippingExVat, 0)
  const shipVat = shipping.reduce((acc, s) => acc + s.shippingVat, 0)
  const totalEx = goodsEx + shipEx
  const totalVat = goodsVat + shipVat

  app.innerHTML = `
    <header class="top">
      <div class="brand">ACC-DB</div>
      <h1>Příslušenství k vozidlu</h1>
      <p class="lead">U každého druhu si z nápovědy naklikejte konkrétní produkty. Ceny i doprava jsou bez DPH i s DPH.</p>
      ${statsPanelHtml()}
      <div class="toolbar">
        <input class="search" type="search" placeholder="Filtrovat druhy…" value="${escapeAttr(typeQuery)}" aria-label="Filtrovat druhy" />
        <button class="ghost-btn" type="button" data-action="clear" ${lines.length ? '' : 'disabled'}>Vymazat výběr</button>
        <button class="ghost-btn" type="button" data-action="reload-stats">Obnovit DB</button>
      </div>
      <div class="status ${statusError ? 'error' : ''}">${escapeHtml(statusText)}</div>
    </header>

    <main>
      ${
        !types.length
          ? `<div class="empty">${statusError ? escapeHtml(statusText) : 'Načítám…'}</div>`
          : !groups.length
            ? `<div class="empty">Nic nenalezeno</div>`
            : groups
                .map(([category, list]) => {
                  const nested = nestTypes(list)
                  return `
        <h2 class="category">${escapeHtml(category)}</h2>
        <div class="list">
          ${nested
            .map(({ parent, children }) => {
              if (!children.length) return typeRowHtml(parent)
              return `
            <div class="type-group">
              ${typeRowHtml(parent)}
              <div class="sublist">
                <div class="sublist-label">Podřízené u ${escapeHtml(parent.name)}</div>
                ${children.map((c) => typeRowHtml(c, true)).join('')}
              </div>
            </div>`
            })
            .join('')}
        </div>`
                })
                .join('')
      }
    </main>

    <aside class="summary" aria-live="polite">
      <div class="summary-inner">
        <div>
          <div class="summary-label">Odhad celkem</div>
          <div class="summary-sub">${
            lines.length
              ? `${lines.length} produktů · doprava ${shipping.filter((s) => s.shippingVat > 0).length ? 'zahrnuta' : '0 Kč / zdarma'}`
              : 'Zatím nic nevybráno'
          }</div>
        </div>
        <div class="summary-totals">
          <div class="summary-total">${formatCzk(totalVat)} <span class="tiny-vat">s DPH</span></div>
          <div class="summary-ex">${formatCzk(totalEx)} bez DPH</div>
        </div>
      </div>
      ${
        lines.length
          ? `<details open>
              <summary>Rozpis zboží a dopravy</summary>
              <ul class="picked">
                ${lines
                  .map(
                    (l) => `<li>
                      <span>${escapeHtml(l.product.name)} × ${l.qty}&nbsp;${escapeHtml(l.product.unit)}
                        <em class="tiny">${escapeHtml(l.product.supplier)}</em>
                      </span>
                      <span class="price-stack">
                        <span class="price">${formatCzk(l.lineVat)}</span>
                        <span class="price-ex">${formatCzk(l.lineExVat)} bez DPH</span>
                      </span>
                    </li>`,
                  )
                  .join('')}
                ${shipping
                  .map(
                    (s) => `<li class="ship-line">
                      <span>Doprava ${escapeHtml(s.supplier)}
                        <em class="tiny">${escapeHtml(s.note)}${s.free ? ' · zdarma' : ''}</em>
                      </span>
                      <span class="price-stack">
                        <span class="price">${formatCzk(s.shippingVat)}</span>
                        <span class="price-ex">${formatCzk(s.shippingExVat)} bez DPH</span>
                      </span>
                    </li>`,
                  )
                  .join('')}
                <li class="total-line">
                  <span>Zboží</span>
                  <span class="price-stack">
                    <span class="price">${formatCzk(goodsVat)}</span>
                    <span class="price-ex">${formatCzk(goodsEx)} bez DPH</span>
                  </span>
                </li>
                <li class="total-line">
                  <span>Doprava celkem</span>
                  <span class="price-stack">
                    <span class="price">${formatCzk(shipVat)}</span>
                    <span class="price-ex">${formatCzk(shipEx)} bez DPH</span>
                  </span>
                </li>
              </ul>
            </details>`
          : ''
      }
    </aside>

    ${picker ? pickerHtml() : ''}
  `

  bindMainEvents()
  if (picker) bindPickerEvents()
}

function typeRowHtml(t: AccessoryType, nested = false): string {
  const selected = selectedForType(t.slug)
  const count = selected.reduce((a, l) => a + l.qty, 0)
  const subEx = selected.reduce((a, l) => a + l.lineExVat, 0)
  const subVat = selected.reduce((a, l) => a + l.lineVat, 0)
  const approxEx = t.priceApprox
  const approxVat = Math.round(t.priceApprox * 1.21)
  return `
    <div class="row type-row ${nested ? 'nested' : ''} ${count ? 'active' : ''}">
      <div class="row-main">
        <div class="row-name">${escapeHtml(t.name)}</div>
        <div class="row-meta">
          <span>od ~ ${formatCzk(approxVat)} s DPH / ${formatCzk(approxEx)} bez DPH · ${escapeHtml(t.unit)}</span>
          ${count ? `<span class="chip">${count} ks · ${formatCzk(subVat)} s DPH / ${formatCzk(subEx)} bez DPH</span>` : `<span>zatím nevybráno</span>`}
        </div>
        ${
          selected.length
            ? `<ul class="mini-picked">
                ${selected
                  .slice(0, 4)
                  .map(
                    (l) =>
                      `<li>${escapeHtml(l.product.name.slice(0, 64))}${l.product.name.length > 64 ? '…' : ''} <strong>×${l.qty}</strong></li>`,
                  )
                  .join('')}
                ${selected.length > 4 ? `<li>+${selected.length - 4} dalších</li>` : ''}
              </ul>`
            : ''
        }
      </div>
      <button class="primary-btn" type="button" data-open="${escapeAttr(t.slug)}">Přidat</button>
    </div>
  `
}

function pickerHtml(): string {
  if (!picker) return ''
  const { type, items, suppliers, q, supplier, loading, error } = picker
  return `
    <div class="overlay" data-close-overlay>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Výběr ${escapeAttr(type.name)}">
        <div class="sheet-head">
          <div>
            <div class="sheet-kicker">Přidat do výběru</div>
            <h2>${escapeHtml(type.name)}</h2>
          </div>
          <button class="ghost-btn" type="button" data-close>Zavřít</button>
        </div>
        <div class="sheet-filters">
          <input class="search" type="search" data-picker-q placeholder="Hledat název, rozměr, SKU…" value="${escapeAttr(q)}" />
          <select data-picker-supplier aria-label="Dodavatel">
            <option value="">Všichni dodavatelé</option>
            ${suppliers
              .map(
                (s) =>
                  `<option value="${escapeAttr(s)}" ${s === supplier ? 'selected' : ''}>${escapeHtml(s)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="sheet-status">${loading ? 'Načítám produkty…' : error ? escapeHtml(error) : `${items.length} produktů`}</div>
        <div class="product-grid">
          ${
            loading
              ? `<div class="empty">Načítám…</div>`
              : !items.length
                ? `<div class="empty">Žádný produkt neodpovídá filtru</div>`
                : items.map((p) => productCardHtml(p)).join('')
          }
        </div>
      </div>
    </div>
  `
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
        <div class="product-price">
          ${dualPrice(p.price, p.priceVat)}
          <span class="muted">/ ${escapeHtml(p.unit)}</span>
        </div>
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
    </article>
  `
}

function bindMainEvents() {
  const search = app.querySelector<HTMLInputElement>('.top .search')
  search?.addEventListener('input', () => {
    typeQuery = search.value
    render()
    const again = app.querySelector<HTMLInputElement>('.top .search')
    if (again) {
      again.focus()
      const len = again.value.length
      again.setSelectionRange(len, len)
    }
  })

  app.querySelector('[data-action="clear"]')?.addEventListener('click', clearAll)
  app.querySelector('[data-action="reload-stats"]')?.addEventListener('click', () => {
    void loadTypes()
  })

  app.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.open!
      const type = types.find((t) => t.slug === slug)
      if (type) void openPicker(type)
    })
  })
}

function bindPickerEvents() {
  app.querySelector('[data-close]')?.addEventListener('click', closePicker)
  app.querySelector('[data-close-overlay]')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePicker()
  })

  const qInput = app.querySelector<HTMLInputElement>('[data-picker-q]')
  let timer: number | undefined
  qInput?.addEventListener('input', () => {
    if (!picker) return
    picker.q = qInput.value
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      void refreshPicker()
    }, 220)
  })

  app.querySelector<HTMLSelectElement>('[data-picker-supplier]')?.addEventListener('change', (e) => {
    if (!picker) return
    picker.supplier = (e.target as HTMLSelectElement).value
    void refreshPicker()
  })

  app.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.add!
      const product = picker?.items.find((p) => p.id === id)
      if (product) addOne(product)
    })
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
void loadTypes().then(() => hydrateCartProducts().then(render))
