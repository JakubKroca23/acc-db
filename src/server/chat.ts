/**
 * AI assistant „Kapitán Karel“: POST /acc-db/api/chat → local Ollama (`/api/chat`, NDJSON) or GroqCloud
 * (OpenAI-compatible `/chat/completions`, SSE). Both are streamed to the browser as NDJSON `{message:{content}}` lines.
 * Runs behind the auth gate (only logged-in Manager users with an allowed role).
 *
 * Env:
 *   OLLAMA_URL      default http://ollama:11434 (the `ollama` container on the shared docker network `ollama`)
 *   OLLAMA_MODEL    default qwen2.5:3b
 *   OLLAMA_TIMEOUT_MS  max. duration of one answer, default 150000
 *   OLLAMA_NUM_CTX  optional context window in tokens (default: Ollama's own; changing it reloads the model)
 *   OLLAMA_WARMUP=off  disable pre-evaluating the system prompt at server start
 *   OLLAMA_KEEP_ALIVE  optional per-request keep_alive (e.g. 30m, -1); default: Ollama's own setting
 *   OLLAMA_NUM_THREAD  optional CPU threads for generation (default: Ollama's choice = physical cores)
 *   GROQ_API_KEY    enables GroqCloud models (server-side only, never sent to the browser)
 *   GROQ_MODELS     optional comma separated Groq model ids = exact list + order (default: every chat-capable
 *                   model the key's /models returns, gpt-oss-120b first)
 *   GROQ_LIMITS     optional JSON {model: {rpm, rpd, tpm, tpd}} overriding the known plan limits
 *   GROQ_TIMEOUT_MS max. duration of one Groq answer incl. tool rounds, default 90000
 *   CHAT_STATE_FILE optional JSON file for the Groq rate-limit counters (survives restarts)
 *   GROQ_TOOLS / OLLAMA_TOOLS  tools offered to the model: "all" | "off" | comma separated tool names
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGroqLimits, type ModelLimits, type GroqLimits } from './groq-limits.ts'
import { createChatTools, TOOL_DEFS, TOOL_STATUS, ALL_TOOLS, type CatalogData, type ToolDef, type ToolEvent } from './chat-tools.ts'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

const MAX_MESSAGES = 20
const MAX_CONTENT = 4000
const MAX_TOTAL_CHARS = 8000 // conversation; prompt evaluation on the VPS CPU is only ~30 tokens/s
const MAX_BODY_BYTES = 256 * 1024
const FIRST_BYTE_TIMEOUT_MS = 90_000 // model (re)load + prompt evaluation on CPU
const STATUS_TIMEOUT_MS = 3_000

export const MSG_UNAVAILABLE = 'Kapitán Karel zatím není dostupný (Ollama na serveru neběží).'

/** Base = the user's own sentence; the rest describes the app so the model can guide users around it.
 *  Kept compact on purpose: Groq free tier allows only ~8K tokens/min and every tool round re-sends it. */
