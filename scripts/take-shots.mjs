// Screenshot helper: BASE_URL=http://localhost:5173/acc-db/ node scripts/take-shots.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = process.env.BASE_URL || 'http://localhost:5173/acc-db/'
const OUT = process.env.SHOTS_DIR || 'shots'
const PREFIX = process.env.SHOTS_PREFIX || ''
mkdirSync(OUT, { recursive: true })
const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${PREFIX}${name}.png`, ...opts })

async function waitThumbs(page) {
  await page.waitForFunction(() => !document.querySelector('.product-grid .empty') || !/Načítám/.test(document.querySelector('.product-grid .empty').textContent), null, { timeout: 30000 }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  await page
    .waitForFunction(() => [...document.querySelectorAll('.thumb img')].slice(0, 8).every((i) => i.complete), null, { timeout: 20000 })
    .catch(() => {})
  await page.waitForTimeout(400)
}

async function thumbStats(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.product-card')]
    const imgs = cards.map((c) => c.querySelector('.thumb img'))
    return {
      cards: cards.length,
      loaded: imgs.filter((i) => i && i.complete && i.naturalWidth > 0).length,
      fallback: cards.filter((c) => c.querySelector('.thumb .img-fallback')).length,
    }
  })
}

const browser = await chromium.launch({ headless: true })
// Auth gate (ACC_DB_AUTH=manager): pass the Manager session as SHOTS_COOKIE="a_session_contsystem=<secret>"
const [cookieName, ...cookieRest] = (process.env.SHOTS_COOKIE || '').split('=')
const cookies = cookieName && cookieRest.length ? [{ name: cookieName, value: cookieRest.join('='), url: new URL(BASE).origin }] : []
async function newPage(opts) {
  const ctx = await browser.newContext(opts)
  if (cookies.length) await ctx.addCookies(cookies)
  return ctx.newPage()
}
const page = await newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })

async function openCategory(slug, p = page) {
  const btn = p.locator(`button.nav-item[data-type="${slug}"]`)
  await btn.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'center' }))
  await btn.click()
  await p.waitForTimeout(150)
  await waitThumbs(p)
}

// default view = „Vše“ (whole catalogue, progressive rendering)
await waitThumbs(page)
const vse = await page.evaluate(() => ({
  active: document.querySelector('.nav-item.active')?.textContent.trim().replace(/\s+/g, ' '),
  firstNav: document.querySelector('.nav-item')?.textContent.trim().replace(/\s+/g, ' '),
  cards: document.querySelectorAll('.product-card').length,
  lead: document.querySelector('.lead')?.textContent,
}))
console.log('vse', JSON.stringify(vse))
await shot(page, '00-vse-vychozi')
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(800)
console.log('vse after scroll cards', await page.evaluate(() => document.querySelectorAll('.product-card').length))
await page.selectOption('[data-supplier]', 'Hydrotruck')
await waitThumbs(page)
console.log('vse+Hydrotruck', await page.evaluate(() => document.querySelector('.lead')?.textContent))
await page.evaluate(() => window.scrollTo(0, 0))
await shot(page, '00b-vse-filtr-hydrotruck')

await openCategory('podkladaci-desky')
// scroll all cards into view once so lazy images load, then measure
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) {
    window.scrollTo(0, y)
    await new Promise((r) => setTimeout(r, 120))
  }
  window.scrollTo(0, 0)
})
await waitThumbs(page)
console.log('pads', JSON.stringify(await thumbStats(page)))
await shot(page, '01-katalog-podkladaci-desky')

await openCategory('klece-na-podkladaci-desky')
console.log('holders', JSON.stringify(await thumbStats(page)))

// add products from all three suppliers
async function addFirst(n) {
  const add = page.locator('button[data-add]')
  for (let i = 0; i < n && (await add.count()); i++) {
    await add.first().click()
    await page.waitForTimeout(150)
  }
}
await addFirst(1)
await openCategory('podkladaci-desky')
await addFirst(2)
await openCategory('blatniky')
console.log('blatniky', JSON.stringify(await thumbStats(page)))
await shot(page, '02-katalog-blatniky-badges')
await addFirst(1)
for (const sup of ['sup-tt', 'sup-alsap']) {
  const card = page.locator('.product-card', { has: page.locator(`.${sup}`) }).locator('button[data-add]')
  if (await card.count()) await card.first().click()
  await page.waitForTimeout(150)
}
await page.waitForTimeout(300)

// nav highlight for categories with products in the quote: a child-only category (parent gets a dot),
// another group, then back to „Blatníky“ = active + in quote
for (const slug of ['drzaky-boxu', 'kamery']) {
  await openCategory(slug)
  await addFirst(1)
}
await openCategory('blatniky')
const navState = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.nav-item.in-quote, .nav-item.child-in-quote, .nav-group-title.has-quote')].map((el) =>
      [el.textContent.trim().replace(/\s+/g, ' '), el.className.replace(/\s+/g, ' ').trim(), el.getAttribute('title') || ''].join(' | '),
    ),
  )
console.log('nav in-quote', JSON.stringify(await navState(), null, 1))
await page.evaluate(() => (document.querySelector('.nav').scrollTop = 0))
await shot(page, '02b-nav-v-nabidce', { clip: { x: 0, y: 0, width: 520, height: 900 } })
// live update: remove one Blatníky item from its card (qty → 0), then add it back
const blat = () => page.evaluate(() => document.querySelector('.nav-item[data-type="blatniky"]')?.textContent.trim().replace(/\s+/g, ' '))
const b0 = await blat()
const firstQty = page.locator('.product-card [data-qty]').first()
const qid = await firstQty.getAttribute('data-qty')
await page.locator(`.product-card [data-qty="${qid}"] input`).fill('0')
await page.locator(`.product-card [data-qty="${qid}"] input`).dispatchEvent('change')
await page.waitForTimeout(200)
const b1 = await blat()
await page.locator(`button[data-add="${qid}"]`).click()
await page.waitForTimeout(200)
console.log('nav live', b0, '→', b1, '→', await blat())
await page.reload({ waitUntil: 'networkidle' })
await waitThumbs(page)
console.log('nav after reload', await blat())

// header: supplier filter BEFORE search, „Cenová nabídka“ button with the live total badge
const hdr = await page.evaluate(() => {
  const x = (sel) => document.querySelector(sel)?.getBoundingClientRect().left ?? null
  const btn = document.querySelector('.quote-btn')
  return {
    filterLeft: x('.header-filter select'),
    searchLeft: x('.header-search'),
    buttonText: btn?.textContent.trim().replace(/\s+/g, ' '),
    badge: btn?.querySelector('.quote-badge')?.textContent,
    title: btn?.getAttribute('title'),
    drawerEls: document.querySelectorAll('.cart-drawer, .backdrop, [data-region="drawer"], [data-action="toggle-cart"]').length,
    kosik: /ko[sš]ík/i.test(document.body.innerText),
    addLabel: document.querySelector('button[data-add]')?.textContent,
  }
})
console.log('header', JSON.stringify(hdr))
await shot(page, '03-hlavicka-filtr-hledani-nabidka', { clip: { x: 0, y: 0, width: 1440, height: 120 } })
await shot(page, '03b-katalog-s-nabidkou')

// quote view (full page)
const scrollBefore = 900
await page.evaluate((y) => window.scrollTo(0, y), scrollBefore)
await page.waitForTimeout(200)
await page.locator('[data-action="open-quote"]').first().click()
await page.waitForTimeout(400)
await waitThumbs(page)
await page.waitForTimeout(800)
console.log('quote url', new URL(page.url()).hash, 'back btn', await page.locator('[data-action="back-to-catalog"]').count())
await shot(page, '04-cenova-nabidka', { fullPage: true })

// quantity change in the quote updates the header badge live
const badgeBefore = await page.locator('.quote-badge').textContent()
await page.locator('.quote [data-qty] [data-inc]').first().click()
await page.waitForTimeout(200)
const badgeAfter = await page.locator('.quote-badge').textContent()
console.log('badge live', badgeBefore, '→', badgeAfter)
await page.locator('.quote [data-qty] [data-dec]').first().click()
await page.waitForTimeout(200)

// print rendering
await page.emulateMedia({ media: 'print' })
await page.waitForTimeout(300)
await shot(page, '05-tisk-nahled', { fullPage: true })
await page.pdf({ path: `${OUT}/${PREFIX}05-nabidka.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true })
await page.emulateMedia({ media: 'screen' })

