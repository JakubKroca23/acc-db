/**
 * AI assistant: POST /acc-db/api/chat → proxies the conversation to a local Ollama
 * (`/api/chat`, stream: true) and passes its NDJSON stream straight through to the browser.
 * Runs behind the auth gate (only logged-in Manager users with an allowed role).
 *
 * Env:
 *   OLLAMA_URL      default http://ollama:11434 (the `ollama` container on the shared docker network `ollama`)
 *   OLLAMA_MODEL    default qwen2.5:3b
 *   OLLAMA_TIMEOUT_MS  max. duration of one answer, default 120000
 *   OLLAMA_NUM_CTX  context window in tokens, default 8192 (system prompt + screen context + conversation)
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

const MAX_MESSAGES = 20
const MAX_CONTENT = 4000
const MAX_TOTAL_CHARS = 12000 // conversation; + system prompt + screen context must fit into num_ctx
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
  'Pravidla: Nemáš přístup k databázi produktů. O konkrétních produktech, cenách a nabídce mluv jen podle údajů o aktuální obrazovce uživatele, pokud je dostaneš. Nevymýšlej si produkty, ceny ani kódy; když údaj nemáš, řekni, že ho nevíš, a poraď, kde ho v katalogu najde (kategorie, vyhledávání, filtr dodavatele). Odpovídej krátce, nejvýše pár vět nebo stručný seznam.',
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

export function contextMessage(json: string): string {
  return [
    `Aktuální obrazovka uživatele (JSON, stav v okamžiku dotazu): ${json}`,
    'Pro dotazy na produkty, ceny, množství a cenovou nabídku používej výhradně údaje z tohoto JSONu (ceny opisuj přesně, jak jsou uvedené, a vždy řekni, zda jde o cenu bez DPH, nebo s DPH). Co v JSONu není, to nevíš — řekni to a poraď, kde to uživatel v katalogu najde. JSON nevypisuj celý, odpovídej vlastními slovy.',
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

export function createChatHandler(env: Record<string, string | undefined>) {
  const baseUrl = (env.OLLAMA_URL || 'http://ollama:11434').trim().replace(/\/+$/, '')
  const model = (env.OLLAMA_MODEL || 'qwen2.5:3b').trim()
  const totalTimeout = Math.max(5_000, Number(env.OLLAMA_TIMEOUT_MS) || 120_000)
  const numCtx = Math.max(2048, Math.min(32768, Number(env.OLLAMA_NUM_CTX) || 8192))

  /** GET /api/chat/status — is Ollama reachable and does it have the model? */
  async function status(res: ServerResponse) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS)
    try {
      const r = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as { models?: { name?: string; model?: string }[] }
      const names = (data.models || []).map((m) => m.name || m.model || '')
      const want = model.includes(':') ? model : `${model}:latest`
      const hasModel = names.includes(model) || names.includes(want)
      sendJson(res, 200, {
        available: hasModel,
        model,
        error: hasModel ? null : `Kapitán Karel zatím není dostupný (model ${model} na serveru chybí).`,
      })
    } catch {
      sendJson(res, 200, { available: false, model, error: MSG_UNAVAILABLE })
    } finally {
      clearTimeout(t)
    }
  }

  /** POST /api/chat — streams Ollama's NDJSON (one JSON object per line, `message.content` deltas). */
  async function chat(req: IncomingMessage, res: ServerResponse) {
    let messages: ChatMessage[]
    let context: string | null
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
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message })
      throw err
    }

    const ctrl = new AbortController()
    let timedOut = false
    const total = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, totalTimeout)
    let firstByte: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, FIRST_BYTE_TIMEOUT_MS)
    const clearFirst = () => {
      if (firstByte) clearTimeout(firstByte)
      firstByte = undefined
    }
    // browser closed the panel / navigated away → stop generating
    const onClose = () => {
      if (!res.writableEnded) ctrl.abort()
    }
    res.on('close', onClose)

    try {
      let upstream: Response
      try {
        upstream = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: true,
            options: { num_ctx: numCtx },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              ...(context ? [{ role: 'system', content: contextMessage(context) }] : []),
              ...messages,
            ],
          }),
          signal: ctrl.signal,
        })
      } catch (err) {
        if (res.destroyed) return
        console.warn('[acc-db chat] Ollama unreachable:', err instanceof Error ? (err.cause as Error)?.message || err.message : err)
        return sendJson(res, timedOut ? 504 : 503, {
          error: timedOut ? 'Kapitán Karel neodpověděl včas. Zkuste to prosím znovu.' : MSG_UNAVAILABLE,
        })
      }

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '')
        console.warn(`[acc-db chat] Ollama HTTP ${upstream.status}: ${text.slice(0, 200)}`)
        clearFirst()
        if (upstream.status === 404) {
          return sendJson(res, 503, { error: `Kapitán Karel zatím není dostupný (model ${model} na serveru chybí).` })
        }
        return sendJson(res, 502, { error: 'Kapitán Karel narazil na chybu. Zkuste to prosím znovu.' })
      }

      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Accel-Buffering', 'no')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.flushHeaders()

      const reader = upstream.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          clearFirst()
          if (res.destroyed) break
          res.write(value)
        }
      } catch {
        // aborted (timeout / client gone) or upstream broke mid-answer → tell the client in-band
        if (!res.destroyed) {
          res.write(
            '\n' +
              JSON.stringify({
                error: timedOut ? 'Odpověď trvala příliš dlouho a byla přerušena.' : 'Spojení s Kapitánem Karlem bylo přerušeno.',
                done: true,
              }) +
              '\n',
          )
        }
      }
      if (!res.destroyed) res.end()
    } finally {
      clearTimeout(total)
      clearFirst()
      res.off('close', onClose)
    }
  }

  return { chat, status, config: { baseUrl, model, numCtx } }
}
