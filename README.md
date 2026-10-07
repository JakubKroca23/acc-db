# ACC-DB — Kalkulačka příslušenství vozidla

Profesionální katalog a cenový odhad příslušenství pro stavitele nástaveb (české UI).
Data: **Appwrite TablesDB** (`acc-db`) — tabulky `accessories` a `products`.

Produkce: https://zakazky.contsystem.cz/acc-db/

## Funkce

- Procházení kategorií (Podvozek, Všechny nástavby, Hákový nosič, Ostatní)
- Globální vyhledávání + filtr dodavatele
- **Související** skupiny (např. blatníky ↔ držáky ↔ zástěrky; boxy ↔ držáky boxů)
- **Historie cen** při seedu (tabulka `price_history`) — v detailu produktu / nabídce
- Košík / **cenová nabídka** s mezisoučty dle dodavatele, dopravou, tiskem/PDF, CSV a kopírováním do schránky
- Tlačítko **Aktualizovat katalog** (scrape + seed) se stavem průběhu

## Spuštění

```bash
cp .env.example .env   # doplň APPWRITE_API_KEY a ACC_DB_UPDATE_TOKEN
npm install
npm run scrape         # ALSAP + Trans-Technik (+ Hydrotruck)
npm run seed           # sync do Appwrite
npm run dev            # http://localhost:5173/acc-db/
```

## API (Vite middleware, base `/acc-db/`)

| Method | Path | Popis |
|--------|------|--------|
| GET | `/api/categories` | strom kategorií + related groups |
| GET | `/api/accessories` | druhy příslušenství |
| GET | `/api/products?type=&supplier=&q=` | produkty |
| GET | `/api/stats` | statistiky + poslední update |
| GET | `/api/price-history?productId=` | historie změn ceny produktu |
| POST | `/api/catalog/update` | spustí scrape+seed (volitelně `X-Update-Token`) |
| GET | `/api/catalog/update/status` | stav jobu |

Token: `ACC_DB_UPDATE_TOKEN` v `.env`. Pokud není nastaven, update je povolen (vhodné jen pro privátní deploy).

## Kategorie a related groups

Mapování dodavatelských URL → `typeSlug` je v `scripts/category-map.json`.
Related skupiny (kits):

- blatníky + držáky blatníků + zástěrky
- box na nářadí + držáky boxů
- hasicí bedny + držáky hasičů
- nádoby na vodu + držáky kanystrů
- podložky pod podpěry (podkládací desky) + boxy/klece na tyto desky (Hydrotruck)
- čerpadlo + olejová nádrž + olej

## Scraper

```bash
npm run scrape   # → scripts/scraped_products.json
npm run seed
```

Opravy oproti 1. verzi:

- ALSAP stránkování `?f=OFFSET` (ne `strana=`)
- leaf kategorie místo rodičů s JS pagerem
- Trans-Technik: `product-types-card` **i** `product-types-table`
- TT card ceny jsou **bez DPH** (dříve chybně dělené 1.21)

## Docker

```bash
docker compose up -d --build
```

Image obsahuje Python 3 kvůli aktualizaci katalogu z UI.

## Poznámky

- Ceny jsou orientační z veřejných katalogů — ne závazný ceník.
- Appwrite API klíč zůstává na serveru; frontend volá jen `/api/*`.
- Košík a poznámka nabídky jsou v `localStorage`.

## Appwrite / offline fallback

Pokud `APPWRITE_API_KEY` není platný, API automaticky čte `scripts/scraped_products.json`
a `scripts/category-map.json` (vhodné pro vývoj a demo). Pro produkční sync spusťte
`npm run seed` s klíčem, který má práva na TablesDB `acc-db`.

Hydrotruck scrape může selhat na SSL z některých sítí — skript zkusí insecure fallback;
podložky pod podpěry / boxy na desky jsou na `hydrotruck.cz/podlozky-pod-patky-podper`.
Pokud HT zůstane nedostupný, seed použije tržní odhad jen pro podkládací desky.
