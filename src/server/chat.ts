/**
 * AI assistant: POST /acc-db/api/chat → proxies the conversation to a local Ollama
 * (`/api/chat`, stream: true) and passes its NDJSON stream straight through to the browser.
 * Runs behind the auth gate (only logged-in Manager users with an allowed role).
 *
 * Env:
 *   OLLAMA_URL      default http://ollama:11434 (the `ollama` container on the shared docker network `ollama`)
 *   OLLAMA_MODEL    default qwen2.5:3b
 *   OLLAMA_TIMEOUT_MS  max. duration of one answer, default 120000
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

const MAX_MESSAGES = 20
const MAX_CONTENT = 4000
const MAX_TOTAL_CHARS = 16000 // keep the prompt within the model's default context
const MAX_BODY_BYTES = 256 * 1024
const FIRST_BYTE_TIMEOUT_MS = 45_000 // model load / prompt evaluation on CPU
const STATUS_TIMEOUT_MS = 3_000

export const MSG_UNAVAILABLE = 'AI asistent zatím není dostupný (Ollama na serveru neběží).'

/** Base = the user's original prompt; the rest tells the model where it lives. */
export const SYSTEM_PROMPT = [
  'Jsi užitečný asistent integrovaný přímo v aplikaci. Pomáhej uživateli s navigací a dotazy. Odpovídej věcně, stručně a česky.',
  '',
  'Jsi asistent interní aplikace „Katalog příslušenství“ firmy Contsystem (výrobce nástaveb na nákladní vozidla, např. hákových nosičů kontejnerů).',
  'Katalog obsahuje příslušenství k nákladním vozidlům a nástavbám od dodavatelů ALSAP, Trans-Technik a Hydrotruck; u produktů jsou ceny bez DPH i s DPH.',
  'Jak aplikace funguje:',
  '- Vlevo je navigace kategorií (na mobilu vodorovný pruh nahoře). Položka „Vše“ zobrazí celý katalog.',
  '- Kategorie: Podvozek (blatníky, zástěrky, boční zábrany, boxy na nářadí, držák rezervy, hasicí přístroj, maják, nádoba na vodu, držáky kanystrů, uživatelská zásuvka), Všechny nástavby (čerpadlo, hydraulický olej, kamery, olejová nádrž, pracovní světla), Hákový nosič kontejneru (navařovací oko), Ostatní (podkládací desky pod podpěry a boxy na ně, vázací prostředky).',
  '- V hlavičce je filtr dodavatele a vyhledávání v katalogu (název, rozměr, kód).',
  '- Tlačítkem „Přidat do nabídky“ u produktu se položka vloží do „Cenové nabídky“ (tlačítko vpravo v hlavičce). Kategorie s položkami v nabídce jsou v navigaci zvýrazněné.',
  '- V Cenové nabídce lze měnit množství, přidat poznámku, nabídku zkopírovat, stáhnout jako CSV nebo vytisknout / uložit do PDF („Tisk / PDF“). Součty jsou bez DPH i s DPH včetně odhadu dopravy podle dodavatele. Ceny jsou orientační z veřejných katalogů dodavatelů.',
  '- „Aktualizovat katalog“ dole v levém panelu načte aktuální produkty a ceny od dodavatelů.',
  'Pravidla: Nemáš přístup k databázi produktů, takže si nevymýšlej konkrétní produkty, ceny ani kódy — poraď, kde je uživatel v katalogu najde (kategorie, vyhledávání, filtr dodavatele). Když něco nevíš, řekni to. Odpovídej krátce, nejvýše pár vět nebo stručný seznam.',
].join('\n')

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
        error: hasModel ? null : `AI asistent zatím není dostupný (model ${model} na serveru chybí).`,
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
    try {
      const raw = await readBody(req, MAX_BODY_BYTES)
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        throw new HttpError(400, 'Neplatný požadavek (očekáván JSON).')
      }
      messages = validateMessages(body)
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
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
          }),
          signal: ctrl.signal,
        })
      } catch (err) {
        if (res.destroyed) return
        console.warn('[acc-db chat] Ollama unreachable:', err instanceof Error ? (err.cause as Error)?.message || err.message : err)
        return sendJson(res, timedOut ? 504 : 503, {
          error: timedOut ? 'AI asistent neodpověděl včas. Zkuste to prosím znovu.' : MSG_UNAVAILABLE,
        })
      }

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '')
        console.warn(`[acc-db chat] Ollama HTTP ${upstream.status}: ${text.slice(0, 200)}`)
        clearFirst()
        if (upstream.status === 404) {
          return sendJson(res, 503, { error: `AI asistent zatím není dostupný (model ${model} na serveru chybí).` })
        }
        return sendJson(res, 502, { error: 'AI asistent vrátil chybu. Zkuste to prosím znovu.' })
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
                error: timedOut ? 'Odpověď trvala příliš dlouho a byla přerušena.' : 'Spojení s AI asistentem bylo přerušeno.',
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

  return { chat, status, config: { baseUrl, model } }
}
