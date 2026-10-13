# Pavlínek (pavlinek.cz) — dodavatel do acc-db

Datum: 2026-10-13  
Repo: `acc-db`  
Status: approved · implemented in acc-db-1

## Cíl

Přidat **Pavlínek** jako čtvrtého dodavatele do katalogu příslušenství: scrapovat celý e-shop (Shopify), mapovat produkty do stávajících kategorií kde sedí a vytvořit nové jen tam, kde chybí. Zároveň upravit UI filtru dodavatelů na větší klikatelné badge.

## Rozhodnutí (schváleno)

| Téma | Volba |
|------|--------|
| Rozsah | Celý e-shop (včetně metráže a drobných dílů) |
| Taxonomie | Do stávajících kategorií + nové jen pro zbytek |
| Scrape | Shopify JSON API (`/collections/{handle}/products.json`) |
| UI filtr | Badge tlačítka; select vedle search pryč; search vystředit a zúžit |

## Kategorie

### Stávající (mapovat Pavlínek sem)

- **`vazaci-prostredky`** — upínací pásy (jednodílné / dvoudílné / ráčny / volné části), přivazovací řetězy, samonavíjecí a speciální UP, sněhové řetězy
- **`navarovaci-oko`** — navařovací body, otočné vázací body, speciální vázací body, upínací body a misky, šrouby DIN 580, matice DIN 582, brandová kolekce **CODIPRO** (otočné vázací body — ne vlastní kategorie)

### Nové

| Slug | Název (UI) | Obsah | Unit |
|------|------------|-------|------|
| `retezove-vazaky` | Řetězové vazáky | jednopramenné…nekonečné, převěšovací řetězy | ks |
| `textilni-vazaky` | Textilní a lanové vazáky | pásy B2/B4/C2, vinuté smyčky, A2/A4, lanové, kombinované, speciální | ks |
| `vazaci-komponenty` | Vázací komponenty | háky, třmeny/šekly, hlavy, spojovací členy, karabiny, kroužky, obrtlíky, objímky, očnice, svorky, napínáky, klínové svorky, kladky, rychlospojky, štítky, náhradní díly | ks |
| `metraz-lana-retezy` | Metráž — lana a řetězy | řetězy, ocelová lana, provazy/šňůry, pásovina, ochrany metráž | **m** |
| `zvedaci-technika` | Zvedací a manipulační technika | kladkostroje, kočky, lanové/řetězové/hřebenové/hydraulické zvedáky, navijáky, jeřábky, magnety, traverzy, zvedací zařízení kontejnerů, nářadí a stroje | ks |
| `zajisteni-osob` | Zajištění osob | zajištění osob, ASS nerezový lankový systém | ks |
| `ochrany-prislusenstvi` | Ochrany a příslušenství | ochrany kusové, chemie (maziva), sítě a big bagy | ks |

UI kategorie: nové slugy pod **Ostatní** (kromě `navarovaci-oko`, které zůstává u Hákového nosiče).

### Kolekce, které se nescrapují

Agregáty / navigační rodiče (duplikují listové kolekce):

- `novinky`, `doprodej-vyprodej-1`, `vsechny-kolekce`
- parent: `retezove-lanove-a-textilni-vazaky`, `privazovaci-retezy-a-upinaci-pasy`, `vazaci-body`, `komponenty-kusove`, `komponenty-metraz`, `zarizeni-pro-zvedani-a-manipulaci`
- volitelně `codipro`, pokud už scrapujeme `otocne-vazaci-body` (dedup podle product ID stejně pokryje překryv)

Konkrétní `handle` → `typeSlug` žije v `scripts/category-map.json` sekce `pavlinek`.

## Scraper

### Zdroj dat

- Base: `https://www.pavlinek.cz`
- List kolekcí: `GET /collections.json?limit=250` (stránkování `page=`)
- Produkty kolekce: `GET /collections/{handle}/products.json?limit=250&page=`
- Polite delay stejně jako u ostatních dodavatelů

### Mapování produktu

| Pole | Zdroj |
|------|--------|
| `name` | `product.title` |
| `supplier` | `"Pavlínek"` |
| `typeSlug` | z mapy kolekce |
| `productUrl` | `https://www.pavlinek.cz/products/{handle}` |
| `imageUrl` | první `product.images[].src` (https) |
| `priceExVat` | min. cena z `variants[].price` (Shopify u Pavlínek zobrazuje bez DPH) |
| `priceWithVat` | `priceExVat * 1.21` (stejný VAT faktor jako jinde) |
| `unit` | z accessory definice (`m` u metráže, jinak `ks`) |
| rozměry / poznámka | z title / `body_html` / variant `option` kde dává smysl |

