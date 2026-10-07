/**
 * Tools for Kapitán Karel (function calling, OpenAI-style JSON schema — used for GroqCloud and Ollama).
 *
 *  - read tools run here on the server against the acc-db catalogue (Appwrite, read-only, cached 60 s);
 *  - action tools change the user's screen / quote in the BROWSER: the server validates the arguments
 *    (product exists, item is in the quote, …), emits an `action` event into the stream and tells the model
 *    it was done. The browser applies it to its own state (quote lives in localStorage) and shows a chip with undo.
 * No tool writes to Appwrite and there is deliberately no „clear the whole quote“ tool.
 */
import { estimateShippingBySupplier } from '../shipping.ts'

export type ToolProduct = {
  id: string
  name: string
  typeSlug: string
  supplier: string
  price: number
  priceVat: number
  unit: string
  dimensions: string | null
  imageUrl: string | null
  productUrl: string | null
  sku: string | null
  note: string | null
}
export type ToolAccessory = { slug: string; name: string; category: string; sortOrder: number; parentSlug: string | null; relatedGroup?: string | null }
export type CatalogData = {
  loadCatalog(): Promise<{ accessories: ToolAccessory[]; products: ToolProduct[] }>
  categoryMap(): { groups: { id: string; label: string; slugs: string[] }[]; accessories: { slug: string; relatedGroup: string | null; parentSlug: string | null }[] }
  priceHistory(productId: string): Promise<{ recordedAt: string; oldPrice: number; newPrice: number; oldPriceVat: number; newPriceVat: number }[]>
}

export type ToolEvent = { type: 'action'; name: string; args: Record<string, unknown>; label: string; product?: ToolProduct; prevQty?: number }
export type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

const SUPPLIERS = ['ALSAP', 'Trans-Technik', 'Hydrotruck'] as const
const CATEGORY_ORDER = ['Podvozek', 'Všechny nástavby', 'Hákový nosič kontejneru', 'Ostatní']

export const READ_TOOLS = ['hledat_produkty', 'detail_produktu', 'seznam_kategorii', 'stav_nabidky'] as const
export const ACTION_TOOLS = [
  'otevrit_kategorii',
  'nastavit_filtr_dodavatele',
  'hledat_v_katalogu',
  'otevrit_detail_produktu',
  'pridat_do_nabidky',
  'zmenit_mnozstvi_v_nabidce',
  'odebrat_z_nabidky',
  'otevrit_nabidku',
] as const
export const ALL_TOOLS: string[] = [...READ_TOOLS, ...ACTION_TOOLS]