// way back: button → catalog (same category, scroll restored); browser Back and Esc too
await page.locator('[data-action="back-to-catalog"]').click()
await page.waitForTimeout(500)
console.log('back button →', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, h1: document.querySelector('h1')?.textContent, y: Math.round(scrollY) }))))
await page.locator('[data-action="open-quote"]').first().click()
await page.waitForTimeout(300)
await page.goBack()
await page.waitForTimeout(500)
console.log('browser back →', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, h1: document.querySelector('h1')?.textContent, quote: !!document.querySelector('.quote') }))))
await page.locator('[data-action="open-quote"]').first().click()
await page.waitForTimeout(300)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
console.log('Esc →', JSON.stringify(await page.evaluate(() => ({ hash: location.hash, quote: !!document.querySelector('.quote') }))))
await page.reload({ waitUntil: 'networkidle' })
console.log('persisted after reload, badge', await page.locator('.quote-badge').textContent())

// mobile
const m = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await m.goto(BASE, { waitUntil: 'networkidle' })
await waitThumbs(m)
await m.screenshot({ path: `${OUT}/${PREFIX}06a-mobil-vse.png` })
await m.locator('button[data-add]').first().click() // a cheap „Držák rezervy“ item from „Vše“
await m.waitForTimeout(200)
await openCategory('podkladaci-desky', m)
for (let i = 0; i < 2; i++) {
  await m.locator('button[data-add]').first().click()
  await m.waitForTimeout(200)
}
await m.evaluate(() => window.scrollTo(0, 0))
await m.waitForTimeout(300)
console.log('mobile header', JSON.stringify(await m.evaluate(() => {
  const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && [Math.round(b.left), Math.round(b.top), Math.round(b.width)] }
  const sel = document.querySelector('.header-filter select')
  return { brand: r('.brand'), btn: r('.quote-btn'), filter: r('.header-filter select'), search: r('.header-search'), selectClipped: sel ? sel.scrollWidth > sel.clientWidth : null, docOverflow: document.documentElement.scrollWidth > innerWidth }
})))
await m.screenshot({ path: `${OUT}/${PREFIX}06-mobil-katalog.png` })
await m.screenshot({ path: `${OUT}/${PREFIX}06b-mobil-hlavicka.png`, clip: { x: 0, y: 0, width: 390, height: 170 } })
console.log('mobile nav in-quote', JSON.stringify(await m.evaluate(() => [...document.querySelectorAll('.nav-item.in-quote')].map((e) => e.textContent.trim().replace(/\s+/g, ' ') + (e.classList.contains('active') ? ' (active)' : '')))))
await m.evaluate(() => { const n = document.querySelector('.nav'); const c = n.querySelector('.nav-item[data-type="drzak-rezervy"]'); n.scrollLeft = c ? c.offsetLeft - n.offsetLeft - 150 : 0 })
await m.waitForTimeout(200)
await m.screenshot({ path: `${OUT}/${PREFIX}06c-mobil-nav-v-nabidce.png`, clip: { x: 0, y: 0, width: 390, height: 190 } })
await m.locator('[data-action="open-quote"]').click()
await m.waitForTimeout(600)
await waitThumbs(m)
await m.screenshot({ path: `${OUT}/${PREFIX}07-mobil-nabidka.png` })

await browser.close()