- Varianty: jedna katalogová položka = produkt; cena = minimum přes varianty („Od … Kč“).
- Deduplikace globálně podle Shopify `product.id` (produkt ve více kolekcích → jedna položka; při konfliktu `typeSlug` vyhraje první z mapy v pevném pořadí priorit, dokumentované v mapě).
- Produkty bez ceny přeskočit nebo uložit s `null` podle stávajícího vzoru ostatních scraperů (sjednotit se seedem).

### Integrace

- Rozšířit `scripts/scrape_products.py` o `scrape_pavlinek()` volané z `main` vedle ALSAP / TT / HT.
- `scripts/category-map.json`: nové `accessories` + pole `pavlinek: [{ typeSlug, url|handle }]`.
- `npm run scrape` / catalog update job beze změny API kontraktu (jen více položek + supplier).

## UI — filtr dodavatelů

### Chování

1. Odstranit `<select>` v `header-filter` (vedle search).
2. Search: vystředit v hlavičce, zúžit (`max-width` cca 380–420px místo 560px).
3. `supplier-legend` v `content-head` (vpravo nahoře u nadpisu):
   - větší badge styl (existující `.sup-badge.lg` nebo nový `.sup-filter`)
   - klikatelné: **Všichni** + každý dodavatel z katalogu (dynamicky z `catalogSuppliers`, včetně Pavlínek)
   - aktivní filtr = vizuální stav (`aria-pressed` / třída `.active`)
   - klik nastaví `supplierFilter` stejně jako dnešní select a reload katalogu
   - na view `#/nabidka` neaktivní / disabled (filtr platí jen pro katalog)
4. Počet u badge (`legend-n`) zůstává jako informativní count v aktuálním výsledku; filtr badge mohou ukazovat i bez count, nebo count jen u nefiltrovaného stavu — doporučení: count u každého dodavatele v aktuálním datasetu (jako teď), aktivní stav oddělen borderem/ringem.

### Styly

- Nový modifier `sup-pavlinek` (barva mimo ALSAP červenou, TT modrou, HT zelenou) — např. jantar / oranžovo-hnědá.
- Filter badge větší než dnešní legend (min. výška ~28–32px, větší padding, `cursor: pointer`).

### Chat / nástroje

- `SUPPLIER_NAME` / ID: přidat `pavlinek` → `Pavlínek` v `chat-widget.ts` a souvisejících tool schematech.
- Shipping: záznam v `shipping.ts` (odhad GLS/PPL nebo tržní odhad s poznámkou, pokud nemají veřejný ceník).

## Image proxy

- Allowlist hostů v `src/server/image-proxy.ts`: `www.pavlinek.cz`, `pavlinek.cz`, CDN domény z `images[].src` (typicky `cdn.shopify.com` — ověřit při implementaci a přidat konkrétní hosty).

## Mimorozsah

- Nepřepisovat ALSAP/TT/HT scrapery.
- Neřešit login / B2B ceny (veřejné ceny bez DPH stačí).
- Neměnit Appwrite schema kromě nových accessory řádků přes stávající seed.
- Design UI filtru platí i bez Pavlínek (3 dodavatelé → 4); lze implementovat UI dřív než scrape.

## Test plan (po implementaci)

- [ ] `npm run scrape` stáhne Pavlínek produkty do `scraped_products.json` se `supplier: "Pavlínek"`.
- [ ] Seed / offline API: nové kategorie ve stromu, produkty filtrovatelné.
- [ ] Badge filtr: Všichni / jednotliví dodavatelé; search bez selectu, vystředěný.
- [ ] Náhledy přes `/api/img` pro Pavlínek URL.
- [ ] Nabídka: součet + doprava pro Pavlínek řádky.
- [ ] Kapitán Karel: filtr dodavatele `Pavlínek`.

## Otevřené detaily (rozhodnout při implementaci)

1. Přesná hex paleta `sup-pavlinek`.
2. Priorita `typeSlug` při překryvu kolekcí.
3. Shipping sazba — ověřit veřejný ceník dopravy na pavlinek.cz vs. tržní odhad.
