# Olejspol Supplier Implementation Plan (fáze 1)

> **For agentic workers:** Execute task-by-task. Spec: `docs/superpowers/specs/2026-10-14-new-suppliers-design.md`

**Goal:** Add Olejspol as catalog supplier (hydraulic + gear/ATF oils) with EXEL datasheet links and Pavlínek-style polite scraping.

**Architecture:** HTML scrape of Shopware listing pages (`?p=` pagination), map in `category-map.json`, sequential requests with gap + 429 backoff. Keep other suppliers from previous scrape via `SCRAPE_SUPPLIERS=Olejspol`.

**Tech Stack:** Python scraper, existing acc-db TypeScript UI/API/seed.

## Global Constraints

- Rate limit: sequential, gap ≥ 1 s, long 429 cooldown
- Only mapped category URLs
- Prices: `price` = bez DPH, `priceVat` = s DPH
- Supplier display name: `Olejspol`

## Tasks

### Task 1: category-map + accessory `prevodovy-olej`

- [ ] Add accessory + `olejspol` URL entries in `scripts/category-map.json`

### Task 2: scrape_olejspol

- [ ] Implement parser + `SCRAPE_SUPPLIERS` / keep-previous merge
- [ ] `scripts/exel-datasheets.json` + attach `datasheetUrl` for EXEL products

### Task 3: UI / API / shipping / chat / image proxy

- [ ] `datasheetUrl` through types, API, seed, product card link
- [ ] Badge color, shipping, chat IDs, image allowlist, update dialog

### Task 4: Verify

- [ ] `SCRAPE_SUPPLIERS=Olejspol` run; products in JSON with supplier Olejspol