export const SYSTEM_PROMPT = [
  'Jsi interní asistent v naší webové aplikaci. Pomáhej uživatelům s orientací v systému a odpovídej stručně česky.',
  'Jsi Kapitán Karel (maskot: pirátský robot), AI asistent aplikace „Katalog příslušenství“ firmy Contsystem (nástavby na nákladní vozidla). Když se zeptají, kdo jsi, představ se. Nehraj piráta. Uživateli vždy vykej – piš „můžete, klikněte, najdete, Vaše nabídka“, nikdy „můžeš, klikni, najdeš, tvoje“.',
  '',
  'Aplikace: příslušenství k nákladním vozidlům od dodavatelů ALSAP (červený štítek), Trans-Technik (modrý) a Hydrotruck (zelený); orientační ceny bez DPH a s DPH (21 %).',
  '- Hlavička: filtr dodavatele, hledání „Hledat v katalogu…“ (název, rozměr, kód), tlačítko „Cenová nabídka“ s odznakem ceny bez DPH.',
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

/** Variant for a model without tools (the local model when OLLAMA_TOOLS=off): same app description, no tool rules. */
export const SYSTEM_PROMPT_BASIC = [
  SYSTEM_PROMPT.slice(0, SYSTEM_PROMPT.indexOf('\nPravidla:')),
  'Pravidla: Nemáš přístup k databázi produktů. U dotazu můžeš dostat „Aktuální obrazovka uživatele“ (co uživatel právě vidí: stránka, kategorie, filtr, produkty, nabídka se součty); o produktech, cenách a nabídce mluv jen podle ní. Nic si nevymýšlej; co nevíš, přiznej a poraď, kde to v katalogu najde. Odpovídej krátce prostým textem bez Markdownu (žádné tabulky, nadpisy ani hvězdičky; seznam s pomlčkou). Vždy vykej.',
].join('\n')

/** Local model (no tools): short and clear, navigation facts only — every token costs CPU time on the VPS. */
export const SYSTEM_PROMPT_LOCAL = [
  'Jsi Kapitán Karel, asistent aplikace „Katalog příslušenství“ firmy Contsystem (příslušenství k nástavbám nákladních vozidel od dodavatelů ALSAP, Trans-Technik a Hydrotruck). Odpovídej česky, krátce (1–3 věty), prostým textem bez Markdownu. Uživateli vždy vykej („můžete, klikněte, Vaše“).',
  'Orientace v aplikaci:',
  '- Vlevo menu kategorií („Vše“ = celý katalog), nahoře „Hledat v katalogu…“ (název, rozměr, kód) a filtr dodavatele.',
  '- Karta produktu: cena bez DPH a s DPH, „Přidat do nabídky“ (pak − +), „Historie cen“, „Detail ↗“ = web dodavatele.',
  '- Tlačítko „Cenová nabídka“ vpravo nahoře: položky, množství, odhad dopravy, součty, Poznámka, Kopírovat, CSV, Tisk / PDF, Vymazat nabídku. Nabídka se ukládá pro Vašeho uživatele.',
  'Produkty ani ceny si nevymýšlej – poraď, ať se zeptá konkrétně (např. „Najdi blatníky do 500 Kč“), pak je dohledáte v katalogu. Tlačítka (pište je přímo do odpovědi): [[nabidka|Otevřít nabídku]], [[hledat|blatníky]] (spustí hledání s tímto textem), [[dodavatel:alsap|Jen ALSAP]] (alsap, trans-technik, hydrotruck, vsichni). Produkty a kategorie jako tlačítko jen z ověřených faktů.',
  'Pravidla odpovědi: odpověz přímo na otázku jako první větou; nabídni jeden konkrétní další krok; když něco nevíš, řekni to. Z poskytnutých faktů nic neměň (ceny, kódy, odkazy).',
  'Příklad: „Kde najdu historii cen?“ → „Otevřete kartu produktu a klikněte na „Historie cen“. Chcete, abych nějaký produkt vyhledal?“',
  'Příklad: „Jak vytisknu nabídku?“ → „V Cenové nabídce klikněte na „Tisk / PDF“. [[nabidka|Otevřít nabídku]]“',
].join('\n')

/** Cloud helper doing the tool work for the local model: minimal prompt to save tokens. */
export const SYSTEM_PROMPT_DELEGATE = [
  'Jsi Kapitán Karel, asistent katalogu příslušenství pro nákladní vozidla (dodavatelé ALSAP, Trans-Technik, Hydrotruck). Uživateli vždy vykej.',
  '- Produkty a ceny zjisti nástroji, nic si nevymýšlej; akce v aplikaci dělej jen na žádost, id ber jen z výsledků nástrojů. Ceny uváděj s „bez DPH“ / „s DPH“.',
  '- Odkazy jako tlačítka: [[produkt:ID|Zobrazit]], [[pridat:ID|Přidat do nabídky]], [[kategorie:SLUG|Název]], [[nabidka|Otevřít nabídku]], [[hledat|text hledání]], [[dodavatel:alsap|Jen ALSAP]] (alsap, trans-technik, hydrotruck, vsichni); ID a SLUG (kategorie_slug) ber jen z výsledků nástrojů. Na konec odpovědi dej 1–2 nejužitečnější tlačítka (další krok).',
  '- Tvůj výstup čte jiný model, ne uživatel: vrať jen stručná ověřená fakta (název, cena bez/s DPH, kód, rozměr) po jednom produktu na řádek s odkazy; bez úvodu a bez omáčky.',
].join('\n')

/** Compact 'where am I' line for the local model (page / category / search / open product) instead of the full screen context. */
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

/** model has tools, but this message didn't look like a catalogue request → no tools sent this turn */
const SYSTEM_PROMPT_LATER = `${SYSTEM_PROMPT_BASIC}\nV tomto kroku nemáte nástroje, ale jinak umíte hledat v katalogu, otevírat kategorie a detaily a upravovat nabídku – stačí, když uživatel napíše konkrétní požadavek (např. „Najdi blatníky do 500 Kč“).`

const CONTEXT_MAX_BYTES = 8 * 1024
const CONTEXT_MAX_DEPTH = 5

/** Keeps only plain JSON data (strings capped), rejects anything too deep. */
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

/** Optional `context` = compact JSON of the user's current screen (route, filters, visible products, quote). */
export function validateContext(body: unknown): string | null {
  const ctx = (body as { context?: unknown } | null)?.context
  if (ctx === undefined || ctx === null) return null
  if (typeof ctx !== 'object' || Array.isArray(ctx)) throw new HttpError(400, 'Neplatný kontext obrazovky.')
  const json = JSON.stringify(cleanContext(ctx))
  if (Buffer.byteLength(json) > CONTEXT_MAX_BYTES) throw new HttpError(400, 'Kontext obrazovky je příliš velký (max. 8 kB).')
  return json === '{}' ? null : json
}

/** JSON → compact indented text (fewer tokens than JSON and easier for a small model to read). */
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

/** Validates the client conversation; returns the messages to send (oldest dropped beyond the limits). */
const PROMPT_HISTORY = 6
const ASSISTANT_CLIP = 500

/** Simple Czech intent heuristic: send tools only for catalogue / product / price / quote / UI-action questions. */
const TOOL_INTENT = /najd|naj[ií]t|hled|vyhled|p[řr][ií]d|odeb|odstra|sma[žz]|zm[ěe]n|uprav|otev[řr]|uka[žz]|zobraz|filtr|kategor|cen[auyěo]?\b|cenov|kolik|stoj[ií]|levn|drah|nab[ií]d|produkt|zbo[žz]|polo[žz]k|katalog|dodavatel|alsap|hydrotruck|trans.?technik|blatn|z[áa]bran|z[áa]st[ěe]r|box|maj[áa]k|dr[žz][áa]k|rezerv|hasic|[čc]erpad|kamer|sv[ěe]tl|n[áa]dob|kanystr|olej|n[áa]dr[žz]|z[áa]suv|nosi[čc]|dopra|doru[čc]|mno[žz]stv|kus|\bks\b|k[čc]\b|\d/i

/** message refers to what the user sees right now (screen, open product, quote) */
const SCREEN_REF = /nab[ií]d|ko[šs][ií]k|\btady\b|\bzde\b|\bto(hle|to)\b|\bten(to|hle)\b|\bta(to|hle)\b|\btu(to|hle)\b|otev[řr]en|obrazovc|vybran|kolik m[áa]m|celkem|tento produkt|str[áa]nk|vid[íi]m/i

export function wantsTools(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1].content
  if (TOOL_INTENT.test(last)) return true
  // short confirmation ("ano", "ten první") right after Karel asked something → keep tools
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
  // keep the most recent messages within the count and size limits
  let msgs = out.slice(-MAX_MESSAGES)
  let total = msgs.reduce((a, m) => a + m.content.length, 0)
  while (msgs.length > 1 && total > MAX_TOTAL_CHARS) {
    total -= msgs[0].content.length
    msgs = msgs.slice(1)
  }
  while (msgs.length > 1 && msgs[0].role !== 'user') msgs = msgs.slice(1)
  return msgs
}

/** Optional `quote` = the user's quote (localStorage in the browser) as [{id, qty}] — used by the quote tools. */
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

export type ModelOption = {
  id: string
  label: string
  provider: 'ollama' | 'groq' | 'gemini'
  description?: string
  model: string
  available: boolean
  tools: boolean
  limits?: ModelLimits | null
}
type ModelChoice = Omit<ModelOption, 'available' | 'limits' | 'tools'>

