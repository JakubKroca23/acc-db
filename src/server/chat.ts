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
 *                   model the key's /models returns, gpt-oss-120b first and default)
 *   GROQ_LIMITS     optional JSON {model: {rpm, rpd, tpm, tpd}} overriding the known plan limits (free tier defaults)
 *   GROQ_TIMEOUT_MS max. duration of one Groq answer, default 90000
 *   CHAT_STATE_FILE optional JSON file for the Groq rate-limit counters (survives restarts)
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGroqLimits, type ModelLimits } from './groq-limits.ts'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

const MAX_MESSAGES = 20
const MAX_CONTENT = 4000
const MAX_TOTAL_CHARS = 8000 // conversation; prompt evaluation on the VPS CPU is only ~30 tokens/s
const MAX_BODY_BYTES = 256 * 1024
const FIRST_BYTE_TIMEOUT_MS = 90_000 // model (re)load + prompt evaluation on CPU
const STATUS_TIMEOUT_MS = 3_000

export const MSG_UNAVAILABLE = 'Kapitán Karel zatím není dostupný (Ollama na serveru neběží).'

/** Base = the user's own sentence; the rest describes the app so the model can guide users around it.
 *  Kept compact: the local model evaluates the prompt on the VPS CPU (and Groq's free tier counts tokens/min). */
export const SYSTEM_PROMPT = [
  'Jsi interní asistent v naší webové aplikaci. Pomáhej uživatelům s orientací v systému a odpovídej stručně česky.',
  'Jsi Kapitán Karel (maskot: pirátský robot), AI asistent aplikace „Katalog příslušenství“ firmy Contsystem (nástavby na nákladní vozidla). Když se zeptají, kdo jsi, představ se. Nehraj piráta. Uživateli vždy vykej (Vy, najdete, klikněte), nikdy netykej.',
  '',
  'Aplikace: příslušenství k nákladním vozidlům od dodavatelů ALSAP (červený štítek), Trans-Technik (modrý) a Hydrotruck (zelený); orientační ceny bez DPH a s DPH (21 %).',
  '- Hlavička: filtr dodavatele, hledání „Hledat v katalogu…“ (název, rozměr, kód), tlačítko „Cenová nabídka“ s odznakem ceny bez DPH.',
  '- Levé menu kategorií (na mobilu pruh nahoře): „Vše“ = celý katalog; Podvozek: Blatníky, Zástěrky do blatníků, Držáky blatníků, Boční zábrany, Box na nářadí, Držáky boxů, Držák rezervy, Hasicí přístroj / bedna, Držáky hasicích beden, Maják, Nádoba na vodu, Držáky kanystrů, Uživatelská zásuvka; Všechny nástavby: Čerpadlo, Hydraulický olej, Kamery, Olejová nádrž, Pracovní světla; Hákový nosič kontejneru: Navařovací oko; Ostatní: Boxy / klece na podkládací desky, Podložky pod podpěry, Vázací prostředky. Kategorie s položkami v nabídce mají odznak s počtem. Dole „Aktualizovat katalog“ (stáhne nové ceny, trvá několik minut).',
  '- Produkty jsou seřazené podle ceny (po 60, „Zobrazit další“), nad nimi „Související příslušenství“. Karta produktu: dodavatel, kód, název, rozměry, cena s/bez DPH, „Historie cen“, „Detail ↗“ (web dodavatele), „Přidat do nabídky“ nebo počítadlo − +.',
  '- Cenová nabídka (#/nabidka): položky podle dodavatelů, množství, odhad dopravy, součty bez i s DPH, „Poznámka k nabídce“, „Kopírovat“, „CSV“, „Tisk / PDF“, „Vymazat nabídku“, „← Zpět do katalogu“ (Esc). Ukládá se v prohlížeči.',
  '',
  'Pravidla: Nemáš přístup k databázi produktů. U dotazu můžeš dostat „Aktuální obrazovka uživatele“ (co uživatel právě vidí: stránka, kategorie, filtr, produkty, nabídka se součty); o produktech, cenách a nabídce mluv jen podle ní. Nic si nevymýšlej; co nevíš, přiznej a poraď, kde to v katalogu najde. Odpovídej krátce prostým textem bez Markdownu (žádné tabulky, nadpisy ani hvězdičky; seznam s pomlčkou).',
].join('\n')

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
    '(O produktech, cenách a nabídce odpovídej jen podle těchto údajů, ceny opisuj přesně a uveď, zda jsou bez DPH, nebo s DPH. Co v nich není, nevíš.)',
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

