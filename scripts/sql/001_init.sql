-- acc-db catalog schema
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS accessories (
  slug text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  unit text NOT NULL DEFAULT 'ks' CHECK (unit IN ('ks', 'L', 'm')),
  price_approx numeric(12, 2) NOT NULL DEFAULT 0,
  price_min numeric(12, 2),
  price_max numeric(12, 2),
  source text,
  source_url text,
  note text,
  sort_order integer NOT NULL DEFAULT 0,
  parent_slug text
);

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  name text NOT NULL,
  type_slug text NOT NULL,
  supplier text NOT NULL,
  price numeric(12, 2) NOT NULL DEFAULT 0,
  price_vat numeric(12, 2) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'ks' CHECK (unit IN ('ks', 'L', 'm')),
  dimensions text,
  image_url text,
  product_url text,
  sku text,
  note text,
  datasheet_url text,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_history (
  id bigserial PRIMARY KEY,
  product_id text NOT NULL,
  old_price numeric(12, 2) NOT NULL,
  new_price numeric(12, 2) NOT NULL,
  old_price_vat numeric(12, 2) NOT NULL,
  new_price_vat numeric(12, 2) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  supplier text,
  name text
);

CREATE INDEX IF NOT EXISTS products_type_slug_idx ON products (type_slug);
CREATE INDEX IF NOT EXISTS products_supplier_idx ON products (supplier);
CREATE INDEX IF NOT EXISTS products_is_active_idx ON products (is_active);
CREATE INDEX IF NOT EXISTS products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS price_history_product_recorded_idx ON price_history (product_id, recorded_at DESC);
