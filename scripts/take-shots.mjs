import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5173/acc-db/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: 'shots/01-katalog-blatniky.png', fullPage: false })

// related strip should be visible; click zasterky
const chip = page.locator('button.chip-btn', { hasText: 'Zástěrky' })
if (await chip.count()) {
  await chip.first().click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'shots/02-souvisejici-zasterky.png', fullPage: false })
}

// add a few products to cart
const addBtns = page.locator('button.primary-btn', { hasText: 'Přidat' })
const n = Math.min(3, await addBtns.count())
for (let i = 0; i < n; i++) {
  await addBtns.nth(i).click()
  await page.waitForTimeout(400)
}

// switch category to boxy
const box = page.locator('button.nav-item', { hasText: 'Box na nářadí' })
if (await box.count()) {
  await box.first().click()
  await page.waitForTimeout(1000)
  const add2 = page.locator('button.primary-btn', { hasText: 'Přidat' })
  if (await add2.count()) await add2.first().click()
  await page.waitForTimeout(400)
}

// open quote view
await page.locator('button', { hasText: 'Nabídka' }).first().click()
await page.waitForTimeout(800)
// fill note
const note = page.locator('textarea[data-quote-note]')
if (await note.count()) {
  await note.first().fill('Zakázka demo — předat obchodníkům zítra. Orientační nabídka.')
  await note.first().dispatchEvent('change')
}
await page.waitForTimeout(400)
await page.screenshot({ path: 'shots/03-cenova-nabidka.png', fullPage: false })

// mobile viewport catalog
await page.setViewportSize({ width: 390, height: 844 })
await page.locator('button', { hasText: 'Zavřít' }).first().click().catch(()=>{})
await page.waitForTimeout(500)
// go browse
const nav = page.locator('button.nav-item', { hasText: 'Blatníky' })
if (await nav.count()) await nav.first().click()
await page.waitForTimeout(1000)
await page.screenshot({ path: 'shots/04-mobil-katalog.png', fullPage: false })

await browser.close()
console.log('shots done')