/** Preferred order when GROQ_MODELS is not set; any other chat model from /models follows alphabetically. */
const GROQ_PREFERRED = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'minimaxai/minimax-m2.7', 'llama-3.1-8b-instant']
const GROQ_FALLBACK = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']
/**
 * Not offered: speech (whisper STT, orpheus TTS), prompt-guard / safeguard classifiers (gpt-oss-safeguard-20b
 * answers like a chat model, but its 2K tokens/min limit is smaller than one request with our prompt + tools),
 * allam-2-7b (Arabic model: broken Czech, no tool calling).
 */
const GROQ_EXCLUDE = /whisper|orpheus|tts|guard|allam|distil|playai/i
const GROQ_LABELS: Record<string, string> = {
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'openai/gpt-oss-20b': 'GPT-OSS 20B (rychlý)',
  'qwen/qwen3.8-27b': 'Qwen 3.8 27B',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B',
  'llama-3.1-8b-instant': 'Llama 3.1 8B (rychlý)',
  'minimaxai/minimax-m2.7': 'MiniMax M2.7',
}
const GROQ_LIST_TTL_MS = 10 * 60_000
const MAX_ROUNDS = 5

function groqLabel(model: string) {
  return `GroqCloud – ${GROQ_LABELS[model] || model.split('/').pop()}`
}

function ollamaLabel(model: string) {
  const m = model.match(/^qwen2\.5:(\d+(?:\.\d+)?)b$/i)
  return m ? `Lokální – Qwen 2.5 ${m[1]}B` : `Lokální – ${model}`
}

/** Google Gemini via its OpenAI-compatible endpoint (streaming + tools work; Gemini 3 needs thought signatures echoed). */
const GEMINI_DEFAULT_MODELS = 'gemini-2.5-flash,gemini-flash-latest'
const GEMINI_LABELS: Record<string, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-flash-latest': 'Gemini Flash (nejnovější)',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash-Lite',
  'gemini-pro-latest': 'Gemini Pro',
}
/** Free tier limits are only shown in AI Studio (not in the docs) → conservative defaults, override via GEMINI_LIMITS. */
const GEMINI_LIMITS: Record<string, { rpm: number; rpd: number; tpm: number }> = {
  'gemini-2.5-flash': { rpm: 10, rpd: 250, tpm: 250_000 },
  'gemini-2.5-flash-lite': { rpm: 15, rpd: 1000, tpm: 250_000 },
  'gemini-flash-latest': { rpm: 5, rpd: 20, tpm: 250_000 },
}
const geminiLabel = (m: string) => `Google – ${GEMINI_LABELS[m] || m}`
function geminiExtras(model: string): Record<string, unknown> {
  // 2.5 Flash(-Lite): thinking off (fast); Gemini 3+ / *-latest can't disable thinking → low
  return /^gemini-2\.5-flash/.test(model) ? { reasoning_effort: 'none' } : { reasoning_effort: 'low' }
}

/** Short Czech description per model for the picker. */
const DESCRIPTIONS: Record<string, string> = {
  'groq:openai/gpt-oss-120b': 'nejchytřejší, výchozí',
  'groq:openai/gpt-oss-20b': 'nejrychlejší',
  'groq:qwen/qwen3.8-27b': 'vyvážený, dobře česky',
  'gemini:gemini-2.5-flash': 'rychlý a spolehlivý, menší denní limit',
  'gemini:gemini-flash-latest': 'nejnovější Flash, chytřejší, pomalejší, jen ~20 dotazů denně',
  'gemini:gemini-2.5-flash-lite': 'nejlevnější a nejrychlejší od Googlu',
}

/** Model-specific Groq request fields: no visible reasoning, small reasoning budget (fast answers). */
function groqExtras(model: string): Record<string, unknown> {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', include_reasoning: false }
  if (/qwen3/i.test(model)) return { reasoning_effort: 'none' }
  return {}
}

/** Local qwen2.5:3b: tools OFF by default — tested on the VPS CPU it took ~2 min per tool question and claimed
 *  actions it never called. OLLAMA_TOOLS=on → this reduced set, or all / a comma list. */
const OLLAMA_DEFAULT_TOOLS = ['hledat_produkty', 'detail_produktu', 'pridat_do_nabidky', 'otevrit_detail_produktu']

function toolSet(spec: string | undefined, def: string[]): ToolDef[] {
  const s = (spec || '').trim().toLowerCase()
  if (s === 'off' || s === 'none' || s === '0') return []
  const names = s === 'all' ? ALL_TOOLS : s && s !== 'on' ? s.split(',').map((x) => x.trim()) : def
  return TOOL_DEFS.filter((t) => names.includes(t.function.name))
}

const fmtWaitCz = (s: number) => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)

const errText = (err: unknown) => (err instanceof Error ? (err.cause as Error)?.message || err.message : String(err))

