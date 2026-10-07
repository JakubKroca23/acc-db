# ACC-DB — Kalkulačka příslušenství vozidla

Profesionální katalog a cenový odhad příslušenství pro stavitele nástaveb (české UI).
Data: **Appwrite TablesDB** (`acc-db`) — tabulky `accessories` a `products`.

Produkce: https://zakazky.contsystem.cz/acc-db/

## Funkce

- Procházení kategorií (Podvozek, Všechny nástavby, Hákový nosič, Ostatní)
- Globální vyhledávání + filtr dodavatele
- **Související** skupiny (např. blatníky ↔ držáky ↔ zástěrky; boxy ↔ držáky boxů)
- **Historie cen** při seedu (tabulka `price_history`) — v detailu produktu / nabídce
- **Cenová nabídka** (tlačítko v hlavičce s průběžnou cenou bez DPH, celostránkové zobrazení `#/nabidka`) s mezisoučty dle dodavatele, dopravou, tiskem/PDF, CSV a kopírováním do schránky; filtr dodavatele je v hlavičce před vyhledáváním
- Tlačítko **Aktualizovat katalog** (scrape + seed) se stavem průběhu

## Spuštění

```bash
cp .env.example .env   # doplň APPWRITE_API_KEY a ACC_DB_UPDATE_TOKEN
npm install
npm run scrape         # ALSAP + Trans-Technik (+ Hydrotruck)
npm run seed           # sync do Appwrite
npm run dev            # http://localhost:5173/acc-db/
```

## Přístup (login Contsystem Manageru)

Aplikace je dostupná jen uživatelům přihlášeným v Contsystem Manageru (`cs-zakazky`, stejná doména) s rolí z `ACC_DB_ALLOWED_ROLES` (výchozí `dev`).

- Manager ukládá Appwrite session do httpOnly cookie `a_session_contsystem` (path `/`), prohlížeč ji posílá i na `/acc-db/`.
- Server (`src/server/auth-gate.ts`) ji před každým požadavkem (HTML, assety, všechna `/api/*`) ověří přes `GET https://appwrite.propoj.app/v1/account` (projekt `contsystem`, hlavička `X-Appwrite-Session`) a zkontroluje Appwrite labels uživatele. Výsledek se cachuje 60 s (podle SHA-256 secretu). Není potřeba žádný API klíč.
- Nepřihlášen: HTML → 302 na `/login?next=%2Facc-db%2F`, API → 401 JSON. Bez role: 403 („Nemáte přístup — aplikace je zatím dostupná jen pro vývojáře“). Appwrite nedostupný: 503 (fail closed).
- `GET /api/me` vrací přihlášeného uživatele (jméno v hlavičce, odkaz zpět do Manageru).
- Zapnutí: `ACC_DB_AUTH=manager` (v `docker-compose.yml` výchozí); lokální vývoj bez něj běží bez přihlášení. Nouzové vypnutí: `ACC_DB_AUTH=off` v `.env` na serveru.

## API (Vite middleware, base `/acc-db/`)

| Method | Path | Popis |
|--------|------|--------|
| GET | `/api/categories` | strom kategorií + related groups |
| GET | `/api/accessories` | druhy příslušenství |
| GET | `/api/products?type=&supplier=&q=` | produkty |
| GET | `/api/stats` | statistiky + poslední update |
| GET | `/api/price-history?productId=` | historie změn ceny produktu |
| GET/HEAD | `/api/img?url=` | proxy + cache náhledů (jen https z ALSAP / Trans-Technik / Hydrotruck, pouze rastrové obrázky, max 6 MB; `.jpg` 404 → zkusí `.webp`) |
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
- Položky nabídky a poznámka jsou v `localStorage` (klíč `acc-db-cart-v2` zachován kvůli kompatibilitě).

## Appwrite / offline fallback

Pokud `APPWRITE_API_KEY` není platný, API automaticky čte `scripts/scraped_products.json`
a `scripts/category-map.json` (vhodné pro vývoj a demo). Pro produkční sync spusťte
`npm run seed` s klíčem, který má práva na TablesDB `acc-db`.

Hydrotruck scrape může selhat na SSL z některých sítí — skript zkusí insecure fallback;
podložky pod podpěry / boxy na desky jsou na `hydrotruck.cz/podlozky-pod-patky-podper`.
Pokud HT zůstane nedostupný, seed použije tržní odhad jen pro podkládací desky.

## Náhledy (obrázky)

- Scraper bere obrázek z `<picture><source srcset>` (Hydrotruck má u `<img src>` často
  neexistující `.jpg`, reálný soubor je jen `.webp`), z lazy-load atributů
  (`data-src`, `data-srcset`, `srcset`) a relativní URL převádí na absolutní.
- Na konci scrape se každá URL obrázku ověří (HTTP 200 + magic bytes — Trans-Technik
  neposílá `Content-Type`). Mrtvé URL se opraví (`.jpg`→`.webp`, `og:image` z detailu
  produktu), jinak se uloží `null`. Přeskočení: `SKIP_IMAGE_VERIFY=1 npm run scrape`.
- Frontend načítá všechny náhledy přes `/acc-db/api/img?url=…` (vlastní origin, cache
  v paměti + `/tmp/acc-db-img-cache`, `Cache-Control: max-age=7 dní`), takže nevadí
  hotlinking, chybějící `Content-Type` ani výpadky TLS u Hydrotrucku. Funguje i v tisku/PDF.
- `category-map.json` → položka může mít `maxPages` (Hydrotruck čerpadla mají ~20 stran,
  záměrně bereme jen první stranu). Když zdrojová stránka selže (HT občas vrací chybovou
  stránku 500), převezmou se poslední známé produkty dané kategorie, aby je seed nesmazal.
