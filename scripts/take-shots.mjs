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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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

// drawer animation — slow the animation clock 10× via CDP to capture mid-transition frames
const cdp = await page.context().newCDPSession(page)
await cdp.send('Animation.enable')
await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 })
await page.locator('[data-action="toggle-cart"]').click()
await page.waitForTimeout(900) // ≈ 90 ms of real animation time
await shot(page, '03a-drawer-opening-mid')
await page.waitForTimeout(1300)
await shot(page, '03b-drawer-opening-late')
await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 })
await page.waitForTimeout(600)

// sample real-time transform values for a report
const samples = await page.evaluate(async () => {
  const d = document.querySelector('.cart-drawer')
  const b = document.querySelector('.backdrop')
  const read = () => ({
    x: Math.round(new DOMMatrix(getComputedStyle(d).transform).m41),
    op: Number(getComputedStyle(b).opacity).toFixed(2),
    vis: getComputedStyle(d).visibility,
  })
  const out = []
  document.querySelector('[data-action="close-cart"]').click()
  const t0 = performance.now()
  while (performance.now() - t0 < 420) {
    out.push({ t: Math.round(performance.now() - t0), ...read() })
    await new Promise((r) => requestAnimationFrame(r))
  }
  out.push({ t: 'end', ...read(), inDom: !!document.querySelector('.cart-drawer') })
  return out.filter((_, i, a) => i % 4 === 0 || i === a.length - 1)
})
console.log('close-samples', JSON.stringify(samples))

await page.locator('[data-action="toggle-cart"]').click()
await page.waitForTimeout(600)
const width = await page.evaluate(() => document.querySelector('.cart-drawer').getBoundingClientRect().width)
console.log('drawer width', width)
await shot(page, '03-drawer-open-wide')
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
console.log('after Esc open?', await page.evaluate(() => document.querySelector('.cart-drawer').classList.contains('open')))

// quote view
await page.locator('[data-action="open-quote"]').first().click()
await page.waitForTimeout(400)
await waitThumbs(page)
await page.waitForTimeout(800)
await shot(page, '04-cenova-nabidka', { fullPage: true })

// print rendering
await page.emulateMedia({ media: 'print' })
await page.waitForTimeout(300)
await shot(page, '05-tisk-nahled', { fullPage: true })
await page.pdf({ path: `${OUT}/${PREFIX}05-nabidka.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true })
await page.emulateMedia({ media: 'screen' })

// mobile
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await m.goto(BASE, { waitUntil: 'networkidle' })
await waitThumbs(m)
await m.screenshot({ path: `${OUT}/${PREFIX}06a-mobil-vse.png` })
await openCategory('podkladaci-desky', m)
await m.screenshot({ path: `${OUT}/${PREFIX}06-mobil-katalog.png` })
for (let i = 0; i < 2; i++) {
  await m.locator('button[data-add]').first().click()
  await m.waitForTimeout(200)
}
await m.evaluate(() => window.scrollTo(0, 0))
await m.locator('[data-action="toggle-cart"]').click()
await m.waitForTimeout(600)
await m.screenshot({ path: `${OUT}/${PREFIX}07-mobil-kosik.png` })

await browser.close()
