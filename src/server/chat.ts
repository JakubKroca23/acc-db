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
 *   GROQ_API_KEY    enables GroqCloud models (server-side only, never sent to the browser)
 *   GROQ_MODELS     comma separated Groq model ids, default openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b
 *                   (the first available one is the default in the chat panel)
 *   GROQ_TIMEOUT_MS max. duration of one Groq answer, default 60000
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

const MAX_MESSAGES = 20
const MAX_CONTENT = 4000
const MAX_TOTAL_CHARS = 8000 // conversation; prompt evaluation on the VPS CPU is only ~30 tokens/s
const MAX_BODY_BYTES = 256 * 1024
const FIRST_BYTE_TIMEOUT_MS = 90_000 // model (re)load + prompt evaluation on CPU
const STATUS_TIMEOUT_MS = 3_000

export const MSG_UNAVAILABLE = 'Kapitán Karel zatím není dostupný (Ollama na serveru neběží).'

/** Base = the user's own sentence; the rest describes the app so the model can guide users around it. */
export const SYSTEM_PROMPT = [
  'Jsi interní asistent v naší webové aplikaci. Pomáhej uživatelům s orientací v systému a odpovídej stručně česky.',
  '',
  'Jmenuješ se Kapitán Karel (maskot: pirátský robot) a jsi AI asistent aplikace „Katalog příslušenství“ firmy Contsystem, která vyrábí nástavby na nákladní vozidla (např. hákové nosiče kontejnerů). Když se uživatel zeptá, kdo jsi, představ se jako Kapitán Karel, AI asistent katalogu. Nepiš pirátským slangem a nehraj roli piráta; nanejvýš výjimečně lehký náznak v pozdravu. Uživateli vykej.',
  '',
  'Popis aplikace:',
  '- Katalog obsahuje příslušenství k nákladním vozidlům a nástavbám od tří dodavatelů: ALSAP (červený štítek), Trans-Technik (modrý štítek) a Hydrotruck (zelený štítek). Ceny jsou orientační z veřejných katalogů dodavatelů. „Bez DPH“ je cena bez daně, „s DPH“ včetně 21 % DPH.',
  '- Hlavička (tmavý pruh nahoře): název „Katalog příslušenství“, výběr dodavatele („Všichni dodavatelé“, ALSAP, Trans-Technik, Hydrotruck), hned za ním vyhledávací pole „Hledat v katalogu…“ (hledá v názvu, dodavateli, rozměrech a kódu produktu), jméno přihlášeného uživatele (odkaz zpět do Contsystem Manageru) a tlačítko „Cenová nabídka“.',
  '- Levé menu kategorií (na mobilu vodorovný pruh pod hlavičkou). Nahoře „Vše“ = celý katalog. Dále skupiny: Podvozek (Blatníky, Zástěrky do blatníků, Držáky blatníků, Boční zábrany, Box na nářadí, Držáky boxů, Držák rezervy, Hasicí přístroj / bedna, Držáky hasicích beden, Maják, Nádoba na vodu, Držáky kanystrů, Uživatelská zásuvka), Všechny nástavby (Čerpadlo, Hydraulický olej, Kamery, Olejová nádrž, Pracovní světla), Hákový nosič kontejneru (Navařovací oko), Ostatní (Boxy / klece na podkládací desky, Podložky pod podpěry, Vázací prostředky). Kategorie, ze kterých už je něco v nabídce, mají indigový odznak s počtem položek.',
  '- Dole v levém menu je tlačítko „Aktualizovat katalog“ (stáhne aktuální produkty a ceny od dodavatelů, trvá několik minut) a stav katalogu (počet produktů, datum aktualizace).',
  '- Seznam produktů: nadpis kategorie, počet položek a legenda dodavatelů. Produkty jsou seřazené podle ceny a zobrazují se po 60 („Zobrazit další“). Nad seznamem bývá pruh „Související příslušenství“ s odkazy na příbuzné kategorie (např. k blatníkům zástěrky a držáky).',
  '- Karta produktu (detail produktu): obrázek, štítek dodavatele, kód, název, rozměry, cena s DPH (tučně) a bez DPH za jednotku (ks nebo L), odkaz „Historie cen“ (rozbalí změny ceny v čase), odkaz „Detail ↗“ (otevře produkt na webu dodavatele) a tlačítko „Přidat do nabídky“. Když už produkt v nabídce je, je místo tlačítka počítadlo − / + pro množství.',
  '- Tlačítko „Cenová nabídka“ v hlavičce má odznak s celkovou cenou bez DPH a otevře stránku #/nabidka: položky seskupené podle dodavatele, cena za jednotku a za řádek bez i s DPH, změna množství, odebrání položky, odhad dopravy pro každého dodavatele, součty (Zboží celkem, Doprava celkem, Celkem – bez i s DPH), pole „Poznámka k nabídce“ a tlačítka „Kopírovat“ (text do schránky), „CSV“ (stáhne tabulku), „Tisk / PDF“ (vytisknout nebo uložit jako PDF), „Vymazat nabídku“ a „← Zpět do katalogu“ (nebo klávesa Esc). Nabídka se ukládá v prohlížeči uživatele.',
  '',
  'Pravidla: Nemáš přístup k databázi produktů. U dotazu můžeš dostat údaje „Aktuální obrazovka uživatele“ (stránka, kategorie, filtr, produkty na obrazovce, otevřený detail produktu, obsah cenové nabídky se součty). O konkrétních produktech, cenách a nabídce mluv jen podle nich. Nevymýšlej si produkty, ceny ani kódy; když údaj nemáš, řekni, že ho nevíš, a poraď, kde ho v katalogu najde (kategorie, vyhledávání, filtr dodavatele). Odpovídej krátce, nejvýše pár vět nebo stručný seznam.',
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

export type ModelOption = { id: string; label: string; provider: 'ollama' | 'groq'; model: string; available: boolean }

const GROQ_DEFAULT_MODELS = 'openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b'
const GROQ_LABELS: Record<string, string> = {
  'openai/gpt-oss-120b': 'GroqCloud – GPT-OSS 120B',
  'openai/gpt-oss-20b': 'GroqCloud – GPT-OSS 20B (rychlý)',
  'qwen/qwen3.8-27b': 'GroqCloud – Qwen 3.8 27B',
}
const GROQ_LIST_TTL_MS = 10 * 60_000

function groqLabel(model: string) {
  return GROQ_LABELS[model] || `GroqCloud – ${model.split('/').pop()}`
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
  const options = numCtx ? { num_ctx: numCtx } : undefined
  const ollamaId = `ollama:${model}`

  // ── GroqCloud (OpenAI-compatible API); the key never leaves the server ──
  const groqKey = (env.GROQ_API_KEY || '').trim()
  const groqUrl = (env.GROQ_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/+$/, '')
  const groqModels = (env.GROQ_MODELS || GROQ_DEFAULT_MODELS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const groqTimeout = Math.max(5_000, Number(env.GROQ_TIMEOUT_MS) || 60_000)
  let groqListed: { at: number; ids: Set<string> } | null = null

  /** Which configured Groq models this key can really use (cached 10 min; unknown → assume yes). */
  async function groqAvailableIds(): Promise<Set<string> | null> {
    if (!groqKey) return new Set()
    if (groqListed && Date.now() - groqListed.at < GROQ_LIST_TTL_MS) return groqListed.ids
    try {
      const r = await fetch(`${groqUrl}/models`, {
        headers: { Authorization: `Bearer ${groqKey}` },
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS + 1_000),
      })
      if (r.status === 401 || r.status === 403) {
        console.warn(`[acc-db chat] Groq rejected the API key (HTTP ${r.status})`)
        groqListed = { at: Date.now() - GROQ_LIST_TTL_MS + 60_000, ids: new Set() } // re-check in 1 min
        return groqListed.ids
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as { data?: { id: string; active?: boolean }[] }
      groqListed = { at: Date.now(), ids: new Set((data.data || []).filter((m) => m.active !== false).map((m) => m.id)) }
      return groqListed.ids
    } catch (err) {
      console.warn('[acc-db chat] Groq model list failed:', errText(err))
      return null
    }
  }

  async function ollamaAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
      if (!r.ok) return false
      const data = (await r.json()) as { models?: { name?: string; model?: string }[] }
      const names = (data.models || []).map((m) => m.name || m.model || '')
      return names.includes(model) || names.includes(model.includes(':') ? model : `${model}:latest`)
    } catch {
      return false
    }
  }

  /** Whitelist of selectable models (Groq first when a key is configured). */
  function modelList(): Omit<ModelOption, 'available'>[] {
    return [
      ...(groqKey ? groqModels.map((m) => ({ id: `groq:${m}`, label: groqLabel(m), provider: 'groq' as const, model: m })) : []),
      { id: ollamaId, label: ollamaLabel(model), provider: 'ollama' as const, model },
    ]
  }

  /** GET /api/chat/status — selectable models with availability + the default. */
  async function status(res: ServerResponse) {
    const [ollamaOk, groqIds] = await Promise.all([ollamaAvailable(), groqAvailableIds()])
    const models: ModelOption[] = modelList().map((m) => ({
      ...m,
      available: m.provider === 'ollama' ? ollamaOk : groqIds === null || groqIds.has(m.model),
    }))
    const def = models.find((m) => m.available) || models[0]
    sendJson(res, 200, {
      models,
      default: def.id,
      available: models.some((m) => m.available),
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
    let choice: Omit<ModelOption, 'available'>
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
      const list = modelList()
      const wanted = (body as { model?: unknown }).model
      if (wanted !== undefined && wanted !== null && wanted !== '') {
        const found = typeof wanted === 'string' ? list.find((m) => m.id === wanted) : undefined
        if (!found) throw new HttpError(400, 'Vybraný model není k dispozici. Vyberte prosím jiný.')
        choice = found
      } else {
        choice = list[0]
      }
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      throw err
    }

    const isGroq = choice.provider === 'groq'
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
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Accel-Buffering', 'no')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Chat-Model', choice.id)
      res.flushHeaders()
    }
    const line = (o: unknown) => {
      if (!res.destroyed) res.write(JSON.stringify(o) + '\n')
    }
    const brokenMsg = () => (timedOut ? 'Odpověď trvala příliš dlouho a byla přerušena.' : 'Spojení s Kapitánem Karlem bylo přerušeno.')

    try {
      let upstream: Response
      try {
        upstream = isGroq
          ? await fetch(`${groqUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
              body: JSON.stringify({
                model: choice.model,
                stream: true,
                max_completion_tokens: 1024,
                temperature: 0.4,
                ...groqExtras(choice.model),
                messages: promptMessages(messages, context),
              }),
              signal: ctrl.signal,
            })
          : await fetch(`${baseUrl}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model, stream: true, ...(options ? { options } : {}), messages: promptMessages(messages, context) }),
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

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '')
        clearFirst()
        console.warn(`[acc-db chat] ${isGroq ? 'Groq' : 'Ollama'} HTTP ${upstream.status}: ${text.slice(0, 200)}`)
        if (isGroq) {
          const st = upstream.status
          if (st === 401 || st === 403) return sendJson(res, 502, { error: 'GroqCloud odmítl API klíč (neplatný nebo zablokovaný). Přepněte prosím na lokální model.' })
          if (st === 429) {
            const ra = upstream.headers.get('retry-after')
            if (ra) res.setHeader('Retry-After', ra)
            return sendJson(res, 429, {
              error: `GroqCloud: vyčerpaný limit požadavků nebo tokenů${ra ? ` (zkuste to znovu za ${Math.ceil(Number(ra)) || ra} s)` : ''}. Zkuste to za chvíli nebo přepněte na lokální model.`,
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
            let o: { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; error?: { message?: string } }
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
    config: { baseUrl, model, numCtx, groq: groqKey ? { url: groqUrl, models: groqModels } : null },
  }
}
