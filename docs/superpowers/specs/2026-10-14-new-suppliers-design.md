# Noví dodavatelé: Olejspol, Hydrolider, RECA

Datum: 2026-10-14  
Repo: `acc-db-1`  
Status: approved (brainstorm)

## Cíl

Rozšířit katalog příslušenství o tři dodavatele s **výběrovým** scrapem (jen kategorie relevantní pro nástavby / hydrauliku / montáž), ne celými e-shopy. Oleje: ceny z Olejspol + odkaz na technický list EXEL. Implementace **po fázích** (1 dodavatel = 1 dodávka).

## Rozhodnutí (schváleno)

| Téma | Volba |
|------|--------|
| Rozsah | Jen relevantní kategorie (ne celý shop) |
| Oleje | Dodavatel **Olejspol**; exel.cz = technické listy (odkaz), ne druhý scraper cen |
| Olejspol sortiment | Hydraulické + převodové / ATF |
| TL EXEL | Odkaz „Technický list ↗“ (`datasheetUrl`), ne stahování PDF |
| Hydrolider | C — čerpadla, nádrže, hadice, šroubení, filtry, chladiče, **válce, rozvaděče, ventily, motory** |
| RECA | Spojovací materiál + dílenská chemie |
| Spojovak taxonomie | Kategorie = **druh** (šroub 6HR, matice…); průměr/délka/pevnost = atributy produktu |
| Pořadí | 1) Olejspol → 2) Hydrolider → 3) RECA |
| Rate limiting | Stejná lekce jako Pavlínek (viz níže) |

## Poučení z Pavlínek (povinné u všech nových scraperů)

Shopify / agresivní limity učí:

1. Preferovat **bulk / jednorázový dump** nebo úzký seznam kategorií — ne hammering každé stránky.
2. Requesty **sekvenčně**, min. gap (start dle webu; u JSON API typicky ≥ 4–5 s).
3. Při **HTTP 429**: respektovat `Retry-After`, dlouhý cooldown (desítky s až minuty), **zvyšovat** gap — ne 3× rychlý retry.
4. Soft-ban: lehký probe + čekání; log „neklikej Znovu“.
5. Scrapovat **jen** URL/handly z `category-map.json`.
6. Job musí umět izolovaný běh: `SCRAPE_SUPPLIERS=Olejspol` (ostatní dodavatelé zůstanou z posledního úspěšného scrape).
7. Žádný paralelní worker pool proti stejným hostům.

Obecný `get()` už má krátký 429 backoff; nové scrapery s přísnějšími limity mají vlastní `get_*` (jako `get_pav`).

## Fáze 1 — Olejspol (+ TL EXEL)

### Dodavatel