/** An upstream (model provider) failure with a Czech message for the user. */
class UpstreamError extends Error {
  status: number
  retryAfter: number | null
  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

type ToolCall = { id: string; name: string; args: Record<string, unknown>; rawArgs: string; bad: boolean; extra?: unknown }
type Round = { text: string; calls: ToolCall[] }
/** an OpenAI-compatible cloud provider (GroqCloud, Google Gemini) */
type Cloud = { id: 'groq' | 'gemini'; title: string; url: string; key: string; limits: GroqLimits; extras: (m: string) => Record<string, unknown>; label: (m: string) => string; tools: ToolDef[] }
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

/** Reads a fetch body line by line. */
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

/** product fields the browser needs to put it into the quote even if it's not loaded on screen */
function clientProduct(p: ToolEvent['product']) {
  if (!p) return undefined
  const { id, name, typeSlug, supplier, price, priceVat, unit, dimensions, imageUrl, productUrl, sku, note } = p
  return { id, name, typeSlug, supplier, price, priceVat, unit, dimensions, imageUrl, productUrl, sku, note }
}

export function createChatHandler(env: Record<string, string | undefined>, data?: CatalogData) {
  // ── Ollama (local, on the VPS) ──
  const baseUrl = (env.OLLAMA_URL || 'http://ollama:11434').trim().replace(/\/+$/, '')
  const model = (env.OLLAMA_MODEL || 'qwen2.5:3b').trim()
  const totalTimeout = Math.max(5_000, Number(env.OLLAMA_TIMEOUT_MS) || 300_000)
  const numCtx = Number(env.OLLAMA_NUM_CTX) > 0 ? Math.max(2048, Math.min(32768, Number(env.OLLAMA_NUM_CTX))) : null
  const numThread = Number(env.OLLAMA_NUM_THREAD) > 0 ? Math.min(64, Math.floor(Number(env.OLLAMA_NUM_THREAD))) : null
  const options = numCtx || numThread ? { ...(numCtx ? { num_ctx: numCtx } : {}), ...(numThread ? { num_thread: numThread } : {}) } : undefined
  // optional per-request keep_alive (the VPS Ollama container already runs with OLLAMA_KEEP_ALIVE=-1 = forever,
  // which a per-request value would override — so only send it when configured)
  const keepAlive = (env.OLLAMA_KEEP_ALIVE || '').trim()
  const keep = keepAlive ? { keep_alive: /^-?\d+$/.test(keepAlive) ? Number(keepAlive) : keepAlive } : {}
  const ollamaId = `ollama:${model}`

  // ── GroqCloud (OpenAI-compatible API); the key never leaves the server ──
  const groqKey = (env.GROQ_API_KEY || '').trim()
  const groqUrl = (env.GROQ_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/+$/, '')
  const groqOverride = (env.GROQ_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const groqTimeout = Math.max(5_000, Number(env.GROQ_TIMEOUT_MS) || 90_000)
  let groqListed: { at: number; ids: string[] } | null = null
  const limits = createGroqLimits(env)
  const lastProbe = new Map<string, number>()

  // ── Google Gemini (OpenAI-compatible endpoint); key server-side only ──
  const geminiKey = (env.GEMINI_API_KEY || '').trim()
  const geminiModels = (env.GEMINI_MODELS || GEMINI_DEFAULT_MODELS)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const stateFile = (env.CHAT_STATE_FILE || '').trim()
  const geminiLimits = createGroqLimits(env, {
    defaults: GEMINI_LIMITS,
    fallback: { rpm: 5, rpd: 20, tpm: 250_000 },
    overridesVar: 'GEMINI_LIMITS',
    file: stateFile ? stateFile.replace(/[^/]*$/, 'gemini-rate.json') : '',
    localOnly: true,
    dayTimeZone: 'America/Los_Angeles',
  })
  let geminiListed: { at: number; ids: Set<string> | null } | null = null

  // ── tools ──
  const tools = createChatTools(data)
  const groqTools = tools.available ? toolSet(env.GROQ_TOOLS, ALL_TOOLS) : []
  const ollamaTools = tools.available ? toolSet(env.OLLAMA_TOOLS || 'off', OLLAMA_DEFAULT_TOOLS) : []
  const geminiTools = tools.available ? toolSet(env.GEMINI_TOOLS, ALL_TOOLS) : []
  const clouds: Record<'groq' | 'gemini', Cloud> = {
    groq: { id: 'groq', title: 'GroqCloud', url: groqUrl, key: groqKey, limits, extras: groqExtras, label: (m) => GROQ_LABELS[m] || m, tools: groqTools },
    gemini: {
      id: 'gemini',
      title: 'Google Gemini',
      url: (env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').trim().replace(/\/+$/, ''),
      key: geminiKey,
      limits: geminiLimits,
      extras: geminiExtras,
      label: (m) => GEMINI_LABELS[m] || m,
      tools: geminiTools,
    },
  }

  /** Which configured Gemini models the key lists (native models API, key in a header; cached 10 min). */
  async function geminiAvailable(): Promise<Set<string> | null> {
    if (!geminiKey) return new Set()
    if (geminiListed && Date.now() - geminiListed.at < GROQ_LIST_TTL_MS) return geminiListed.ids
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': geminiKey },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS + 1_000),
      })
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        console.warn(`[acc-db chat] Gemini rejected the API key (HTTP ${r.status})`)
        geminiListed = { at: Date.now() - GROQ_LIST_TTL_MS + 60_000, ids: new Set() }
        return geminiListed.ids
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { models?: { name: string }[] }
      geminiListed = { at: Date.now(), ids: new Set((body.models || []).map((x) => x.name.replace(/^models\//, ''))) }
      return geminiListed.ids
    } catch (err) {
      console.warn('[acc-db chat] Gemini model list failed:', errText(err))
      return geminiListed?.ids ?? null
    }
  }

  /** Chat-capable models this key can use (cached 10 min). null = unknown (network). */
  async function groqDiscover(): Promise<string[] | null> {
    if (!groqKey) return []
    if (groqListed && Date.now() - groqListed.at < GROQ_LIST_TTL_MS) return groqListed.ids
    try {
      const r = await fetch(`${groqUrl}/models`, {
        headers: { Authorization: `Bearer ${groqKey}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS + 1_000),
      })
      if (r.status === 401 || r.status === 403) {
        console.warn(`[acc-db chat] Groq rejected the API key (HTTP ${r.status})`)
        groqListed = { at: Date.now() - GROQ_LIST_TTL_MS + 60_000, ids: [] } // re-check in 1 min
        return groqListed.ids
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as { data?: { id: string; active?: boolean; context_window?: number }[] }
      const ids = (body.data || [])
        .filter((m) => m.active !== false && !GROQ_EXCLUDE.test(m.id) && (m.context_window ?? 131072) >= 8192)
        .map((m) => m.id)
      groqListed = { at: Date.now(), ids }
      return ids
    } catch (err) {
      console.warn('[acc-db chat] Groq model list failed:', errText(err))
      return groqListed?.ids ?? null
    }
  }

  /** Ordered Groq model ids to offer + which of them are usable now. */
  async function groqModels(): Promise<{ ids: string[]; usable: Set<string> }> {
    if (!groqKey) return { ids: [], usable: new Set() }
    const found = await groqDiscover()
    if (groqOverride.length) return { ids: groqOverride, usable: new Set(found === null ? groqOverride : groqOverride.filter((m) => found.includes(m))) }
    if (found === null) return { ids: GROQ_FALLBACK, usable: new Set(GROQ_FALLBACK) }
    const rank = (m: string) => (GROQ_PREFERRED.includes(m) ? GROQ_PREFERRED.indexOf(m) : 100)
    const ids = [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    return { ids, usable: new Set(ids) }
  }

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

  /** Whitelist of selectable models (Groq first when a key is configured). */
  async function modelList(): Promise<(ModelChoice & { usable: boolean })[]> {
    const [g, gem] = await Promise.all([groqModels(), geminiAvailable()])
    return [
      ...g.ids.map((m) => ({ id: `groq:${m}`, label: groqLabel(m), provider: 'groq' as const, model: m, usable: g.usable.has(m) })),
      ...(geminiKey ? geminiModels : []).map((m) => ({ id: `gemini:${m}`, label: geminiLabel(m), provider: 'gemini' as const, model: m, usable: gem === null || gem.has(m) })),
      { id: ollamaId, label: ollamaLabel(model), provider: 'ollama' as const, model, usable: true },
    ]
  }

  /** Cheap request (max 1 token) just to read the rate-limit headers of a model we have no data for yet. */
  async function probe(m: string) {
    lastProbe.set(m, Date.now())
    try {
      limits.noteRequest(m)
      const r = await fetch(`${groqUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({ model: m, max_completion_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
        signal: AbortSignal.timeout(4_000),
      })
      limits.noteHeaders(m, r.headers)
      if (r.status === 429) limits.note429(m, Number(r.headers.get('retry-after')) || null)
      const body = (await r.json().catch(() => null)) as { usage?: { total_tokens?: number } } | null
      if (body?.usage?.total_tokens) limits.noteUsage(m, body.usage.total_tokens)
    } catch {
      /* ignore */
    }
  }

  /** GET /api/chat/status[?probe=1] — selectable models with availability, rate limits + the default. */
  async function status(req: IncomingMessage, res: ServerResponse) {
    const wantProbe = /[?&]probe=1\b/.test(req.url || '')
    const [ollamaOk, list] = await Promise.all([ollamaAvailable(), modelList()])
    if (wantProbe) {
      const todo = list.filter((m) => m.provider === 'groq' && m.usable && !limits.hasData(m.model) && Date.now() - (lastProbe.get(m.model) || 0) > 10 * 60_000)
      if (todo.length) await Promise.all(todo.slice(0, 6).map((m) => probe(m.model)))
    }
    const models: ModelOption[] = list.filter((m) => m.provider === 'ollama').map( // Karel is always the local model; cloud models only help behind the scenes
      ({ usable, ...m }) => ({
      ...m,
      available: m.provider === 'ollama' ? ollamaOk : usable,
      tools: (m.provider === 'ollama' ? ollamaTools : clouds[m.provider].tools).length > 0,
      limits: m.provider === 'ollama' ? null : clouds[m.provider].limits.snapshot(m.model),
      description:
        m.provider === 'ollama'
          ? `na našem serveru, bez limitu, pomalý${ollamaTools.length ? '' : ', bez nástrojů'}`
          : `${clouds[m.provider].title} · ${DESCRIPTIONS[m.id] || 'chatovací model'}`,
    }))
    const preferred = models.find((m) => m.id === 'groq:openai/gpt-oss-120b' && m.available)
    const def = preferred || models.find((m) => m.available) || models[0]
    sendJson(res, 200, {
      models,
      default: def.id,
      available: models.some((m) => m.available),
      now: Date.now(),
      helpers: list
        .filter((m) => m.provider !== 'ollama' && delegateList.includes(m.id))
        .map(({ usable, ...m }) => ({ ...m, available: usable, limits: clouds[m.provider as 'groq' | 'gemini'].limits.snapshot(m.model) })),
      // legacy fields (local model)
      model,
      error: models.some((m) => m.available) ? null : MSG_UNAVAILABLE,
    })
  }

  /** LOCAL_DELEGATE_MODEL: comma list of cloud models doing tool work for the local model ('off' = never) */
  const delegateList = (env.LOCAL_DELEGATE_MODEL || 'groq:openai/gpt-oss-20b,gemini:gemini-2.5-flash,groq:qwen/qwen3.8-27b,gemini:gemini-2.5-flash-lite,groq:openai/gpt-oss-120b')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x && x !== 'off')
  function pickDelegate(skip: Set<string> = new Set()): { cloud: Cloud; model: string; id: string; label: string } | null {
    for (const id of delegateList) {
      if (skip.has(id)) continue
      const [prov, ...rest] = id.split(':')
      const model = rest.join(':')
      const cloud = prov === 'groq' || prov === 'gemini' ? clouds[prov] : undefined
      if (!cloud || !cloud.key || !model || !cloud.tools.length) continue
      if (cloud.limits.blockedFor(model) > 0) continue // limit exhausted → next one / local without tools
      return { cloud, model, id, label: cloud.label(model).replace(/^(GroqCloud|Google) – /, '') }
    }
    return null
  }

  /** [[produkt:ID|…]] / [[pridat:ID|…]] / [[kategorie:SLUG|…]] in an answer → validated against the catalogue for the widget */
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
    // token saving: only the last few turns, long assistant answers shortened
    let messages = all.slice(-PROMPT_HISTORY)
    while (messages.length > 1 && messages[0].role !== 'user') messages = messages.slice(1)
    messages = messages.map((m, i) => (m.role === 'assistant' && i < messages.length - 1 && m.content.length > ASSISTANT_CLIP ? { ...m, content: `${m.content.slice(0, ASSISTANT_CLIP)}…` } : m))
    const last = messages[messages.length - 1].content
    // The static system prompt (+ tools) stays the exact same prefix → Ollama / Groq reuse their prompt cache.
    // The screen context rides in the LAST user message, so earlier turns stay cacheable too.
    return [
      { role: 'system', content: system },
      ...messages.slice(0, -1),
      { role: 'user', content: context ? withContext(context, last) : where ? `${where}\n\nDotaz: ${last}` : last },
    ]
  }

  /** One OpenAI-compatible call (GroqCloud / Gemini, streamed). Text deltas go to onText right away; tool calls are collected. */
  async function cloudRound(cloud: Cloud, m: string, msgs: Msg[], toolDefs: ToolDef[], forceText: boolean, signal: AbortSignal, onText: (t: string) => void, onFirst: () => void, onUsage?: (tokens: number) => void): Promise<Round> {
    const { limits, title } = cloud
    limits.noteRequest(m)
    let r: Response
    try {
      r = await fetch(`${cloud.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloud.key}` },
        body: JSON.stringify({
          model: m,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 450, // Groq counts this into the tokens/min estimate of every request (answers are short)
          temperature: 0.3,
          ...cloud.extras(m),
          messages: msgs,
          ...(toolDefs.length ? { tools: toolDefs, tool_choice: forceText ? 'none' : 'auto' } : {}),
        }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw err
      console.warn(`[acc-db chat] ${title} unreachable:`, errText(err))
      throw new UpstreamError(503, `${title} je teď nedostupný. Zkuste to za chvíli nebo přepněte model.`)
    }
    limits.noteHeaders(m, r.headers)
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '')
      console.warn(`[acc-db chat] ${title} HTTP ${r.status}: ${text.slice(0, 300)}`)
      const st = r.status
      if (st === 401 || st === 403) throw new UpstreamError(502, `${title} odmítl API klíč (neplatný nebo zablokovaný). Přepněte prosím model.`)
      if (st === 429) {
        // retry-after header (s), Groq „try again in 510ms / 1.5s“, Gemini RetryInfo "retryDelay": "23s" / „retry in 23.5s“
        const m429 = text.match(/try again in ([\d.]+)(ms|s)/i) || text.match(/retry in ([\d.]+)(ms|s)/i) || text.match(/"retryDelay":\s*"([\d.]+)(s)"/)
        const ra = Math.ceil(Number(r.headers.get('retry-after'))) || (m429 ? Math.ceil(Number(m429[1]) / (m429[2] === 'ms' ? 1000 : 1)) : null)
        limits.note429(m, ra)
        const daily = cloud.id === 'gemini' && /PerDay|per day/i.test(text)
        throw new UpstreamError(429, `${title}: model ${cloud.label(m)} vyčerpal ${daily ? 'denní limit' : 'limit požadavků nebo tokenů'}${ra ? ` (znovu za ${fmtWaitCz(ra)})` : ''}. Zkuste to později nebo vyberte jiný model.`, ra)
      }
      if (st === 503) throw new UpstreamError(503, `${title}: model ${cloud.label(m)} je teď přetížený. Zkuste to za chvíli nebo vyberte jiný model.`)
      if (st === 404) throw new UpstreamError(503, `Model ${m} teď v ${title} není dostupný. Vyberte prosím jiný.`)
      if (st === 413) throw new UpstreamError(400, 'Dotaz je pro limit tohoto modelu příliš velký. Začněte novou konverzaci nebo vyberte jiný model.')
      if (st === 400 && /tool_use_failed|tool call|function call/i.test(text)) throw new UpstreamError(422, 'tool_use_failed')
      throw new UpstreamError(502, `${title} vrátil chybu. Zkuste to prosím znovu nebo přepněte model.`)
    }
    const calls: { id: string; name: string; args: string; extra?: unknown }[] = []
    let text = ''
    for await (const raw of lines(r.body, onFirst)) {
      const l = raw.trim()
      if (!l.startsWith('data:')) continue
      const d = l.slice(5).trim()
      if (d === '[DONE]') break
      let o: {
        choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }[] } }[]
        usage?: { total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        x_groq?: { usage?: { total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }
        error?: { message?: string }
      }
      try {
        o = JSON.parse(d)
      } catch {
        continue
      }
      if (o.error) {
        console.warn(`[acc-db chat] ${title} stream error:`, o.error.message)
        if (/tool/i.test(o.error.message || '')) throw new UpstreamError(422, 'tool_use_failed')
        throw new UpstreamError(502, `${title} přerušil odpověď. Zkuste to prosím znovu.`)
      }
      const delta = o.choices?.[0]?.delta
      if (delta?.content) {
        text += delta.content
        onText(delta.content)
      }
      for (const tc of delta?.tool_calls || []) {
        let i = tc.index ?? calls.length
        if (tc.id && calls[i]?.id && calls[i].id !== tc.id) i = calls.length // Gemini: complete calls, no index
        calls[i] ||= { id: '', name: '', args: '' }
        if (tc.id) calls[i].id = tc.id
        if (tc.extra_content) calls[i].extra = tc.extra_content // Gemini 3 thought signature — must be sent back
        if (tc.function?.name) calls[i].name += tc.function.name
        if (tc.function?.arguments) calls[i].args += tc.function.arguments
      }
      const usage = o.usage || o.x_groq?.usage
      if (usage?.total_tokens) {
        limits.noteUsage(m, usage.total_tokens, usage.prompt_tokens_details?.cached_tokens || 0)
        onUsage?.(usage.total_tokens)
      }
    }
    return {
      text,
      calls: calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, ...parseArgs(c.args), ...(c.extra ? { extra: c.extra } : {}) })),
    }
  }

  /** One Ollama call (streamed NDJSON). */
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

  /** POST /api/chat — NDJSON stream of events:
   *   {"message":{"content":"…"}}            text delta (same shape as before / as Ollama)
   *   {"type":"status","text":"Hledám…"}      tool progress
   *   {"type":"action",name,args,label,…}     action for the browser (quote / navigation)
   *   {"type":"limits",model,limits}          fresh Groq rate-limit state
   *   {"error":"…","retryAfter":n,"done":true}  error (in-band once streaming started)
   *   {"done":true,"model":"…"}               end
   *  Errors before any output are plain JSON with an HTTP status (400/429/502/503/504). */
  async function chat(req: IncomingMessage, res: ServerResponse) {
    let messages: ChatMessage[]
    let context: string | null
    let quote: Map<string, number>
    let choice: ModelChoice
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
      const list = await modelList()
      choice = list.find((m) => m.provider === 'ollama') || list[list.length - 1] // the requested model is ignored: always local + delegation
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      throw err
    }

    // Local model + a catalogue/action question → the tool loop AND the short final answer run on a fast cheap
    // cloud model (prompt evaluation of tool results on the VPS CPU would take tens of seconds). Plain chat stays local.
    const wants = wantsTools(messages)
    let delegate = choice.provider === 'ollama' && wants && !ollamaTools.length ? pickDelegate() : null
    let cloud = delegate ? delegate.cloud : choice.provider === 'ollama' ? null : clouds[choice.provider]
    let runModel = delegate ? delegate.model : choice.model
    const isGroq = !!cloud // = OpenAI-compatible cloud (GroqCloud or Gemini)
    let limits = cloud?.limits ?? clouds.groq.limits
    const failedDelegates = new Set<string>()
    /** helper exhausted / failing → continue with the next model from LOCAL_DELEGATE_MODEL (tool results so far are kept) */
    const switchDelegate = (): boolean => {
      if (!delegate) return false
      failedDelegates.add(delegate.id)
      const next = pickDelegate(failedDelegates)
      if (!next) return false
      console.warn(`[acc-db chat] helper ${delegate.id} failed, switching to ${next.id}`)
      delegate = next
      cloud = next.cloud
      runModel = next.model
      limits = next.cloud.limits
      delegateText = ''
      line({ type: 'status', text: `Přepínám na pomocníka ${next.label}…` })
      return true
    }
    if (cloud && !delegate) {
      let wait = limits.blockedFor(choice.model)
      if (wait > 0 && wait <= 5) {
        await new Promise((r) => setTimeout(r, wait * 1000 + 200)) // tokens/min window almost reset
        wait = 0
      }
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait))
        return sendJson(res, 429, { error: `${cloud.title}: model ${cloud.label(choice.model)} má vyčerpaný limit (znovu za ${fmtWaitCz(wait)}). Vyberte prosím jiný model.`, retryAfter: wait, limits: limits.snapshot(choice.model) })
      }
    }

    const ctrl = new AbortController()
    let timedOut = false
    const total = setTimeout(
      () => {
        timedOut = true
        ctrl.abort()
      },
      isGroq ? groqTimeout : totalTimeout,
    )
    const onClose = () => {
      if (!res.writableEnded) ctrl.abort()
    }
    res.on('close', onClose)

    const startStream = () => {
      if (res.headersSent) return
      res.statusCode = 200
      // unbuffered streaming: no proxy buffering / transformation (compression), each line flushed at once
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-store, no-transform')
      res.setHeader('X-Accel-Buffering', 'no')
      if (req.httpVersionMajor < 2) res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Chat-Model', choice.id)
      res.socket?.setNoDelay(true)
      res.flushHeaders()
    }
    const line = (o: unknown) => {
      startStream()
      if (!res.destroyed) res.write(JSON.stringify(o) + '\n')
    }
    const sendLimits = () => {
      if (isGroq) line({ type: 'limits', model: delegate ? delegate.id : choice.id, limits: limits.snapshot(runModel) })
    }

    const modelTools = delegate ? delegate.cloud.tools.filter((t) => t.function.name !== 'seznam_kategorii') : cloud ? cloud.tools : ollamaTools
    const toolDefs = wants ? modelTools : []
    // screen context only when tools are sent or the message refers to the current screen / quote
    const sendContext = toolDefs.length > 0 || SCREEN_REF.test(messages[messages.length - 1].content)
    const localPlain = !cloud && !toolDefs.length
    const system = delegate ? SYSTEM_PROMPT_DELEGATE : toolDefs.length ? SYSTEM_PROMPT : localPlain ? SYSTEM_PROMPT_LOCAL : modelTools.length ? SYSTEM_PROMPT_LATER : SYSTEM_PROMPT_BASIC
    // local model: one 'where am I' line; full screen context only for a catalogue question it must answer alone
    const fullCtx = sendContext && (!localPlain || wants)
    let convo = promptMessages(messages, fullCtx ? context : null, system, localPlain && sendContext && !wants ? whereAmI(context) : null)
    const maxRounds = delegate ? 3 : MAX_ROUNDS
    if (delegate) line({ type: 'status', text: `Hledám v katalogu (pomocník ${delegate.label})…` })
    let fullText = ''
    let anyText = false
    let actions = 0
    const done = new Set<string>()
    const usageBy = new Map<string, { label: string; tokens: number }>()
    let delegateText = '' // the helper only gathers facts; the local model writes the answer from them
    const onText = (t: string) => {
      if (delegate) {
        delegateText += t
        return
      }
      anyText = true
      fullText += t
      line({ message: { role: 'assistant', content: t }, done: false })
    }

    /** Groq: a short tokens/min wait (a few seconds) is waited out instead of failing the whole answer */
    const SHORT_WAIT_S = 25 // mid-answer (actions may already be done) → rather wait than fail
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        ctrl.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true })
      })
    const round = async (defs: ToolDef[], forceText: boolean): Promise<Round> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await round1(defs, forceText)
        } catch (err) {
          if (!(isGroq && err instanceof UpstreamError && err.status === 429 && err.retryAfter && err.retryAfter <= SHORT_WAIT_S && attempt < 2 && !(delegate && pickDelegate(new Set([...failedDelegates, delegate.id]))))) throw err
          line({ type: 'status', text: `Čekám na limit GroqCloud (${err.retryAfter} s)…` })
          await sleep(err.retryAfter * 1000 + 300)
        }
      }
    }

    /** one model round with its own first-byte timeout (model load / prompt evaluation) */
    const round1 = async (defs: ToolDef[], forceText: boolean): Promise<Round> => {
      const rc = new AbortController()
      const abort = () => rc.abort()
      ctrl.signal.addEventListener('abort', abort)
      let first: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => {
          timedOut = true
          rc.abort()
        },
        isGroq ? 30_000 : FIRST_BYTE_TIMEOUT_MS,
      )
      const onFirst = () => {
        if (first) clearTimeout(first)
        first = undefined
      }
      try {
        return cloud ? await cloudRound(cloud, runModel, convo, defs, forceText, rc.signal, onText, onFirst, (n) => {
          if (!delegate) return
          const u = usageBy.get(delegate.id) ?? { label: delegate.label, tokens: 0 }
          u.tokens += n
          usageBy.set(delegate.id, u)
        }) : await ollamaRound(convo, forceText ? [] : defs, rc.signal, onText, onFirst)
      } finally {
        onFirst()
        ctrl.signal.removeEventListener('abort', abort)
      }
    }

    // local model: prompt evaluation on the CPU takes seconds → show progress early (after connection errors had their chance)
    const early = isGroq ? undefined : setTimeout(() => !res.headersSent && line({ type: 'status', text: 'Čtu dotaz…' }), 1200)
    try {
      let defs = toolDefs
      for (let i = 0; i < maxRounds; i++) {
        const last = i === maxRounds - 1
        let r: Round
        try {
          r = await round(defs, last && defs.length > 0)
        } catch (err) {
          if (delegate && err instanceof UpstreamError && err.status !== 422 && !ctrl.signal.aborted && switchDelegate()) {
            i--
            continue
          }
          // the model produced a malformed tool call → retry this round once without tools
          if (err instanceof UpstreamError && err.status === 422 && defs.length) {
            console.warn(`[acc-db chat] ${choice.id}: tool call failed, retrying without tools`)
            defs = []
            i--
            continue
          }
          throw err
        }
        if (!r.calls.length || !defs.length) break
        convo = [
          ...convo,
          isGroq
            ? { role: 'assistant', content: r.text || null, tool_calls: r.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs }, ...(c.extra ? { extra_content: c.extra } : {}) })) }
            : { role: 'assistant', content: r.text, tool_calls: r.calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) },
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
              const args = delegate && c.name === 'hledat_produkty' ? { ...c.args, limit: Math.min(Number(c.args.limit) || 3, 3) } : c.args // small result caps for the helper
              result = await tools.run(c.name, args, quote, (e) => {
                actions++
                line({ ...e, product: clientProduct(e.product) })
              })
            } catch (err) {
              console.warn(`[acc-db chat] tool ${c.name} failed:`, errText(err))
              result = { chyba: 'Katalog je teď nedostupný.' }
            }
          }
          console.log(`[acc-db chat] ${choice.id} tool ${c.name}(${JSON.stringify(c.args).slice(0, 160)}) → ${JSON.stringify(result).slice(0, 120)}`)
          convo.push(
            isGroq ? { role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) } : { role: 'tool', content: JSON.stringify(result), tool_name: c.name },
          )
        }
      }
      if (delegate && delegateText.trim()) {
        const facts = delegateText.trim()
        const emit = (t: string) => {
          anyText = true
          fullText += t
          line({ message: { role: 'assistant', content: t }, done: false })
        }
        line({ type: 'status', text: 'Karel formuluje odpověď…' })
        const lastQ = messages[messages.length - 1].content
        const compose = promptMessages(messages, null, SYSTEM_PROMPT_LOCAL)
        compose[compose.length - 1] = { role: 'user', content: `Dotaz: ${lastQ}\n\nOvěřená fakta z katalogu (odpověz jen z nich, nic nepřidávej; odkazy [[…]] opiš beze změny):\n${facts}` }
        const rc = new AbortController()
        const abort = () => rc.abort()
        ctrl.signal.addEventListener('abort', abort)
        const guard = setTimeout(() => rc.abort(), 45_000) // slow CPU → fall back to the helper's facts
        let composed = ''
        try {
          await ollamaRound(compose, [], rc.signal, (t) => (composed += t), () => {})
        } catch (err) {
          if (ctrl.signal.aborted) throw err
          console.warn('[acc-db chat] local compose failed, using helper text:', errText(err))
        } finally {
          clearTimeout(guard)
          ctrl.signal.removeEventListener('abort', abort)
        }
        emit(composed.trim() ? composed : facts)
      }
      if (!anyText) onText(actions ? 'Hotovo.' : 'Promiňte, odpověď se nepodařilo dokončit. Zkuste to prosím znovu.')
      const refs = await linkRefs(fullText)
      if (refs) line({ type: 'refs', ...refs })
      sendLimits()
      if (usageBy.size) line({ type: 'usage', delegates: [...usageBy].map(([id, u]) => ({ id, label: u.label, tokens: u.tokens })) })
      line({ message: { role: 'assistant', content: '' }, done: true, model: choice.id, ...(delegate ? { via: delegate.id } : {}) })
      if (!res.destroyed) res.end()
    } catch (err) {
      if (res.destroyed) return
      let status = 502
      let msg = 'Kapitán Karel narazil na chybu. Zkuste to prosím znovu.'
      let retryAfter: number | null = null
      if (err instanceof UpstreamError) {
        status = err.status === 422 ? 502 : err.status
        msg = err.status === 422 ? 'Model nezvládl použít nástroje. Zkuste to prosím znovu nebo vyberte jiný model.' : err.message
        retryAfter = err.retryAfter
      } else if (timedOut) {
        status = 504
        msg = 'Kapitán Karel neodpověděl včas. Zkuste to prosím znovu.'
      } else {
        console.warn('[acc-db chat] failed:', errText(err))
        msg = 'Spojení s Kapitánem Karlem bylo přerušeno.'
      }
      if (!res.headersSent) {
        if (retryAfter) res.setHeader('Retry-After', String(retryAfter))
        return sendJson(res, status, { error: msg, ...(retryAfter ? { retryAfter } : {}), ...(isGroq && !delegate ? { limits: limits.snapshot(choice.model) } : {}) })
      }
      sendLimits()
      line({ error: msg, ...(retryAfter ? { retryAfter } : {}), done: true })
      res.end()
    } finally {
      clearTimeout(total)
      clearTimeout(early)
      res.off('close', onClose)
    }
  }

  /** Pre-evaluate the (long, static) system prompt + tool definitions once at server start, so the first
   *  real question to the local model doesn't pay ~1 min of CPU prompt evaluation. Best effort. */
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
      groq: groqKey ? { url: groqUrl, models: groqOverride.length ? groqOverride : 'auto' } : null,
      gemini: geminiKey ? { models: geminiModels } : null,
      tools: { groq: groqTools.map((t) => t.function.name), ollama: ollamaTools.map((t) => t.function.name) },
    },
  }
}
