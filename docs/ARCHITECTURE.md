# acc-db — architektura

Stručná paměť: [`../AGENTS.md`](../AGENTS.md).

## Tok requestu

```
Browser (zakazky.contsystem.cz/acc-db/)
  │  cookie a_session_contsystem
  ▼
Traefik → acc-db-app (vite preview :4173)
  │
  ├─ auth-gate.ts
  │     GET Appwrite /account (projekt contsystem)
  │     role = Appwrite labels ∩ ACC_DB_ALLOWED_ROLES
  │
  └─ api-handler.ts  /api/*
        ├─ catalog-repo.ts → PostgreSQL (DATABASE_URL)
        ├─ image-proxy.ts
        └─ catalog-update.ts → scrape + seed
```

Lokálně (`npm run dev`): stejné middleware v Vite `configureServer`, auth defaultně vypnutá.

## Datové cesty

1. **`DATABASE_URL` nastaveno** — čtení z Postgres. Výpadek PG → HTTP **503** (žádný tichý fallback).
2. **`DATABASE_URL` chybí** — `scripts/scraped_products.json` + `category-map.json` (dev/demo).

## Katalog pipeline

```
scrape_products.py  →  scraped_products.json
seed.mjs            →  UPSERT accessories/products
                    →  INSERT price_history při změně ceny
                    →  UPDATE is_active=false u chybějících (ne DELETE)
```

UI „Aktualizovat katalog“ volá `POST /api/catalog/update` (token `ACC_DB_UPDATE_TOKEN`).

## Frontend

Jeden soubor [`src/main.ts`](../src/main.ts): kategorie, filtry, detail, nabídka `#/nabidka`, localStorage cart (`acc-db-cart-v2`). Žádný AI chat widget.

## Auth (zůstává Appwrite jen pro Manager)

Viz `src/server/auth-gate.ts`. Fail closed při nedostupném Appwrite. Nouzově `ACC_DB_AUTH=off`.
