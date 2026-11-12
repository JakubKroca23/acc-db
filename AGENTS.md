# AGENTS.md — paměť pro AI agenty (acc-db)

Kanonický kontext pro práci v tomto repo. Detaily: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md), [`docs/DEPLOY.md`](docs/DEPLOY.md). Index: [`.agents/README.md`](.agents/README.md).

## Co je acc-db

**Kalkulačka příslušenství vozidla** — katalog a cenová nabídka pro stavitele nástaveb (české UI).

| | |
|---|---|
| **URL** | https://zakazky.contsystem.cz/acc-db/ |
| **VPS path** | `/home/ubuntu/contsystem/acc-db` |
| **Kontejner** | `acc-db-app` + `acc-db-postgres` |
| **Traefik** | `Host(zakazky.contsystem.cz) && PathPrefix(/acc-db)` |

## Stack

| Vrstva | Technologie |
|--------|-------------|
| UI | Vite + TypeScript (vanilla DOM), `base: '/acc-db/'` |
| API | Vite middleware (`src/server/*`) — stejný proces jako preview |
| Data | **PostgreSQL 16** (`DATABASE_URL`), tabulky `accessories`, `products`, `price_history` |
| Auth | Contsystem Manager session cookie → Appwrite `/account` (projekt `contsystem`) — **jen login**, ne data |
| Ingest | `scripts/scrape_products.py` → `scraped_products.json` → `scripts/seed.mjs` |
| Deploy | Docker Compose + Traefik na síti `appwrite` |

**Bez AI chatu** — Kapitán Karel / Ollama / Groq / Gemini byly odstraněny.

## Strom

```
src/
  main.ts              # katalog + nabídka UI
  shipping.ts, types.ts, style.css
  server/
    api-handler.ts     # REST /api/*
    auth-gate.ts       # Manager cookie
    db.ts              # pg.Pool na globalThis
    catalog-repo.ts    # SQL čtení katalogu
    catalog-update.ts  # scrape+seed job
    image-proxy.ts
scripts/
  scrape_products.py
  seed.mjs
  sql/001_init.sql
  category-map.json
  scraped_products.json
docs/                  # ARCHITECTURE, DATA-MODEL, DEPLOY
.agents/README.md
```

## Než saháš do kódu

1. **Nikdy** necommituj `.env`, hesla Postgres, API klíče.
2. Katalogová data = **Postgres**, ne Appwrite TablesDB. `MANAGER_APPWRITE_*` je jen auth.
3. Bez `DATABASE_URL` → fallback na `scraped_products.json`. S `DATABASE_URL` a pádem PG → **HTTP 503** (ne tichý JSON).
4. Produkty ve scrapu chybějící se **deaktivují** (`is_active = false`), nemažou se (kvůli `price_history`).
5. UI jazyk: **čeština**.
6. `pg.Pool` musí žít na `globalThis` (Vite HMR).

## Typické úkoly

| Úkol | Kam |
|------|-----|
| UI katalog / nabídka | `src/main.ts`, `src/style.css` |
| API endpoint | `src/server/api-handler.ts` |
| SQL / schéma | `scripts/sql/001_init.sql`, `docs/DATA-MODEL.md` |
| Seed / soft-delete | `scripts/seed.mjs` |
| Scrape dodavatelů | `scripts/scrape_products.py`, `category-map.json` |
| Auth gate | `src/server/auth-gate.ts` |
| Deploy | `docker-compose.yml`, `docs/DEPLOY.md` |

## Second brain

Související poznámky ve vaultu (`~/obsidian`): projekt acc-db, Kapitán (archiv), dodavatelé Olejspol/Hydrolider.
