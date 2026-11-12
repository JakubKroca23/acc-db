# ACC-DB — Kalkulačka příslušenství vozidla

Profesionální katalog a cenový odhad příslušenství pro stavitele nástaveb (české UI).
Data: **PostgreSQL** (`accessories`, `products`, `price_history`). Auth: Contsystem Manager (Appwrite session cookie).

Produkce: https://zakazky.contsystem.cz/acc-db/

Agent paměť: [`AGENTS.md`](AGENTS.md) · [`docs/`](docs/)

## Funkce

- Procházení kategorií (Podvozek, Všechny nástavby, Hákový nosič, Ostatní)
- Globální vyhledávání + filtr dodavatele
- **Související** skupiny (např. blatníky ↔ držáky ↔ zástěrky; boxy ↔ držáky boxů)
- **Historie cen** při seedu — v detailu produktu / nabídce
- **Cenová nabídka** (`#/nabidka`) s mezisoučty dle dodavatele, dopravou, tiskem/PDF, CSV
- Tlačítko **Aktualizovat katalog** (scrape + seed) se stavem průběhu

## Spuštění

```bash
cp .env.example .env   # POSTGRES_* + DATABASE_URL + ACC_DB_UPDATE_TOKEN
npm install
docker compose up -d postgres   # nebo vlastní PG
npm run scrape         # ALSAP + Trans-Technik (+ …)
npm run seed           # sync do Postgres
npm run dev            # http://localhost:5173/acc-db/
```

Bez `DATABASE_URL` API čte `scripts/scraped_products.json` (dev/demo).  
S `DATABASE_URL` a nedostupným Postgres → HTTP **503**.

## Přístup (login Contsystem Manageru)

Aplikace je dostupná jen uživatelům přihlášeným v Contsystem Manageru (`cs-zakazky`) s rolí z `ACC_DB_ALLOWED_ROLES`.

- Cookie `a_session_contsystem` → `auth-gate.ts` → Appwrite `/account` (projekt `contsystem`)
- Zapnutí: `ACC_DB_AUTH=manager` (v compose výchozí); lokálně bez něj bez přihlášení

## API (base `/acc-db/`)

| Method | Path | Popis |
|--------|------|--------|
| GET | `/api/categories` | strom kategorií + related groups |
| GET | `/api/accessories` | druhy příslušenství |
| GET | `/api/products?type=&supplier=&q=` | produkty (jen `is_active`) |
| GET | `/api/stats` | statistiky |
| GET | `/api/price-history?productId=` | historie cen |
| GET/HEAD | `/api/img?url=` | proxy náhledů |
| POST | `/api/catalog/update` | scrape+seed |
| GET | `/api/catalog/update/status` | stav jobu |

## Docker

```bash
docker compose up -d --build
```

Služby: `postgres` (`postgres:16-alpine`, healthcheck) + `app` (`depends_on: service_healthy`).

## Seed / soft-delete

Produkty chybějící ve scrapu se **deaktivují** (`is_active = false`), nemažou se — `price_history` zůstane. Ochrana neúplného scrape dodavatele: `SEED_FORCE_DELETE=1`.

## Poznámky

- Ceny jsou orientační z veřejných katalogů.
- Frontend volá jen `/api/*`; Postgres credentials zůstávají na serveru.
- Položky nabídky: `localStorage` klíč `acc-db-cart-v2`.
