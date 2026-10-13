/**
 * AI assistant „Kapitán Karel“: POST /acc-db/api/chat → local Ollama (`/api/chat`, NDJSON).
 * Streamed to the browser as NDJSON `{message:{content}}` lines.
 * Runs behind the auth gate (only logged-in Manager users with an allowed role).
 *
 * Env:
 *   OLLAMA_URL      default http://ollama:11434
 *   OLLAMA_MODEL    default qwen2.5:3b
 *   OLLAMA_TIMEOUT_MS  max. duration of one answer, default 150000
 *   OLLAMA_NUM_CTX  optional context window in tokens
 *   OLLAMA_WARMUP=off  disable pre-evaluating the system prompt at server start
 *   OLLAMA_KEEP_ALIVE  optional per-request keep_alive
 *   OLLAMA_NUM_THREAD  optional CPU threads for generation
 *   OLLAMA_TOOLS    tools offered to the model: "all" | "off" | comma separated tool names
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createChatTools, TOOL_DEFS, TOOL_STATUS, ALL_TOOLS, type CatalogData, type ToolDef, type ToolEvent } from './chat-tools.ts'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

const MAX_MESSAGES = 20
const MAX_CONTENT = 4000
const MAX_TOTAL_CHARS = 8000
const MAX_BODY_BYTES = 256 * 1024
const FIRST_BYTE_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 3_000

export const MSG_UNAVAILABLE = 'Kapitán Karel zatím není dostupný (Ollama na serveru neběží).'

export const SYSTEM_PROMPT = [
  'Jsi interní asistent v naší webové aplikaci. Pomáhej uživatelům s orientací v systému a odpovídej stručně česky.',
  'Jsi Kapitán Karel (maskot: pirátský robot), AI asistent aplikace „Katalog příslušenství“ firmy Contsystem (nástavby na nákladní vozidla). Když se zeptají, kdo jsi, představ se. Nehraj piráta. Uživateli vždy vykej – piš „můžete, klikněte, najdete, Vaše nabídka“, nikdy „můžeš, klikni, najdeš, tvoje“.',
  '',
  'Aplikace: příslušenství k nákladním vozidlům od dodavatelů ALSAP (červený štítek), Trans-Technik (modrý), Hydrotruck (zelený) a Pavlínek (oranžový); orientační ceny bez DPH a s DPH (21 %).',
  '- Hlavička: hledání „Hledat v katalogu…“ (název, rozměr, kód), tlačítko „Cenová nabídka“ s odznakem ceny bez DPH. Filtr dodavatelů = klikací badge (více najednou), řazení podle ceny ↑/↓.',
  '- Levé menu kategorií (na mobilu pruh nahoře): „Vše“ = celý katalog; Podvozek: Blatníky, Zástěrky do blatníků, Držáky blatníků, Boční zábrany, Box na nářadí, Držáky boxů, Držák rezervy, Hasicí přístroj / bedna, Držáky hasicích beden, Maják, Nádoba na vodu, Držáky kanystrů, Uživatelská zásuvka; Všechny nástavby: Čerpadlo, Hydraulický olej, Kamery, Olejová nádrž, Pracovní světla; Hákový nosič kontejneru: Navařovací oko; Ostatní: Boxy / klece na podkládací desky, Podložky pod podpěry, Vázací prostředky. Dole „Aktualizovat katalog“ (stáhne nové ceny, trvá několik minut).',
  '- Produkty jsou seřazené podle ceny, nad nimi „Související příslušenství“. Karta produktu: dodavatel, kód, název, rozměry, cena s/bez DPH, „Historie cen“, „Detail ↗“ (web dodavatele), „Přidat do nabídky“ nebo počítadlo − +.',
  '- Cenová nabídka (#/nabidka): položky podle dodavatelů, množství, odhad dopravy, součty bez i s DPH, „Poznámka k nabídce“, „Kopírovat“, „CSV“, „Tisk / PDF“, „Vymazat nabídku“, „← Zpět do katalogu“ (Esc). Ukládá se v prohlížeči.',
  '',
  'Pravidla:',
  '- Produkty, ceny, kódy a rozměry vždy zjisti nástrojem hledat_produkty nebo detail_produktu; nic si nevymýšlej. Cena ve filtru je bez DPH. Obsah nabídky zjistíš nástrojem stav_nabidky.',
  '- Akce v aplikaci (kategorie, filtr, hledání, zobrazení produktu, změny nabídky) dělej nástroji jen na žádost uživatele; id produktu ber jen z výsledků nástrojů. Pak stručně potvrď, co jsi udělal. Chybu nebo prázdný výsledek přiznej.',
  '- „Aktuální obrazovka uživatele“ u dotazu = co uživatel právě vidí.',
  '- Odkazy jako tlačítka: [[produkt:ID|Zobrazit]], [[pridat:ID|Přidat do nabídky]], [[kategorie:SLUG|Název]], [[nabidka|Otevřít nabídku]], [[hledat|text hledání]], [[dodavatel:alsap|Jen ALSAP]] (alsap, trans-technik, hydrotruck, vsichni); ID a SLUG (kategorie_slug) ber jen z výsledků nástrojů. Na konec odpovědi dej 1–2 nejužitečnější tlačítka (další krok).',
  '- Odpovídej krátce prostým textem bez Markdownu (žádné tabulky, nadpisy ani hvězdičky; seznam s pomlčkou). Vždy vykej.',
].join('\n')

export const SYSTEM_PROMPT_BASIC = [
  SYSTEM_PROMPT.slice(0, SYSTEM_PROMPT.indexOf('\nPravidla:')),
  'Pravidla: Nemáš přístup k databázi produktů. U dotazu můžeš dostat „Aktuální obrazovka uživatele“ (co uživatel právě vidí: stránka, kategorie, filtr, produkty, nabídka se součty); o produktech, cenách a nabídce mluv jen podle ní. Nic si nevymýšlej; co nevíš, přiznej a poraď, kde to v katalogu najde. Odpovídej krátce prostým textem bez Markdownu (žádné tabulky, nadpisy ani hvězdičky; seznam s pomlčkou). Vždy vykej.',
].join('\n')

export const SYSTEM_PROMPT_LOCAL = [
  'Jsi Kapitán Karel, asistent aplikace „Katalog příslušenství“ firmy Contsystem (příslušenství k nástavbám nákladních vozidel od dodavatelů ALSAP, Trans-Technik, Hydrotruck a Pavlínek). Odpovídej česky, krátce (1–3 věty), prostým textem bez Markdownu. Uživateli vždy vykej („můžete, klikněte, Vaše“).',
  'Orientace v aplikaci:',
  '- Vlevo menu kategorií („Vše“ = celý katalog), nahoře „Hledat v katalogu…“. Filtr dodavatelů = badge (více najednou), řazení ceny ↑/↓.',
  '- Karta produktu: cena bez DPH a s DPH, „Přidat do nabídky“ (pak − +), „Historie cen“, „Detail ↗“ = web dodavatele.',
  '- Tlačítko „Cenová nabídka“ vpravo nahoře: položky, množství, odhad dopravy, součty, Poznámka, Kopírovat, CSV, Tisk / PDF, Vymazat nabídku. Nabídka se ukládá pro Vašeho uživatele.',
  'Produkty ani ceny si nevymýšlej – poraď, ať se zeptá konkrétně (např. „Najdi blatníky do 500 Kč“), pak je dohledáte v katalogu. Tlačítka (pište je přímo do odpovědi): [[nabidka|Otevřít nabídku]], [[hledat|blatníky]] (spustí hledání s tímto textem), [[dodavatel:alsap|Jen ALSAP]] (alsap, trans-technik, hydrotruck, vsichni). Produkty a kategorie jako tlačítko jen z ověřených faktů.',
  'Pravidla odpovědi: odpověz přímo na otázku jako první větou; nabídni jeden konkrétní další krok; když něco nevíš, řekni to. Z poskytnutých faktů nic neměň (ceny, kódy, odkazy).',
].join('\n')

export function whereAmI(json: string | null): string | null {
  if (!json) return null
  try {
    const c = JSON.parse(json) as Record<string, unknown>
    const parts = [String(c['Stránka'] || '')]
    if (c['Kategorie']) parts.push(`kategorie ${String(c['Kategorie']).replace(/ \(skupina.*\)$/, '')}`)
    if (c['Hledaný text']) parts.push(`hledá „${String(c['Hledaný text'])}“`)
    if (c['Filtr dodavatele'] && c['Filtr dodavatele'] !== 'všichni') parts.push(`filtr ${String(c['Filtr dodavatele'])}`)
    const open = c['Otevřený detail produktu (Historie cen)']
    if (open) parts.push(`otevřený produkt ${String(open).split(/,| · /)[0].slice(0, 80)}`)
    const line = parts.filter(Boolean).join(', ')
    return line ? `Uživatel je teď na: ${line}.` : null
  } catch {
    return null
  }
}

const CONTEXT_MAX_BYTES = 8 * 1024
const CONTEXT_MAX_DEPTH = 5

function cleanContext(v: unknown, depth = 0): unknown {
  if (depth > CONTEXT_MAX_DEPTH) throw new HttpError(400, 'Kontext obrazovky je příliš zanořený.')
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v.slice(0, 300)
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => cleanContext(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[k.slice(0, 60)] = cleanContext(x, depth + 1)
    return out
  }
  return null
}

export function validateContext(body: unknown): string | null {
  const ctx = (body as { context?: unknown } | null)?.context
  if (ctx === undefined || ctx === null) return null
  if (typeof ctx !== 'object' || Array.isArray(ctx)) throw new HttpError(400, 'Neplatný kontext obrazovky.')
  const json = JSON.stringify(cleanContext(ctx))
  if (Buffer.byteLength(json) > CONTEXT_MAX_BYTES) throw new HttpError(400, 'Kontext obrazovky je příliš velký (max. 8 kB).')
  return json === '{}' ? null : json
}

export function renderContext(v: unknown, indent = ''): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => (x !== null && typeof x === 'object' ? `${indent}-\n${renderContext(x, indent + '  ')}` : `${indent}- ${String(x)}`))
      .join('\n')
  }
  if (v !== null && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => (x !== null && typeof x === 'object' ? `${indent}${k}:\n${renderContext(x, indent + '  ')}` : `${indent}${k}: ${String(x)}`))
      .join('\n')
  }
  return `${indent}${String(v)}`
}

export function withContext(json: string, question: string): string {
  return [
    'Aktuální obrazovka uživatele (údaje z aplikace v okamžiku dotazu):',
    renderContext(JSON.parse(json)),
    '(O produktech, cenách a nabídce odpovídej jen podle těchto údajů nebo výsledků nástrojů, ceny opisuj přesně a uveď, zda jsou bez DPH, nebo s DPH.)',
    '',
    `Dotaz: ${question}`,
  ].join('\n')
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer | string) => {
      if (tooLarge) return
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (size > limit) {
        tooLarge = true
        return
      }
      chunks.push(b)
    })
    req.on('end', () => (tooLarge ? reject(new HttpError(413, 'Zpráva je příliš dlouhá.')) : resolve(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

const PROMPT_HISTORY = 6
const ASSISTANT_CLIP = 500

const TOOL_INTENT = /najd|naj[ií]t|hled|vyhled|p[řr][ií]d|odeb|odstra|sma[žz]|zm[ěe]n|uprav|otev[řr]|uka[žz]|zobraz|filtr|kategor|cen[auyěo]?\b|cenov|kolik|stoj[ií]|levn|drah|nab[ií]d|produkt|zbo[žz]|polo[žz]k|katalog|dodavatel|alsap|hydrotruck|trans.?technik|blatn|z[áa]bran|z[áa]st[ěe]r|box|maj[áa]k|dr[žz][áa]k|rezerv|hasic|[čc]erpad|kamer|sv[ěe]tl|n[áa]dob|kanystr|olej|n[áa]dr[žz]|z[áa]suv|nosi[čc]|dopra|doru[čc]|mno[žz]stv|kus|\bks\b|k[čc]\b|\d/i
const SCREEN_REF = /nab[ií]d|ko[šs][ií]k|\btady\b|\bzde\b|\bto(hle|to)\b|\bten(to|hle)\b|\bta(to|hle)\b|\btu(to|hle)\b|otev[řr]en|obrazovc|vybran|kolik m[áa]m|celkem|tento produkt|str[áa]nk|vid[íi]m/i

export function wantsTools(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1].content
  if (TOOL_INTENT.test(last)) return true
  const prev = messages[messages.length - 2]
  return !!prev && prev.role === 'assistant' && last.trim().length <= 40 && /\?\s*$/.test(prev.content.trim())
}

export function validateMessages(body: unknown): ChatMessage[] {
  const list = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Chybí zprávy konverzace.')
  if (list.length > 200) throw new HttpError(400, 'Konverzace je příliš dlouhá.')
  const out: ChatMessage[] = []
  for (const m of list) {
    const role = (m as { role?: unknown })?.role
    const content = (m as { content?: unknown })?.content
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      throw new HttpError(400, 'Neplatný formát zprávy.')
    }
    if (content.length > MAX_CONTENT) throw new HttpError(400, `Zpráva je příliš dlouhá (max. ${MAX_CONTENT} znaků).`)
    out.push({ role, content })
  }
  const last = out[out.length - 1]
  if (last.role !== 'user' || !last.content.trim()) throw new HttpError(400, 'Napište prosím dotaz.')
  let msgs = out.slice(-MAX_MESSAGES)
  let total = msgs.reduce((a, m) => a + m.content.length, 0)
  while (msgs.length > 1 && total > MAX_TOTAL_CHARS) {
    total -= msgs[0].content.length
    msgs = msgs.slice(1)
  }
  while (msgs.length > 1 && msgs[0].role !== 'user') msgs = msgs.slice(1)
  return msgs
}

export function validateQuote(body: unknown): Map<string, number> {
  const q = (body as { quote?: unknown } | null)?.quote
  const out = new Map<string, number>()
  if (q === undefined || q === null) return out
  if (!Array.isArray(q) || q.length > 300) throw new HttpError(400, 'Neplatný obsah nabídky.')
  for (const it of q) {
    const id = (it as { id?: unknown })?.id
    const qty = Math.floor(Number((it as { qty?: unknown })?.qty))
    if (typeof id !== 'string' || !id || id.length > 64 || !Number.isFinite(qty)) throw new HttpError(400, 'Neplatná položka nabídky.')
    if (qty > 0) out.set(id, Math.min(qty, 9999))
  }
  return out
}

const OLLAMA_DEFAULT_TOOLS = ['hledat_produkty', 'detail_produktu', 'pridat_do_nabidky', 'otevrit_detail_produktu']

function toolSet(spec: string | undefined, def: string[]): ToolDef[] {
  const s = (spec || '').trim().toLowerCase()
  if (s === 'off' || s === 'none' || s === '0') return []
  const names = s === 'all' ? ALL_TOOLS : s && s !== 'on' ? s.split(',').map((x) => x.trim()) : def
  return TOOL_DEFS.filter((t) => names.includes(t.function.name))
}

const errText = (err: unknown) => (err instanceof Error ? (err.cause as Error)?.message || err.message : String(err))

class UpstreamError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type ToolCall = { id: string; name: string; args: Record<string, unknown>; rawArgs: string; bad: boolean }
type Round = { text: string; calls: ToolCall[] }
type Msg = Record<string, unknown>

function parseArgs(raw: unknown): { args: Record<string, unknown>; rawArgs: string; bad: boolean } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, unknown>, rawArgs: JSON.stringify(raw), bad: false }
  const s = typeof raw === 'string' ? raw : ''
  if (!s.trim()) return { args: {}, rawArgs: '{}', bad: false }
  try {
    const v = JSON.parse(s)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v, rawArgs: s, bad: false }
  } catch {
    /* fallthrough */
  }
  return { args: {}, rawArgs: '{}', bad: true }
}