- Display name: `Olejspol`
- Badge ID (chat): `olejspol`
- Zdroj cen: [olejspol.cz](https://olejspol.cz/)
- Reference značky: [exel.cz](https://www.exel.cz/produkty-exel/industry/hydraulicke-oleje/) (bez cen)

### Kategorie

| Slug | Název | Unit | Poznámka |
|------|-------|------|----------|
| `hydraulicky-olej` | Hydraulický olej | L | stávající |
| `prevodovy-olej` | Převodový olej / ATF | L | **nová**; related `hydraulika-kit` volitelně ne — spíš Ostatní / Všechny nástavby |

Mapovat jen průmyslové / hydraulické / převodové sekce Olejspol. **Nescrapovat** motorové oleje osobních aut, antiradary, autodíly, obaly.

### Technické listy

- Nové (nullable) pole produktu: `datasheetUrl: string | null`
- Seed / Appwrite: přidat atribut pokud chybí; offline JSON ho nese
- UI: vedle „Detail ↗“ zobrazit „Technický list ↗“ pokud `datasheetUrl` je set
- Naplnění: malá mapa `scripts/exel-datasheets.json` (klíč = normalizovaný název / SKU prefix EXEL → URL stránky nebo PDF na exel.cz). Při scrape Olejspol: pokud produkt vypadá jako EXEL, doplnit z mapy; jinak `null`
- Mimorozsah: OCR PDF, stahování do Appwrite Storage

### Shipping

- Olejspol: doprava zdarma od **1 500 Kč** (PPL) dle veřejného webu — `freeFromExVat` odpovídající (přepočet bez DPH dle stávajícího vzoru)
- `sourceUrl`: stránka dopravy Olejspol

## Fáze 2 — Hydrolider

### Dodavatel

- Display name: `Hydrolider`
- Badge ID: `hydrolider`
- Zdroj: [hydrolider.cz](https://hydrolider.cz/)

### Kategorie

**Stávající:** `cerpadlo`, `olejova-nadrz`

**Nové** (unit `ks`, UI pod hydraulikou / Ostatní; related group `hydraulika-kit` rozšířit o nové slugy kde dává smysl):

| Slug | Název |
|------|-------|
| `hydraulicky-valec` | Hydraulický válec |
| `hydraulicky-rozvadec` | Hydraulický rozvaděč |
| `hydraulicky-ventil` | Hydraulický ventil |
| `hydraulicky-motor` | Hydraulický motor |
| `hydraulicka-hadice` | Hydraulická hadice |
| `hydraulicke-sroubeni` | Hydraulické šroubení |
| `hydraulicky-filtr` | Hydraulický filtr |
| `chladic-oleje` | Chladič oleje |

### Filtr sortimentu

- Mapovat listové kategorie z menu Hydrolider odpovídající tabulce výše.
- Zemědělské speciality (Ursus/Zetor-only, oj sklízecí mlátičky, zámky přívěsů…) **nescrapovat**, pokud nesedí do výše.
- Oversize: válce / nádrže → už existující `OVERSIZE_TYPES` doplnit o `hydraulicky-valec` (a případně velké motory).

### Shipping

- Tržní odhad balíku + `sourceUrl` kontakt/doprava Hydrolider (ověřit při implementaci).

## Fáze 3 — RECA

**Zrušeno 14. 10. 2026.** RECA veřejné ceny neukazuje (až po přihlášení). Z katalogu i z databáze je pryč. Znovu ji nezapojovat, dokud o to uživatel výslovně nepožádá.

### Dodavatel

- Display name: `RECA`
- Badge ID: `reca`
- Zdroj: [reca.cz](https://www.reca.cz/shop/cs/uvodni-stranka)

### Spojovací materiál — taxonomie A

Kategorie = **druh**, ne průměr×délka×pevnost:

| Slug | Název (příklad) |
|------|-----------------|
| `srouby-sestihran` | Šrouby se šestihrannou hlavou |
| `srouby-vnitrni-sestihran` | Šrouby s vnitřním šestihranem |
| `matice` | Matice |
| `podlozky` | Podložky a pojistné prvky |
| `nyty` | Nýty |
| `vruty` | Vruty / šrouby do dřeva a plechu |
| `dilenska-chemie` | Dílenská chemie (lepidla, těsnění, maziva montážní) |

U produktu:

- `name` — plný název z RECA
- `dimensions` / `sku` — průměr, délka, pevnost (8.8 / 10.9…), povrch, kde jdou z listingu vyčíst
- Hledání v katalogu = primární filtr („M10×40 8.8“)

Konkrétní RECA category URL → slug žije v `category-map.json` sekce `reca` (doplní se při implementaci fáze 3 podle skutečné navigace e-shopu).

### Mimorozsah RECA

- OOP, diamantová technika, celý „Stavba“, brand shop jako celek
- Paralelní scrape / neomezené stránkování bez gapu

### Shipping

- Tržní odhad; ověřit veřejný ceník RECA při implementaci.

## Společná integrace (každá fáze)

1. `scripts/category-map.json` — `accessories` + sekce `olejspol` / `hydrolider` / `reca`
2. `scripts/scrape_products.py` — `scrape_olejspol` / `scrape_hydrolider` / `scrape_reca` + `ALL_SUPPLIERS` / `SCRAPE_SUPPLIERS`
3. `src/server/catalog-update.ts` — povolit nové jména dodavatelů
4. UI badge barvy (mimo ALSAP/TT/HT/Pav):
   - Olejspol — tmavě zelená
   - Hydrolider — ocelová / šedomodrá
   - RECA — červená (RECA-like)
5. `src/shipping.ts` — sazba + note
6. `src/server/image-proxy.ts` — allowlist hostů CDN e-shopu
7. Chat: `SUPPLIER_NAME`, system prompt, tool intents
8. `datasheetUrl` (fáze 1): types, API mapování, seed schema, karta produktu

## Scraper — technické poznámky (ověřit při implementaci)

Platformy se liší (Shoper / Magento-like / vlastní). Před kódem každé fáze:

1. Zjistit listovací URL a zda existuje JSON/XML feed (preferovat před HTML).
2. Ověřit DPH: ceny s/bez — sjednotit se stávajícím seedem (`price` = bez DPH, `priceVat` = s DPH 21 %).
3. Dedup podle product ID / URL.
4. Bez ceny → přeskočit nebo `null` podle vzoru ostatních scraperů.

## Mimorozsah (globální)

- B2B login / zákaznické ceny
- Appwrite Teams / změna auth
- Stahování PDF TL do storage
- Celé katalogy RECA / Hydrolider / motorové oleje OA
- Přepis ALSAP/TT/HT/Pav scraperů

## Test plan (po každé fázi)

- [ ] `SCRAPE_SUPPLIERS=<Dodavatel>` stáhne jen daného dodavatele; ostatní v JSON zůstanou
- [ ] Žádný storm 429 při běžném běhu; při 429 job čeká a pokračuje
- [ ] Nové kategorie ve stromu; produkty filtrovatelné badge
- [ ] Náhledy `/api/img`
- [ ] Nabídka + doprava pro nového dodavatele
- [ ] Kapitán Karel: filtr `[[dodavatel:…]]`
- [ ] Fáze 1: u EXEL položky funguje „Technický list ↗“

## Otevřené detaily (rozhodnout při implementaci fáze)

1. Přesné category URL v mapě (po prozkoumání navigace e-shopu)
2. Hex paleta badge
3. Přesná shipping čísla z veřejného ceníku
4. Appwrite atribut `datasheetUrl` — migrace/setup script idempotentně
5. Hydrolider: které zemědělské kategorie definitivně vynechat (whitelist mapy)
