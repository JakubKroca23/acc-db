# acc-db — datový model (PostgreSQL)

Schéma: [`../scripts/sql/001_init.sql`](../scripts/sql/001_init.sql).

## Tabulky

### `accessories`

| Sloupec | Typ | Poznámka |
|---------|-----|----------|
| `slug` | `text` PK | dříve Appwrite row id |
| `name`, `category` | `text` | |
| `unit` | `text` CHECK (`ks`\|`L`\|`m`) | |
| `price_approx`, `price_min`, `price_max` | `numeric(12,2)` | |
| `source`, `source_url`, `note` | text / nullable | `note` = `related:<groupId>` |
| `sort_order` | `int` | |
| `parent_slug` | `text` nullable | |

### `products`

| Sloupec | Typ | Poznámka |
|---------|-----|----------|
| `id` | `text` PK | sha1(`supplier\|url\|name`).slice(0,32) |
| `name`, `type_slug`, `supplier` | `text` | |
| `price`, `price_vat` | `numeric(12,2)` | |
| `unit` | CHECK | |
| `dimensions`, `image_url`, `product_url`, `sku`, `note`, `datasheet_url` | nullable | |
| `is_active` | `boolean NOT NULL DEFAULT true` | soft-delete při absenci ve scrapu |
| `last_seen_at` | `timestamptz` | aktualizace při seedu |

API vrací jen `WHERE is_active = true`.

### `price_history`

| Sloupec | Typ |
|---------|-----|
| `id` | `bigserial` PK |
| `product_id` | `text` (odkaz na `products.id`, produkt se nemaže) |
| `old_price`, `new_price`, `old_price_vat`, `new_price_vat` | `numeric(12,2)` |
| `recorded_at` | `timestamptz` |
| `supplier`, `name` | nullable |

Index: `(product_id, recorded_at DESC)`.

## Indexy

- `pg_trgm` + GIN na `products.name` (vyhledávání)
- složený index na `price_history`
- běžné indexy na `type_slug`, `supplier`, `is_active`

## Související (mimo DB)

`scripts/category-map.json` — skupiny kittingu (`groups`) a metadata accessories (`relatedGroup`, `parentSlug`).