async function* lines(body: ReadableStream<Uint8Array>, onChunk: () => void) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk()
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() || ''
    for (const p of parts) yield p
  }
  buf += dec.decode()
  if (buf) yield buf
}

function clientProduct(p: ToolEvent['product']) {
  if (!p) return undefined
  const { id, name, typeSlug, supplier, price, priceVat, unit, dimensions, imageUrl, productUrl, sku, note } = p
  return { id, name, typeSlug, supplier, price, priceVat, unit, dimensions, imageUrl, productUrl, sku, note }
}

export function createChatHandler(env: Record<string, string | undefined>, data?: CatalogData) {
  const baseUrl = (env.OLLAMA_URL || 'http://ollama:11434').trim().replace(/\/+$/, '')
  const model = (env.OLLAMA_MODEL || 'qwen2.5:3b').trim()
  const totalTimeout = Math.max(5_000, Number(env.OLLAMA_TIMEOUT_MS) || 300_000)
  const numCtx = Number(env.OLLAMA_NUM_CTX) > 0 ? Math.max(2048, Math.min(32768, Number(env.OLLAMA_NUM_CTX))) : null
  const numThread = Number(env.OLLAMA_NUM_THREAD) > 0 ? Math.min(64, Math.floor(Number(env.OLLAMA_NUM_THREAD))) : null
  const options = numCtx || numThread ? { ...(numCtx ? { num_ctx: numCtx } : {}), ...(numThread ? { num_thread: numThread } : {}) } : undefined
  const keepAlive = (env.OLLAMA_KEEP_ALIVE || '').trim()
  const keep = keepAlive ? { keep_alive: /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive } : {}
  const ollamaId = `ollama:${model}`

  const tools = createChatTools(data)
  const ollamaTools = tools.available ? toolSet(env.OLLAMA_TOOLS || 'off', OLLAMA_DEFAULT_TOOLS) : []

  async function ollamaAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
      if (!r.ok) return false
      const body = (await r.json()) as { models?: { name?: string; model?: string }[] }
      const names = (body.models || []).map((m) => m.name || m.model || '')
      return names.includes(model) || names.includes(model.includes(':') ? model : `${model}:latest`)
    } catch {
      return false
    }
  }

  async function linkRefs(text: string): Promise<{ products: Record<string, unknown>; categories: string[] } | null> {
    const found = [...text.matchAll(/\[\[(produkt|pridat|kategorie):([A-Za-z0-9_-]{1,64})\|/g)]
    if (!found.length || !tools.available) return null
    try {
      const { byId, accessories } = await tools.catalog()
      const products: Record<string, unknown> = {}
      const categories: string[] = []
      for (const [, kind, id] of found) {
        if (kind === 'kategorie') {
          if ((id === 'vse' || accessories.some((a) => a.slug === id)) && !categories.includes(id)) categories.push(id)
        } else if (byId.has(id)) products[id] = clientProduct(byId.get(id))
      }
      return Object.keys(products).length || categories.length ? { products, categories } : null
    } catch {
      return null
    }
  }

  function promptMessages(all: ChatMessage[], context: string | null, system: string, where: string | null = null): Msg[] {
    let messages = all.slice(-PROMPT_HISTORY)
    while (messages.length > 1 && messages[0].role !== 'user') messages = messages.slice(1)
    messages = messages.map((m, i) => (m.role === 'assistant' && i < messages.length - 1 && m.content.length > ASSISTANT_CLIP ? { ...m, content: `${m.content.slice(0, ASSISTANT_CLIP)}…` } : m))
    const last = messages[messages.length - 1].content
    return [
      { role: 'system', content: system },
      ...messages.slice(0, -1),
      { role: 'user', content: context ? withContext(context, last) : where ? `${where}\n\nDotaz: ${last}` : last },
    ]
  }

  async function ollamaRound(msgs: Msg[], toolDefs: ToolDef[], signal: AbortSignal, onText: (t: string) => void, onFirst: () => void): Promise<Round> {
    let r: Response
    try {
      r = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true, ...keep, ...(options ? { options } : {}), messages: msgs, ...(toolDefs.length ? { tools: toolDefs } : {}) }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw err
      console.warn('[acc-db chat] Ollama unreachable:', errText(err))
      throw new UpstreamError(503, MSG_UNAVAILABLE)
    }
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '')
      console.warn(`[acc-db chat] Ollama HTTP ${r.status}: ${text.slice(0, 200)}`)
      if (r.status === 404) throw new UpstreamError(503, `Kapitán Karel zatím není dostupný (model ${model} na serveru chybí).`)
      if (r.status === 400 && /tools/i.test(text)) throw new UpstreamError(422, 'tool_use_failed')
      throw new UpstreamError(502, 'Kapitán Karel narazil na chybu. Zkuste to prosím znovu.')
    }
    let text = ''
    const calls: ToolCall[] = []
    for await (const raw of lines(r.body, onFirst)) {
      if (!raw.trim()) continue
      let o: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }; error?: string; done?: boolean }
      try {
        o = JSON.parse(raw)
      } catch {
        continue
      }
      if (o.error) {
        console.warn('[acc-db chat] Ollama stream error:', o.error)
        throw new UpstreamError(502, 'Kapitán Karel narazil na chybu. Zkuste to prosím znovu.')
      }
      const c = o.message?.content
      if (c) {
        text += c
        onText(c)
      }
      for (const tc of o.message?.tool_calls || []) {
        if (tc.function?.name) calls.push({ id: tc.id || `call_${calls.length}`, name: tc.function.name, ...parseArgs(tc.function.arguments) })
      }
      if (o.done) break
    }
    return { text, calls }
  }

  async function status(_req: IncomingMessage, res: ServerResponse) {
    const ollamaOk = await ollamaAvailable()
    const models = [
      {
        id: ollamaId,
        label: `Lokální – ${model}`,
        provider: 'ollama' as const,
        model,
        available: ollamaOk,
        tools: ollamaTools.length > 0,
        limits: null,
        description: `na našem serveru, bez limitu${ollamaTools.length ? '' : ', bez nástrojů'}`,
      },
    ]
    sendJson(res, 200, {
      models,
      default: ollamaId,
      available: ollamaOk,
      now: Date.now(),
      helpers: [],
      model,
      error: ollamaOk ? null : MSG_UNAVAILABLE,
    })
  }

  async function chat(req: IncomingMessage, res: ServerResponse) {
    let messages: ChatMessage[]
    let context: string | null
    let quote: Map<string, number>
    try {
      const raw = await readBody(req, MAX_BODY_BYTES)
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        throw new HttpError(400, 'Neplatný požadavek (očekáván JSON).')
      }
      messages = validateMessages(body)
      context = validateContext(body)
      quote = validateQuote(body)
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      throw err
    }

    const wants = wantsTools(messages)
    const toolDefs = wants ? ollamaTools : []
    const sendContext = toolDefs.length > 0 || SCREEN_REF.test(messages[messages.length - 1].content)
    const system = toolDefs.length ? SYSTEM_PROMPT : ollamaTools.length ? SYSTEM_PROMPT_BASIC : SYSTEM_PROMPT_LOCAL
    let convo = promptMessages(messages, sendContext ? context : null, system)
    const maxRounds = 5

    const ctrl = new AbortController()
    let timedOut = false
    const total = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, totalTimeout)
    const onClose = () => {
      if (!res.writableEnded) ctrl.abort()
    }
    res.on('close', onClose)

    const startStream = () => {
      if (res.headersSent) return
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-store, no-transform')
      res.setHeader('X-Accel-Buffering', 'no')
      if (req.httpVersionMajor < 2) res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Chat-Model', ollamaId)
      res.socket?.setNoDelay(true)
      res.flushHeaders()
    }
    const line = (o: unknown) => {
      startStream()
      if (!res.destroyed) res.write(JSON.stringify(o) + '\n')
    }

    let fullText = ''
    let anyText = false
    let actions = 0
    const done = new Set<string>()
    const onText = (t: string) => {
      anyText = true
      fullText += t
      line({ message: { role: 'assistant', content: t }, done: false })
    }

    const early = setTimeout(() => !res.headersSent && line({ type: 'status', text: 'Čtu dotaz…' }), 1200)

    try {
      let defs = toolDefs
      for (let i = 0; i < maxRounds; i++) {
        const last = i === maxRounds - 1
        const rc = new AbortController()
        const abort = () => rc.abort()
        ctrl.signal.addEventListener('abort', abort)
        let first: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          timedOut = true
          rc.abort()
        }, FIRST_BYTE_TIMEOUT_MS)
        const onFirst = () => {
          if (first) clearTimeout(first)
          first = undefined
        }

        let r: Round
        try {
          r = await ollamaRound(convo, last ? [] : defs, rc.signal, onText, onFirst)
        } finally {
          onFirst()
          ctrl.signal.removeEventListener('abort', abort)
        }

        if (!r.calls.length || !defs.length) break
        convo = [
          ...convo,
          { role: 'assistant', content: r.text, tool_calls: r.calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) },
        ]
        for (const c of r.calls) {
          line({ type: 'status', text: TOOL_STATUS[c.name] || 'Pracuji…' })
          const key = `${c.name}:${JSON.stringify(c.args)}`
          let result: Record<string, unknown>
          if (c.bad) result = { chyba: 'Neplatné argumenty (očekáván JSON objekt).' }
          else if (!defs.some((d) => d.function.name === c.name)) result = { chyba: `Nástroj ${c.name} není k dispozici.` }
          else if (done.has(key) && !['hledat_produkty', 'detail_produktu', 'seznam_kategorii', 'stav_nabidky'].includes(c.name)) result = { provedeno: true, poznamka: 'Tato akce už byla provedena, neopakuj ji.' }
          else {
            done.add(key)
            try {
              result = await tools.run(c.name, c.args, quote, (e) => {
                actions++
                line({ ...e, product: clientProduct(e.product) })
              })
            } catch (err) {
              console.warn(`[acc-db chat] tool ${c.name} failed:`, errText(err))
              result = { chyba: 'Katalog je teď nedostupný.' }
            }
          }
          convo.push({ role: 'tool', content: JSON.stringify(result), tool_name: c.name })
        }
      }

      if (!anyText) onText(actions ? 'Hotovo.' : 'Promiňte, odpověď se nepodařilo dokončit. Zkuste to prosím znovu.')
      const refs = await linkRefs(fullText)
      if (refs) line({ type: 'refs', ...refs })
      line({ message: { role: 'assistant', content: '' }, done: true, model: ollamaId })
      if (!res.destroyed) res.end()
    } catch (err) {
      if (res.destroyed) return
      let status = 502
      let msg = 'Kapitán Karel narazil na chybu. Zkuste to prosím znovu.'
      if (err instanceof UpstreamError) {
        status = err.status === 422 ? 502 : err.status
        msg = err.message
      } else if (timedOut) {
        status = 504
        msg = 'Kapitán Karel neodpověděl včas. Zkuste to prosím znovu.'
      } else {
        msg = 'Spojení s Kapitánem Karlem bylo přerušeno.'
      }
      if (!res.headersSent) {
        return sendJson(res, status, { error: msg })
      }
      line({ error: msg, done: true })
      res.end()
    } finally {
      clearTimeout(total)
      clearTimeout(early)
      res.off('close', onClose)
    }
  }

  function warmup() {
    if ((env.OLLAMA_WARMUP || '').toLowerCase() === 'off') return
    const t = setTimeout(async () => {
      const t0 = Date.now()
      try {
        const r = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            ...keep,
            options: { ...(options || {}), num_predict: 1 },
            messages: [
              { role: 'system', content: ollamaTools.length ? SYSTEM_PROMPT : SYSTEM_PROMPT_LOCAL },
              { role: 'user', content: 'Ahoj' },
            ],
            ...(ollamaTools.length ? { tools: ollamaTools } : {}),
          }),
          signal: AbortSignal.timeout(300_000),
        })
        await r.text()
        console.log(`[acc-db chat] warm-up ${r.ok ? 'done' : `HTTP ${r.status}`} in ${Date.now() - t0} ms`)
      } catch (err) {
        console.warn('[acc-db chat] warm-up skipped:', errText(err))
      }
    }, 3_000)
    t.unref?.()
  }

  return {
    chat,
    status,
    warmup,
    config: {
      baseUrl,
      model,
      numCtx,
      numThread,
      keepAlive,
      tools: { ollama: ollamaTools.map((t) => t.function.name) },
    },
  }
}
