# Pavlínek Supplier Implementation Plan

> **For agentic workers:** Execute task-by-task. Spec: `docs/superpowers/specs/2026-10-13-pavlinek-supplier-design.md`

**Goal:** Add Pavlínek as a catalog supplier (Shopify JSON scrape) and replace the supplier `<select>` with clickable badges.

**Architecture:** Extend `category-map.json` + `scrape_products.py`; wire UI/shipping/image-proxy/chat the same way as ALSAP/TT/HT.

**Tech Stack:** Python scraper, Vite/TS frontend, Appwrite seed (unchanged contract)

**Repo:** `acc-db-1` (has pick mode; active tree)

---

### Task 1: UI — badge supplier filter + search layout
### Task 2: category-map — new accessories + `pavlinek` URLs
### Task 3: scrape_products.py — Shopify JSON scraper
### Task 4: image-proxy, shipping, chat labels
### Task 5: cs-zakazky AccessoryPopisField supplier chip
### Task 6: Smoke — scrape Pavlínek-only or full scrape sample