export type ModelOption = {
  id: string
  label: string
  provider: 'ollama' | 'groq'
  model: string
  available: boolean
  limits?: ModelLimits | null
}
type ModelChoice = Omit<ModelOption, 'available' | 'limits'>

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

function groqLabel(model: string) {
  return `GroqCloud – ${GROQ_LABELS[model] || model.split('/').pop()}`
}

function ollamaLabel(model: string) {
  const m = model.match(/^qwen2\.5:(\d+(?:\.\d+)?)b$/i)
  return m ? `Lokální – Qwen 2.5 ${m[1]}B (server)` : `Lokální – ${model} (server)`
}

/** Model-specific Groq request fields: no visible reasoning, small reasoning budget (fast answers). */
function groqExtras(model: string): Record<string, unknown> {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', include_reasoning: false }
  if (/qwen3/i.test(model)) return { reasoning_effort: 'none' }
  return {}
}

const errText = (err: unknown) => (err instanceof Error ? (err.cause as Error)?.message || err.message : String(err))

export function createChatHandler(env: Record<string, string | undefined>) {
  // ── Ollama (local, on the VPS) ──
  const baseUrl = (env.OLLAMA_URL || 'http://ollama:11434').trim().replace(/\/+$/, '')
  const model = (env.OLLAMA_MODEL || 'qwen2.5:3b').trim()
  const totalTimeout = Math.max(5_000, Number(env.OLLAMA_TIMEOUT_MS) || 150_000)
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
    const g = await groqModels()
    return [
      ...g.ids.map((m) => ({ id: `groq:${m}`, label: groqLabel(m), provider: 'groq' as const, model: m, usable: g.usable.has(m) })),
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
    const models: ModelOption[] = list.map(({ usable, ...m }) => ({
      ...m,
      available: m.provider === 'ollama' ? ollamaOk : usable,
      limits: m.provider === 'groq' ? limits.snapshot(m.model) : null,
    }))
    const preferred = models.find((m) => m.id === 'groq:openai/gpt-oss-120b' && m.available)
    const def = preferred || models.find((m) => m.available) || models[0]
    sendJson(res, 200, {
      models,
      default: def.id,
      available: models.some((m) => m.available),
      now: Date.now(),
      // legacy fields (local model)
      model,
      error: models.some((m) => m.available) ? null : MSG_UNAVAILABLE,
    })
  }

  function promptMessages(messages: ChatMessage[], context: string | null) {
    const last = messages[messages.length - 1].content
    // The static system prompt stays the exact same prefix → Ollama reuses its evaluated KV cache.
    // The screen context rides in the LAST user message, so earlier turns stay cacheable too.
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.slice(0, -1),
      { role: 'user', content: context ? withContext(context, last) : last },
    ]
  }

  /** POST /api/chat — always answers with NDJSON lines `{"message":{"content":"…"}}`, last one `{"done":true}`. */
  async function chat(req: IncomingMessage, res: ServerResponse) {
    let messages: ChatMessage[]
    let context: string | null
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
      const list = await modelList()
      const wanted = (body as { model?: unknown }).model
      if (wanted !== undefined && wanted !== null && wanted !== '') {
        const found = typeof wanted === 'string' ? list.find((m) => m.id === wanted) : undefined
        if (!found) throw new HttpError(400, 'Vybraný model není k dispozici. Vyberte prosím jiný.')
        choice = found
      } else {
        choice = list.find((m) => m.usable) || list[0]
      }
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      throw err
    }

    const isGroq = choice.provider === 'groq'
    if (isGroq) {
      let wait = limits.blockedFor(choice.model)
      if (wait > 0 && wait <= 5) {
        await new Promise((r) => setTimeout(r, wait * 1000 + 200)) // tokens/min window almost refilled
        wait = 0
      }
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait))
        return sendJson(res, 429, {
          error: `GroqCloud: model ${GROQ_LABELS[choice.model] || choice.model} má vyčerpaný limit (znovu za ${wait} s). Vyberte prosím jiný model.`,
          retryAfter: wait,
          limits: limits.snapshot(choice.model),
        })
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
    let firstByte: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        timedOut = true
        ctrl.abort()
      },
      isGroq ? 30_000 : FIRST_BYTE_TIMEOUT_MS,
    )
    const clearFirst = () => {
      if (firstByte) clearTimeout(firstByte)
      firstByte = undefined
    }
    // browser closed the panel / navigated away → stop generating
    const onClose = () => {
      if (!res.writableEnded) ctrl.abort()
    }
    res.on('close', onClose)

    const startStream = () => {
      res.statusCode = 200
      // unbuffered streaming: no proxy buffering / transformation (compression), each line flushed at once.
      // (vite preview's compression middleware runs after this handler, so it never wraps the stream;
      // the Traefik router for acc-db has no compress middleware.)
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
      if (!res.destroyed) res.write(JSON.stringify(o) + '\n')
    }
    const brokenMsg = () => (timedOut ? 'Odpověď trvala příliš dlouho a byla přerušena.' : 'Spojení s Kapitánem Karlem bylo přerušeno.')

    const groqFetch = async () => {
      limits.noteRequest(choice.model)
      const r = await fetch(`${groqUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: choice.model,
          stream: true,
          stream_options: { include_usage: true }, // → usage in the last chunk (local tokens/day counter)
          max_completion_tokens: 700, // Groq counts this into the tokens/min estimate of the request
          temperature: 0.4,
          ...groqExtras(choice.model),
          messages: promptMessages(messages, context),
        }),
        signal: ctrl.signal,
      })
      limits.noteHeaders(choice.model, r.headers)
      return r
    }
    /** retry-after header (s) or „try again in 510ms / 1.5s“ in the 429 message */
    const retryAfterOf = (r: Response, text: string) => {
      const m = text.match(/try again in ([\d.]+)(ms|s)/i)
      return Math.ceil(Number(r.headers.get('retry-after'))) || (m ? Math.ceil(Number(m[1]) / (m[2] === 'ms' ? 1000 : 1)) : null)
    }

    try {
      let upstream: Response
      try {
        upstream = isGroq
          ? await groqFetch()
          : await fetch(`${baseUrl}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, stream: true, ...keep, ...(options ? { options } : {}), messages: promptMessages(messages, context) }),
              signal: ctrl.signal,
            })
      } catch (err) {
        if (res.destroyed) return
        console.warn(`[acc-db chat] ${isGroq ? 'Groq' : 'Ollama'} unreachable:`, errText(err))
        if (timedOut) return sendJson(res, 504, { error: 'Kapitán Karel neodpověděl včas. Zkuste to prosím znovu.' })
        return sendJson(res, 503, {
          error: isGroq ? 'GroqCloud je teď nedostupný. Zkuste to za chvíli nebo přepněte na lokální model.' : MSG_UNAVAILABLE,
        })
      }

      // a short tokens/min wait (≤ 12 s) is waited out instead of failing (max 2×)
      for (let attempt = 0; isGroq && upstream.status === 429 && attempt < 2; attempt++) {
        const ra = retryAfterOf(upstream, await upstream.clone().text().catch(() => ''))
        if (!ra || ra > 12) break
        await upstream.body?.cancel().catch(() => {})
        await new Promise((r) => setTimeout(r, ra * 1000 + 300))
        if (res.destroyed || ctrl.signal.aborted) return
        upstream = await groqFetch().catch(() => upstream)
      }

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '')
        clearFirst()
        console.warn(`[acc-db chat] ${isGroq ? 'Groq' : 'Ollama'} HTTP ${upstream.status}: ${text.slice(0, 200)}`)
        if (isGroq) {
          const st = upstream.status
          if (st === 401 || st === 403) return sendJson(res, 502, { error: 'GroqCloud odmítl API klíč (neplatný nebo zablokovaný). Přepněte prosím na lokální model.' })
          if (st === 429) {
            const ra = retryAfterOf(upstream, text)
            limits.note429(choice.model, ra)
            if (ra) res.setHeader('Retry-After', String(ra))
            return sendJson(res, 429, {
              error: `GroqCloud: model ${GROQ_LABELS[choice.model] || choice.model} vyčerpal limit požadavků nebo tokenů${ra ? ` (znovu za ${ra} s)` : ''}. Zkuste to za chvíli nebo vyberte jiný model.`,
              ...(ra ? { retryAfter: ra } : {}),
              limits: limits.snapshot(choice.model),
            })
          }
          if (st === 404) return sendJson(res, 503, { error: `Model ${choice.model} teď v GroqCloud není dostupný. Vyberte prosím jiný.` })
          if (st === 413) return sendJson(res, 400, { error: 'Konverzace je pro GroqCloud příliš dlouhá. Začněte prosím novou konverzaci.' })
          return sendJson(res, 502, { error: 'GroqCloud vrátil chybu. Zkuste to prosím znovu nebo přepněte model.' })
        }
        if (upstream.status === 404) {
          return sendJson(res, 503, { error: `Kapitán Karel zatím není dostupný (model ${model} na serveru chybí).` })
        }
        return sendJson(res, 502, { error: 'Kapitán Karel narazil na chybu. Zkuste to prosím znovu.' })
      }

      startStream()
      const reader = upstream.body.getReader()
      try {
        if (!isGroq) {
          // Ollama already speaks NDJSON with message.content → pass through unchanged
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            clearFirst()
            if (res.destroyed) break
            res.write(value)
          }
        } else {
          // Groq: SSE `data: {choices:[{delta:{content}}]}` … `data: [DONE]` → NDJSON
          const dec = new TextDecoder()
          let buf = ''
          let finished = false
          const handle = (raw: string) => {
            const l = raw.trim()
            if (!l.startsWith('data:')) return
            const data = l.slice(5).trim()
            if (data === '[DONE]') {
              finished = true
              return
            }
            type Usage = { total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
            let o: { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; error?: { message?: string }; usage?: Usage; x_groq?: { usage?: Usage } }
            try {
              o = JSON.parse(data)
            } catch {
              return
            }
            if (o.error) {
              console.warn('[acc-db chat] Groq stream error:', o.error.message)
              line({ error: 'GroqCloud přerušil odpověď. Zkuste to prosím znovu.', done: true })
              finished = true
              return
            }
            const usage = o.usage || o.x_groq?.usage
            if (usage?.total_tokens) limits.noteUsage(choice.model, usage.total_tokens, usage.prompt_tokens_details?.cached_tokens || 0)
            const c = o.choices?.[0]?.delta?.content
            if (c) line({ message: { role: 'assistant', content: c }, done: false })
          }
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            clearFirst()
            if (res.destroyed) break
            buf += dec.decode(value, { stream: true })
            const parts = buf.split('\n')
            buf = parts.pop() || ''
            for (const p of parts) handle(p)
            if (finished) break
          }
          if (buf) handle(buf)
          line({ type: 'limits', model: choice.id, limits: limits.snapshot(choice.model) })
          line({ message: { role: 'assistant', content: '' }, done: true, model: choice.id })
        }
      } catch {
        // aborted (timeout / client gone) or upstream broke mid-answer → tell the client in-band
        if (!res.destroyed) res.write('\n' + JSON.stringify({ error: brokenMsg(), done: true }) + '\n')
      }
      if (!res.destroyed) res.end()
    } finally {
      clearTimeout(total)
      clearFirst()
      res.off('close', onClose)
    }
  }

  /** Pre-evaluate the (long, static) system prompt once at server start, so the first real question
   *  to the local model doesn't pay ~40 s of CPU prompt evaluation. Best effort, errors ignored. */
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
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: 'Ahoj' },
            ],
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
    config: { baseUrl, model, numCtx, numThread, keepAlive, groq: groqKey ? { url: groqUrl, models: groqOverride.length ? groqOverride : 'auto' } : null },
  }
}