const idParam = { type: 'string', description: 'id z výsledku nástroje' }

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'hledat_produkty',
      description: 'Hledá produkty v katalogu. Ceny ve filtru: Kč za kus bez DPH.',
      parameters: {
        type: 'object',
        properties: {
          dotaz: { type: 'string', description: 'slova z názvu, kód nebo rozměr' },
          dodavatel: { type: 'string', enum: [...SUPPLIERS] },
          kategorie: { type: 'string' },
          cena_min: { type: 'number' },
          cena_max: { type: 'number' },
          razeni: { type: 'string', enum: ['cena_vzestupne', 'cena_sestupne'] },
          limit: { type: 'integer', minimum: 1, maximum: 8 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detail_produktu',
      description: 'Detail produktu vč. související kategorie a historie cen.',
      parameters: { type: 'object', properties: { id: idParam }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: { name: 'seznam_kategorii', description: 'Kategorie s počty produktů podle dodavatele.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: { name: 'stav_nabidky', description: 'Obsah cenové nabídky (položky s id, množství, součty).', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'otevrit_kategorii',
      description: 'Otevře kategorii (nebo Vše).',
      parameters: { type: 'object', properties: { kategorie: { type: 'string' } }, required: ['kategorie'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nastavit_filtr_dodavatele',
      description: 'Nastaví filtr dodavatele (vsichni = zrušit).',
      parameters: { type: 'object', properties: { dodavatel: { type: 'string', enum: [...SUPPLIERS, 'vsichni'] } }, required: ['dodavatel'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hledat_v_katalogu',
      description: 'Vyhledá text ve vyhledávání aplikace.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'otevrit_detail_produktu',
      description: 'Ukáže produkt v katalogu (karta + historie cen).',
      parameters: { type: 'object', properties: { id: idParam }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pridat_do_nabidky',
      description: 'Přidá produkt do nabídky (přičte k množství).',
      parameters: { type: 'object', properties: { id: idParam, mnozstvi: { type: 'integer', minimum: 1, maximum: 999 } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'zmenit_mnozstvi_v_nabidce',
      description: 'Nastaví množství položky v nabídce.',
      parameters: { type: 'object', properties: { id: idParam, mnozstvi: { type: 'integer', minimum: 1, maximum: 9999 } }, required: ['id', 'mnozstvi'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'odebrat_z_nabidky',
      description: 'Odebere položku z nabídky.',
      parameters: { type: 'object', properties: { id: idParam }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: { name: 'otevrit_nabidku', description: 'Otevře stránku Cenová nabídka.', parameters: { type: 'object', properties: {} } },
  },
]

export const TOOL_STATUS: Record<string, string> = {
  hledat_produkty: 'Hledám v katalogu…',
  detail_produktu: 'Načítám detail produktu…',
  seznam_kategorii: 'Procházím kategorie…',
  stav_nabidky: 'Kontroluji nabídku…',
  otevrit_kategorii: 'Otevírám kategorii…',
  nastavit_filtr_dodavatele: 'Nastavuji filtr dodavatele…',
  hledat_v_katalogu: 'Vyhledávám v aplikaci…',
  otevrit_detail_produktu: 'Otevírám produkt…',
  pridat_do_nabidky: 'Přidávám do nabídky…',
  zmenit_mnozstvi_v_nabidce: 'Měním množství…',
  odebrat_z_nabidky: 'Odebírám z nabídky…',
  otevrit_nabidku: 'Otevírám nabídku…',
}

const czk = (n: number) => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
export const norm = (s: string) =>
  s
    .toLocaleLowerCase('cs')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.,/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
/** crude Czech stemming: compare the first chars so „blatníky“ finds „Blatník“, „desky“ finds „deska“ */
const stem = (t: string) => (t.length <= 4 ? t : t.slice(0, Math.max(4, t.length - 2)))

function supplierFrom(v: unknown): (typeof SUPPLIERS)[number] | null {
  const s = norm(String(v ?? ''))
  if (!s) return null
  if (s.includes('alsap')) return 'ALSAP'
  if (s.includes('trans') || s === 'tt') return 'Trans-Technik'
  if (s.includes('hydro')) return 'Hydrotruck'
  return null
}

const intIn = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

export function createChatTools(data: CatalogData | undefined) {
  let cache: { at: number; accessories: ToolAccessory[]; products: ToolProduct[]; byId: Map<string, ToolProduct> } | null = null
  async function catalog() {
    if (!data) throw new Error('katalog není k dispozici')
    if (cache && Date.now() - cache.at < 60_000) return cache
    const { accessories, products } = await data.loadCatalog()
    cache = { at: Date.now(), accessories, products, byId: new Map(products.map((p) => [p.id, p])) }
    return cache
  }

  const catName = (accessories: ToolAccessory[], slug: string) => accessories.find((a) => a.slug === slug)?.name || slug

  function resolveCategory(accessories: ToolAccessory[], q: unknown): { acc: ToolAccessory | null; all: boolean; others: string[] } {
    const s = norm(String(q ?? ''))
    if (!s) return { acc: null, all: false, others: [] }
    if (['vse', 'vsechno', 'cely katalog', 'vse (cely katalog)'].includes(s)) return { acc: null, all: true, others: [] }
    const exact = accessories.find((a) => a.slug === s || norm(a.name) === s)
    if (exact) return { acc: exact, all: false, others: [] }
    const toks = s.split(' ').filter((t) => t.length > 1).map(stem)
    const scored = accessories
      .map((a) => {
        const hay = `${norm(a.name)} ${a.slug.replace(/-/g, ' ')}`
        const hits = toks.filter((t) => hay.includes(t)).length
        return { a, hits, len: a.name.length }
      })
      .filter((x) => x.hits > 0)
      .sort((x, y) => y.hits - x.hits || x.len - y.len || x.a.sortOrder - y.a.sortOrder)
    if (!scored.length || scored[0].hits < Math.ceil(toks.length / 2)) return { acc: null, all: false, others: [] }
    return { acc: scored[0].a, all: false, others: scored.slice(1, 4).map((x) => x.a.name) }
  }

  function productOut(p: ToolProduct, accessories: ToolAccessory[]) {
    return {
      id: p.id,
      nazev: p.name,
      ...(p.sku ? { kod: p.sku } : {}),
      dodavatel: p.supplier,
      kategorie: catName(accessories, p.typeSlug),
      cena_bez_dph: czk(p.price),
      cena_s_dph: czk(p.priceVat),
      ...(p.unit !== 'ks' ? { jednotka: p.unit } : {}),
      ...(p.dimensions ? { rozmery: p.dimensions } : {}),
    }
  }

  function search(products: ToolProduct[], accessories: ToolAccessory[], args: Record<string, unknown>) {
    let list = products
    const sup = supplierFrom(args.dodavatel)
    if (sup) list = list.filter((p) => p.supplier === sup)
    if (args.kategorie) {
      const { acc } = resolveCategory(accessories, args.kategorie)
      if (acc) {
        // only the category itself (Blatníky ≠ Držáky blatníků); a parent without own products → its sub-categories
        const own = list.filter((p) => p.typeSlug === acc.slug)
        list = own.length ? own : list.filter((p) => accessories.find((a) => a.slug === p.typeSlug)?.parentSlug === acc.slug)
      }
    }
    const min = Number(args.cena_min)
    const max = Number(args.cena_max)
    if (Number.isFinite(min) && min > 0) list = list.filter((p) => p.price >= min)
    if (Number.isFinite(max) && max > 0) list = list.filter((p) => p.price <= max)
    const toks = norm(String(args.dotaz ?? ''))
      .split(' ')
      .filter((t) => t.length > 1 && !['od', 'do', 'kc', 'pro', 'na', 'se', 'za', 'ks'].includes(t))
      .map(stem)
    if (toks.length) {
      const hay = (p: ToolProduct) => norm(`${p.name} ${p.sku || ''} ${p.dimensions || ''} ${catName(accessories, p.typeSlug)} ${p.typeSlug.replace(/-/g, ' ')} ${p.supplier}`)
      const scored = list.map((p) => {
        const h = hay(p)
        return { p, hits: toks.filter((t) => h.includes(t)).length }
      })
      const all = scored.filter((x) => x.hits === toks.length)
      list = (all.length ? all : scored.filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits)).map((x) => x.p)
    }
    // „blatník“ lists fenders before holders / spare parts that merely mention the word: products whose name
    // starts with the first word, or whose own category starts with it, come first (each group by price)
    const lead = toks[0]
    const primary = (p: ToolProduct) => (lead ? norm(p.name).startsWith(lead) || norm(catName(accessories, p.typeSlug)).startsWith(lead) : true)
    const desc = args.razeni === 'cena_sestupne'
    list = [...list].sort((a, b) => Number(primary(b)) - Number(primary(a)) || (desc ? b.price - a.price : a.price - b.price))
    return list
  }

  function quoteSummary(quote: Map<string, number>, byId: Map<string, ToolProduct>, accessories: ToolAccessory[]) {
    const lines = [...quote.entries()]
      .map(([id, qty]) => ({ p: byId.get(id), qty }))
      .filter((l): l is { p: ToolProduct; qty: number } => !!l.p && l.qty > 0)
    if (!lines.length) return { polozky: [], poznamka: 'Nabídka je prázdná.' }
    const ship = estimateShippingBySupplier(lines.map((l) => ({ supplier: l.p.supplier, typeSlug: l.p.typeSlug, exVat: l.p.price * l.qty, withVat: l.p.priceVat * l.qty })))
    const gEx = lines.reduce((a, l) => a + l.p.price * l.qty, 0)
    const gVat = lines.reduce((a, l) => a + l.p.priceVat * l.qty, 0)
    const sEx = ship.reduce((a, s) => a + s.shippingExVat, 0)
    const sVat = ship.reduce((a, s) => a + s.shippingVat, 0)
    return {
      polozky: lines.map((l) => ({
        id: l.p.id,
        nazev: l.p.name,
        dodavatel: l.p.supplier,
        kategorie: catName(accessories, l.p.typeSlug),
        mnozstvi: l.qty,
        jednotka: l.p.unit,
        cena_za_jednotku_bez_dph: czk(l.p.price),
        radek_bez_dph: czk(l.p.price * l.qty),
        radek_s_dph: czk(l.p.priceVat * l.qty),
      })),
      zbozi_celkem: `${czk(gEx)} bez DPH / ${czk(gVat)} s DPH`,
      doprava_odhad: `${czk(sEx)} bez DPH / ${czk(sVat)} s DPH`,
      celkem_vcetne_dopravy: `${czk(gEx + sEx)} bez DPH / ${czk(gVat + sVat)} s DPH`,
    }
  }

  /**
   * Executes one tool call. `quote` is this request's working copy of the user's quote (id → qty) — action
   * tools update it so later tool calls in the same answer see the change.
   */
  async function run(
    name: string,
    args: Record<string, unknown>,
    quote: Map<string, number>,
    emit: (e: ToolEvent) => void,
  ): Promise<Record<string, unknown>> {
    if (!ALL_TOOLS.includes(name)) return { chyba: `Neznámý nástroj ${name}.` }
    const { products, accessories, byId } = await catalog()
    const product = () => {
      const p = byId.get(String(args.id ?? '').trim())
      if (!p) throw new Error('Produkt s tímto id neexistuje. Nejdřív ho najdi nástrojem hledat_produkty.')
      return p
    }
    try {
      switch (name) {
        case 'hledat_produkty': {
          const limit = intIn(args.limit, 1, 8, 5)
          const list = search(products, accessories, args)
          return { celkem_nalezeno: list.length, zobrazeno: Math.min(limit, list.length), produkty: list.slice(0, limit).map((p) => productOut(p, accessories)) }
        }
        case 'detail_produktu': {
          const p = product()
          const cmap = data!.categoryMap()
          const meta = cmap.accessories.find((a) => a.slug === p.typeSlug)
          const acc = accessories.find((a) => a.slug === p.typeSlug)
          const related = new Set<string>()
          const g = cmap.groups.find((x) => x.id === (meta?.relatedGroup || acc?.relatedGroup))
          for (const s of g?.slugs || []) if (s !== p.typeSlug) related.add(catName(accessories, s))
          for (const a of accessories) if (a.slug !== p.typeSlug && ((acc?.parentSlug && a.parentSlug === acc.parentSlug) || a.parentSlug === p.typeSlug || a.slug === acc?.parentSlug)) related.add(a.name)
          let history: string[] | string = 'cena se zatím neměnila'
          try {
            const h = await data!.priceHistory(p.id)
            if (h.length) history = h.slice(0, 5).map((x) => `${x.recordedAt.slice(0, 10)}: ${czk(x.oldPrice)} → ${czk(x.newPrice)} bez DPH`)
          } catch {
            history = 'historie cen není dostupná'
          }
          return {
            ...productOut(p, accessories),
            skupina: acc?.category,
            souvisejici_kategorie: [...related].slice(0, 8),
            historie_cen: history,
            v_nabidce: quote.get(p.id) || 0,
            ...(p.productUrl ? { odkaz_dodavatele: 'ano (tlačítko Detail ↗ na kartě)' } : {}),
          }
        }
        case 'seznam_kategorii': {
          const counts = new Map<string, Record<string, number>>()
          for (const p of products) {
            const c = counts.get(p.typeSlug) || {}
            c[p.supplier] = (c[p.supplier] || 0) + 1
            counts.set(p.typeSlug, c)
          }
          const groups = CATEGORY_ORDER.map((cat) => ({
            skupina: cat,
            kategorie: accessories
              .filter((a) => a.category === cat)
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((a) => {
                const c = counts.get(a.slug) || {}
                const total = Object.values(c).reduce((x, y) => x + y, 0)
                return `${a.name}: ${total} (${Object.entries(c).map(([s, n]) => `${s} ${n}`).join(', ') || '—'})`
              }),
          })).filter((g) => g.kategorie.length)
          return { celkem_produktu: products.length, skupiny: groups }
        }
        case 'stav_nabidky':
          return quoteSummary(quote, byId, accessories)

        // ── actions (executed in the browser) ──
        case 'otevrit_kategorii': {
          const r = resolveCategory(accessories, args.kategorie)
          if (r.all) {
            emit({ type: 'action', name, args: { slug: 'vse' }, label: '📂 Otevřen celý katalog (Vše)' })
            return { provedeno: true, kategorie: 'Vše' }
          }
          if (!r.acc) return { chyba: 'Kategorie nenalezena. Použij seznam_kategorii.' }
          emit({ type: 'action', name, args: { slug: r.acc.slug }, label: `📂 Otevřena kategorie: ${r.acc.name}` })
          return { provedeno: true, kategorie: r.acc.name, ...(r.others.length ? { podobne_kategorie: r.others } : {}) }
        }
        case 'nastavit_filtr_dodavatele': {
          const all = norm(String(args.dodavatel ?? '')).startsWith('vsich')
          const sup = all ? '' : supplierFrom(args.dodavatel)
          if (sup === null) return { chyba: 'Neznámý dodavatel. Možnosti: ALSAP, Trans-Technik, Hydrotruck, vsichni.' }
          emit({ type: 'action', name, args: { dodavatel: sup }, label: sup ? `🏷️ Filtr dodavatele: ${sup}` : '🏷️ Filtr dodavatele zrušen' })
          return { provedeno: true, filtr: sup || 'všichni dodavatelé' }
        }
        case 'hledat_v_katalogu': {
          const text = String(args.text ?? '').trim().slice(0, 80)
          if (!text) return { chyba: 'Chybí text hledání.' }
          emit({ type: 'action', name, args: { text }, label: `🔎 Hledání v katalogu: „${text}“` })
          return { provedeno: true, pocet_vysledku: search(products, accessories, { dotaz: text }).length }
        }
        case 'otevrit_detail_produktu': {
          const p = product()
          emit({ type: 'action', name, args: { id: p.id }, label: `🔍 Zobrazen produkt: ${p.name.slice(0, 60)}`, product: p })
          return { provedeno: true, produkt: p.name }
        }
        case 'pridat_do_nabidky': {
          const p = product()
          const add = intIn(args.mnozstvi, 1, 999, 1)
          const prev = quote.get(p.id) || 0
          const next = Math.min(9999, prev + add)
          quote.set(p.id, next)
          emit({ type: 'action', name, args: { id: p.id, mnozstvi: next }, label: `➕ Přidáno do nabídky: ${p.name.slice(0, 50)} × ${add}`, product: p, prevQty: prev })
          return { provedeno: true, produkt: p.name, pridano: add, mnozstvi_v_nabidce: next, cena_radku_bez_dph: czk(p.price * next) }
        }
        case 'zmenit_mnozstvi_v_nabidce': {
          const p = product()
          const prev = quote.get(p.id) || 0
          if (!prev) return { chyba: 'Tento produkt v nabídce není. Pro přidání použij pridat_do_nabidky.' }
          const qty = intIn(args.mnozstvi, 1, 9999, prev)
          quote.set(p.id, qty)
          emit({ type: 'action', name, args: { id: p.id, mnozstvi: qty }, label: `✏️ Množství: ${p.name.slice(0, 50)} → ${qty} ${p.unit}`, product: p, prevQty: prev })
          return { provedeno: true, produkt: p.name, mnozstvi_v_nabidce: qty }
        }
        case 'odebrat_z_nabidky': {
          const p = product()
          const prev = quote.get(p.id) || 0
          if (!prev) return { chyba: 'Tento produkt v nabídce není.' }
          quote.delete(p.id)
          emit({ type: 'action', name, args: { id: p.id, mnozstvi: 0 }, label: `➖ Odebráno z nabídky: ${p.name.slice(0, 50)}`, product: p, prevQty: prev })
          return { provedeno: true, produkt: p.name }
        }
        case 'otevrit_nabidku':
          emit({ type: 'action', name, args: {}, label: '📄 Otevřena cenová nabídka' })
          return { provedeno: true }
      }
    } catch (err) {
      return { chyba: err instanceof Error ? err.message : String(err) }
    }
    return { chyba: 'Nástroj selhal.' }
  }

  return { run, catalog, available: !!data }
}
