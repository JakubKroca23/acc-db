/**
 * Floating AI assistant „Kapitán Karel“ (mascot: pirate robot) — bottom-right button + chat panel.
 * Talks to POST /acc-db/api/chat, which streams NDJSON events: text deltas `{"message":{"content":"…"}}`,
 * `{"type":"status"}` (progress), `{"type":"limits"}` (GroqCloud rate limits), `{"error"}`.
 * All text is rendered via textContent / DOM nodes (never innerHTML) → model output cannot inject markup.
 */

import karelHead from './assets/kapitan-karel-head.png'
import karelFull from './assets/kapitan-karel.png'

type Role = 'user' | 'assistant'
type Msg = { role: Role; content: string; error?: boolean; model?: string }
type LimitBar = { limit: number; used: number; remaining: number; resetAt: number | null; source: 'groq' | 'local' } | null
type ModelLimits = { rpd: LimitBar; tpm: LimitBar; rpm: LimitBar; tpd: LimitBar; blockedUntil: number | null; updatedAt: number | null }
type ModelOption = { id: string; label: string; provider: 'ollama' | 'groq'; available: boolean; tools?: boolean; limits?: ModelLimits | null }
type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

export type ChatHost = {
  getContext?: () => unknown
}

const HISTORY_KEY = 'acc-db-chat-v1'
const MODEL_KEY = 'acc-db-chat-model'
const MAX_SEND = 20
const MAX_LEN = 4000
const GENERIC_ERROR = 'Došlo k chybě při komunikaci se serverem.'
const NAME = 'Kapitán Karel'
const STATUS_REFRESH_MS = 15_000

const nf = new Intl.NumberFormat('cs-CZ')
const shortLabel = (label: string) => label.replace(/^GroqCloud – /, '').replace(/^Lokální – /, '')

function fmtWait(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim()
  const h = Math.floor(s / 3600)
  return `${h} h ${Math.round((s % 3600) / 60)} min`
}

const clock = (t: number) => new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })

/** remaining share → colour class: green ≥ 30 %, amber < 30 %, red < 10 % */
const level = (pct: number) => (pct < 10 ? 'is-red' : pct < 30 ? 'is-amber' : 'is-green')

const BAR_INFO: Record<'rpd' | 'tpm' | 'rpm' | 'tpd', { label: string; short: string; unit: string }> = {
  rpd: { label: 'Požadavky/den', short: 'den', unit: 'požadavků' },
  tpm: { label: 'Tokeny/min', short: 'min', unit: 'tokenů' },
  rpm: { label: 'Požadavky/min', short: 'RPM', unit: 'požadavků' },
  tpd: { label: 'Tokeny/den', short: 'TPD', unit: 'tokenů' },
}

/** Mascot on a white disc (black ink on transparent PNG → readable on any background). */
function avatar(cls: string, src = karelHead) {
  const wrap = el('span', `karel-avatar ${cls}`)
  const img = el('img')
  img.src = src
  img.alt = ''
  img.decoding = 'async'
  wrap.append(img)
  return wrap
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** Markdown line → plain readable line: headings, bullets and table rows (`| a | b |` → `a · b`). */
export function plainLine(raw: string): { text: string; heading: boolean } | null {
  // table separator rows (|---|:--:|) carry no content
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) return null
  let line = raw.replace(/\s+$/, '')
  let heading = false
  const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/)
  if (h) {
    line = h[1].replace(/\s+#+\s*$/, '')
    heading = true
  }
  if (/^\s*\|.*\|\s*$/.test(line)) {
    line = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(' · ')
  }
  line = line.replace(/^(\s*)[-*+]\s+/, '$1• ')
  line = line.replace(/<br\s*\/?>/gi, ' ')
  return { text: line, heading }
}

/**
 * Minimal, safe Markdown for model answers: **bold** and __bold__ → <strong>, headings bold, bullets „•“,
 * tables as plain lines, `code` without backticks. Built with DOM nodes only (no innerHTML),
 * so model output can never inject markup.
 */
export function setRichText(target: HTMLElement, text: string) {
  const nodes: Node[] = []
  const lines = text
    .split('\n')
    .map(plainLine)
    .filter((l): l is { text: string; heading: boolean } => l !== null)
  lines.forEach((l, i) => {
    const parts = l.text.replace(/`([^`]+)`/g, '$1').split(/\*\*(.+?)\*\*|__(.+?)__/g)
    // split with 2 groups → [text, g1, g2, text, g1, g2, …]
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]
      if (!part) continue
      const isBold = k % 3 !== 0 || l.heading
      if (isBold) {
        const strong = document.createElement('strong')
        strong.textContent = part
        nodes.push(strong)
      } else nodes.push(document.createTextNode(part))
    }
    if (i < lines.length - 1) nodes.push(document.createTextNode('\n'))
  })
  target.replaceChildren(...nodes)
}

function loadHistory(): Msg[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY)
    const list = raw ? (JSON.parse(raw) as Msg[]) : []
    return Array.isArray(list)
      ? list.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-40)
      : []
  } catch {
    return []
  }
}

/** One limit bar (remaining share) with tooltip: remaining / limit, reset time, data source. */
function limitBar(key: keyof typeof BAR_INFO, b: LimitBar, compact: boolean): HTMLElement {
  const info = BAR_INFO[key]
  const wrap = el('div', `limit ${compact ? 'is-compact' : ''}`)
  const name = el('span', 'limit-name', compact ? info.short : info.label)
  const track = el('span', 'limit-track')
  const fill = el('span', 'limit-fill')
  track.append(fill)
  const num = el('span', 'limit-num')
  if (!b || !b.limit) {
    wrap.classList.add('is-empty')
    num.textContent = 'zatím bez dat'
    wrap.title = `${info.label}: zatím bez dat (zobrazí se po prvním dotazu na tento model)`
  } else {
    const pct = Math.max(0, Math.min(100, (b.remaining / b.limit) * 100))
    fill.style.width = `${pct}%`
    wrap.classList.add(level(pct))
    num.textContent = compact ? `${Math.round(pct)} %` : `${nf.format(b.remaining)} / ${nf.format(b.limit)}`
    const reset = b.resetAt ? ` · obnoví se za ${fmtWait(b.resetAt - Date.now())} (${clock(b.resetAt)})` : ''
    const src = b.source === 'groq' ? 'údaj z hlaviček GroqCloud (celá organizace)' : 'místní počítadlo (jen tato aplikace)'
    wrap.title = `${info.label}: zbývá ${nf.format(b.remaining)} z ${nf.format(b.limit)} ${info.unit} (${Math.round(pct)} %)${reset}\n${src}`
  }
  wrap.append(name, track, num)
  return wrap
}

function limitBars(m: ModelOption, compact: boolean): HTMLElement {
  const box = el('div', `limits ${compact ? 'is-compact' : ''}`)
  if (m.provider === 'ollama') {
    box.append(el('span', 'limits-free', compact ? 'Lokální model · bez limitu' : 'bez limitu (běží na našem serveru, pomalejší)'))
    return box
  }
  const l = m.limits
  const keys: (keyof typeof BAR_INFO)[] = compact ? ['rpd', 'tpm'] : ['rpd', 'tpm', 'rpm', 'tpd']
  for (const k of keys) box.append(limitBar(k, l ? l[k] : null, compact))
  if (l?.blockedUntil && l.blockedUntil > Date.now()) {
    box.append(el('span', 'limits-blocked', `⏳ limit vyčerpán, znovu za ${fmtWait(l.blockedUntil - Date.now())}`))
  }
  return box
}

/** host.getContext: compact snapshot of the user's current screen, sent with every question. */
export function mountChatWidget(apiFetch: ApiFetch, host: ChatHost = {}) {
  let messages: Msg[] = loadHistory()
  let loading = false
  let models: ModelOption[] = []
  let serverSkew = 0 // server clock − browser clock (reset times come from the server)
  let refreshTimer: number | undefined
  let countdownTimer: number | undefined
  let selectedModel: string = (() => {
    try {
      return localStorage.getItem(MODEL_KEY) || ''
    } catch {
      return ''
    }
  })()

  const root = el('div', 'chat-widget no-print')

  const fab = el('button', 'chat-fab')
  fab.type = 'button'
  fab.setAttribute('aria-controls', 'chat-panel')
  fab.setAttribute('aria-expanded', 'false')
  fab.append(avatar('chat-fab-avatar'), el('span', 'chat-fab-label', NAME))
  fab.title = `${NAME} — AI asistent katalogu. Zeptejte se na cokoli k aplikaci.`
  fab.setAttribute('aria-label', `${NAME} — otevřít AI asistenta`)

  const panel = el('section', 'chat-panel')
  panel.id = 'chat-panel'
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', `${NAME} — AI asistent`)

  const head = el('header', 'chat-head')
  const titleWrap = el('div', 'chat-title-wrap')
  const titleText = el('div', 'chat-title-text')
  // custom model picker (a native <select> can't show the limit bars)
  const modelBtn = el('button', 'chat-model')
  modelBtn.type = 'button'
  modelBtn.setAttribute('aria-haspopup', 'listbox')
  modelBtn.setAttribute('aria-expanded', 'false')
  modelBtn.title = 'Vyberte model AI (s přehledem limitů)'
  const modelBtnText = el('span', 'chat-model-text', 'Načítám modely…')
  modelBtn.append(modelBtnText)
  modelBtn.disabled = true
  titleText.append(el('h2', 'chat-title', NAME), modelBtn)
  titleWrap.append(avatar('chat-head-avatar'), titleText)
  const headActions = el('div', 'chat-head-actions')
  const resetBtn = el('button', 'chat-icon-btn chat-reset')
  resetBtn.type = 'button'
  resetBtn.title = 'Nová konverzace (smaže dosavadní zprávy)'
  resetBtn.setAttribute('aria-label', 'Nová konverzace')
  // static icon markup (no user/model data) — „new chat“ pencil-in-square
  resetBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 8.5-8.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  const closeBtn = el('button', 'chat-icon-btn chat-close', '✕')
  closeBtn.type = 'button'
  closeBtn.title = 'Zavřít'
  closeBtn.setAttribute('aria-label', 'Zavřít asistenta')
  headActions.append(resetBtn, closeBtn)
  head.append(titleWrap, headActions)

  const headLimits = el('div', 'chat-head-limits')
  headLimits.hidden = true

  const menu = el('div', 'chat-model-menu')
  menu.id = 'chat-model-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', 'Model AI')
  menu.hidden = true
  modelBtn.setAttribute('aria-controls', menu.id)

  const log = el('div', 'chat-log')
  log.setAttribute('role', 'log')
  log.setAttribute('aria-live', 'polite')

  const notice = el('div', 'chat-notice')
  notice.hidden = true
  notice.setAttribute('role', 'status')

  const form = el('form', 'chat-form')
  const input = el('input', 'chat-input')
  input.type = 'text'
  input.placeholder = 'Napište dotaz...'
  input.maxLength = MAX_LEN
  input.autocomplete = 'off'
  input.setAttribute('aria-label', 'Dotaz pro asistenta')
  const sendBtn = el('button', 'chat-send', 'Odeslat')
  sendBtn.type = 'submit'
  form.append(input, sendBtn)

  panel.append(head, headLimits, menu, log, notice, form)
  root.append(fab, panel)
  document.body.append(root)

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80
  // instant (not smooth) scrolling — smooth scrolling per token makes streaming feel laggy
  const scrollDown = () => {
    log.scrollTop = log.scrollHeight
  }

  function save() {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(messages.filter((m) => !m.error).slice(-40)))
    } catch {
      /* private mode / quota */
    }
  }

  function bubble(m: Msg) {
    const row = el('div', `chat-row ${m.role === 'user' ? 'from-user' : 'from-assistant'}`)
    const col = el('div', 'chat-col')
    const b = el('div', `chat-bubble${m.error ? ' is-error' : ''}`)
    if (m.role === 'assistant' && !m.error) setRichText(b, m.content)
    else b.textContent = m.content
    const status = el('div', 'chat-status')
    status.hidden = true
    const meta = el('div', 'chat-meta', m.model ? shortLabel(m.model) : '')
    meta.hidden = !m.model
    if (m.model) meta.title = `Odpověděl: ${m.model}`
    col.append(b, status, meta)
    if (m.role === 'assistant') row.append(avatar('chat-msg-avatar'))
    row.append(col)
    return { row, b, status, meta }
  }

  function renderLog() {
    log.replaceChildren()
    if (!messages.length) {
      const empty = el('div', 'chat-empty')
      const img = el('img', 'chat-empty-mascot')
      img.src = karelFull
      img.alt = NAME
      empty.append(
        img,
        el('p', 'chat-empty-hello', `Ahoj, jsem ${NAME}.`),
        el('p', 'chat-empty-ask', 'S čím v katalogu potřebujete pomoct?'),
      )
      log.append(empty)
    } else {
      for (const m of messages) log.append(bubble(m).row)
    }
    resetBtn.hidden = !messages.length || loading
    scrollDown()
  }

  function setLoading(v: boolean) {
    loading = v
    input.disabled = v
    sendBtn.disabled = v
    resetBtn.hidden = !messages.length || v
    modelBtn.disabled = v || models.length < 2
    if (v) closeMenu()
    panel.classList.toggle('is-loading', v)
  }

  function showNotice(text: string | null, extra?: HTMLElement) {
    notice.replaceChildren()
    if (text) notice.append(el('span', '', text))
    if (extra) notice.append(extra)
    notice.hidden = !text
  }

  const currentModel = () => models.find((m) => m.id === selectedModel)
  const now = () => Date.now() + serverSkew
  const blockedMs = (m: ModelOption | undefined) => (m?.limits?.blockedUntil ? m.limits.blockedUntil - now() : 0)

  /** a working alternative to suggest after a 429: another Groq model with headroom, else the local one */
  function suggestion(): ModelOption | undefined {
    const ok = models.filter((m) => m.id !== selectedModel && m.available && blockedMs(m) <= 0)
    const pct = (m: ModelOption) => {
      const r = m.limits?.rpd
      const t = m.limits?.tpm
      return Math.min(r && r.limit ? r.remaining / r.limit : 1, t && t.limit ? t.remaining / t.limit : 1)
    }
    return ok.filter((m) => m.provider === 'groq' && pct(m) > 0.1)[0] || ok.find((m) => m.provider === 'ollama') || ok[0]
  }

  function updateModelNotice() {
    window.clearInterval(countdownTimer)
    const m = currentModel()
    if (!models.length) return
    if (!models.some((x) => x.available)) return showNotice(`${NAME} zatím není dostupný (žádný model AI teď neodpovídá).`)
    if (m && !m.available)
      return showNotice(
        m.provider === 'ollama' ? `Lokální model teď neběží (Ollama na serveru). Vyberte prosím GroqCloud.` : `${m.label} teď není dostupný. Vyberte prosím jiný model.`,
      )
    if (m && blockedMs(m) > 0) {
      const alt = suggestion()
      const tick = () => {
        const left = blockedMs(m)
        if (left <= 0) {
          window.clearInterval(countdownTimer)
          showNotice(null)
          return
        }
        let btn: HTMLButtonElement | undefined
        if (alt) {
          btn = el('button', 'chat-notice-btn', `Přepnout na ${shortLabel(alt.label)}`)
          btn.type = 'button'
          btn.addEventListener('click', () => selectModel(alt.id))
        }
        showNotice(`${shortLabel(m.label)}: limit GroqCloud vyčerpán, znovu za ${fmtWait(left)}.`, btn)
      }
      tick()
      countdownTimer = window.setInterval(tick, 1000)
      return
    }
    showNotice(null)
  }

  function renderModels() {
    const m = currentModel()
    modelBtnText.textContent = m ? `${shortLabel(m.label)}${m.provider === 'groq' ? ' · GroqCloud' : ''}` : 'Vyberte model'
    modelBtn.disabled = loading || models.length < 2
    // compact bars of the selected model under the header
    headLimits.replaceChildren()
    if (m) headLimits.append(limitBars(m, true))
    headLimits.hidden = !m
    // dropdown rows
    menu.replaceChildren(
      ...models.map((x) => {
        const row = el('button', `chat-model-row${x.id === selectedModel ? ' is-selected' : ''}${x.available ? '' : ' is-unavailable'}`)
        row.type = 'button'
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(x.id === selectedModel))
        row.dataset.model = x.id
        row.disabled = !x.available
        const top = el('div', 'chat-model-row-top')
        top.append(el('span', 'chat-model-name', shortLabel(x.label)), el('span', `chat-model-provider is-${x.provider}`, x.provider === 'groq' ? 'GroqCloud' : 'lokální'))
        if (!x.available) top.append(el('span', 'chat-model-off', 'nedostupný'))
        row.append(top, limitBars(x, false))
        return row
      }),
    )
  }

  function openMenu() {
    if (modelBtn.disabled) return
    menu.hidden = false
    modelBtn.setAttribute('aria-expanded', 'true')
    void checkStatus(true) // cheap probe for models without data yet
    menu.querySelector<HTMLElement>('.is-selected')?.focus()
  }
  function closeMenu() {
    if (menu.hidden) return
    menu.hidden = true
    modelBtn.setAttribute('aria-expanded', 'false')
  }

  function selectModel(id: string) {
    selectedModel = id
    try {
      localStorage.setItem(MODEL_KEY, selectedModel)
    } catch {
      /* ignore */
    }
    closeMenu()
    renderModels()
    updateModelNotice()
    input.focus()
  }

  function applyLimits(id: string, limits: ModelLimits | null | undefined) {
    const m = models.find((x) => x.id === id)
    if (!m || !limits) return
    m.limits = limits
    renderModels()
  }

  let statusBusy = false
  async function checkStatus(probe = false) {
    if (statusBusy) return
    statusBusy = true
    try {
      const res = await apiFetch(`/chat/status${probe ? '?probe=1' : ''}`)
      if (!res.ok) return
      const s = (await res.json()) as { models?: ModelOption[]; default?: string; available?: boolean; error?: string | null; now?: number }
      if (typeof s.now === 'number') serverSkew = s.now - Date.now()
      models = Array.isArray(s.models) ? s.models : []
      if (!models.length) {
        showNotice(s.available ? null : s.error || `${NAME} zatím není dostupný.`)
        return
      }
      const stored = models.find((m) => m.id === selectedModel)
      // keep the user's choice while it works; otherwise the server default (gpt-oss-120b, else first available)
      if (!stored || !stored.available) selectedModel = s.default || models.find((m) => m.available)?.id || models[0].id
      renderModels()
      if (!loading) updateModelNotice()
    } catch {
      /* the send itself reports errors */
    } finally {
      statusBusy = false
    }
  }

  modelBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()))
  menu.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-model]')
    if (row && !row.disabled) selectModel(row.dataset.model!)
  })
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[data-model]:not(:disabled)')]
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
  })
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !modelBtn.contains(e.target as Node)) closeMenu()
  })

  function open() {
    panel.hidden = false
    root.classList.add('is-open')
    fab.setAttribute('aria-expanded', 'true')
    renderLog()
    void checkStatus()
    window.clearInterval(refreshTimer)
    refreshTimer = window.setInterval(() => {
      if (!panel.hidden && !document.hidden && !loading) void checkStatus()
    }, STATUS_REFRESH_MS)
    if (!loading) input.focus()
  }

  function close() {
    panel.hidden = true
    closeMenu()
    window.clearInterval(refreshTimer)
    root.classList.remove('is-open')
    fab.setAttribute('aria-expanded', 'false')
    fab.focus()
  }

  function safe<T>(fn: (() => T) | undefined, fallback: T): T {
    try {
      return fn ? fn() : fallback
    } catch {
      return fallback
    }
  }

  async function send(text: string) {
    const userMsg: Msg = { role: 'user', content: text }
    messages.push(userMsg)
    const history = messages
      .filter((m) => !m.error && m.content.trim())
      .slice(-MAX_SEND)
      .map(({ role, content }) => ({ role, content }))
    const answer: Msg = { role: 'assistant', content: '' }
    messages.push(answer)
    setLoading(true)
    renderLog()
    const view = bubble(answer)
    log.lastElementChild?.replaceWith(view.row)
    const { b } = view
    b.classList.add('is-typing')
    b.setAttribute('aria-label', `${NAME} píše…`)
    const modelAtSend = selectedModel

    // batch DOM updates: deltas are appended to `answer.content`, painted at most once per frame
    let frame = 0
    const paint = () => {
      frame = 0
      const stick = nearBottom()
      if (answer.content) {
        b.classList.remove('is-typing')
        b.removeAttribute('aria-label')
        setRichText(b, answer.content)
      }
      if (stick) scrollDown()
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const setStatus = (t: string | null) => {
      const stick = nearBottom()
      view.status.hidden = !t
      view.status.textContent = t || ''
      if (stick) scrollDown()
    }

    const fail = (msg: string) => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      answer.error = true
      answer.content = answer.content ? `${answer.content}\n\n${msg}` : msg
      b.classList.add('is-error')
      b.classList.remove('is-typing')
      b.textContent = answer.content
    }

    try {
      const res = await apiFetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          context: safe(host.getContext, null),
          ...(selectedModel ? { model: selectedModel } : {}),
        }),
      })
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number; limits?: ModelLimits }
        if (data.limits) applyLimits(modelAtSend, data.limits)
        fail(data.error || GENERIC_ERROR)
        if (res.status === 429) {
          const m = models.find((x) => x.id === modelAtSend)
          if (m && data.retryAfter && !(m.limits?.blockedUntil && m.limits.blockedUntil > now())) {
            m.limits = { ...(m.limits || { rpd: null, tpm: null, rpm: null, tpd: null, updatedAt: null }), blockedUntil: now() + data.retryAfter * 1000 }
          }
        }
        return
      }
      answer.model = currentModel()?.label
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const handleLine = (line: string) => {
        if (!line.trim()) return
        let obj: { type?: string; message?: { content?: string }; error?: string; text?: string; model?: string; limits?: ModelLimits; retryAfter?: number }
        try {
          obj = JSON.parse(line)
        } catch {
          return
        }
        if (obj.error) {
          setStatus(null)
          if (obj.retryAfter) {
            const m = models.find((x) => x.id === modelAtSend)
            if (m) m.limits = { ...(m.limits || { rpd: null, tpm: null, rpm: null, tpd: null, updatedAt: null }), blockedUntil: now() + obj.retryAfter * 1000 }
          }
          fail(obj.error)
          return
        }
        if (obj.type === 'status') return setStatus(obj.text || null)
        if (obj.type === 'limits') return applyLimits(obj.model || modelAtSend, obj.limits)
        const delta = obj.message?.content
        if (delta) {
          if (!view.status.hidden) setStatus(null)
          answer.content += delta
          schedule()
        }
      }
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        lines.forEach(handleLine)
      }
      buf += decoder.decode()
      handleLine(buf)
      if (frame) {
        cancelAnimationFrame(frame)
        paint()
      }
      if (!answer.content.trim() && !answer.error) fail(GENERIC_ERROR)
    } catch (err) {
      // apiFetch redirects to the login on 401 and throws; anything else = network problem
      fail(err instanceof Error && /Nepřihlášen/.test(err.message) ? err.message : GENERIC_ERROR)
    } finally {
      setStatus(null)
      b.classList.remove('is-typing')
      b.removeAttribute('aria-label')
      if (answer.error && !answer.content.trim()) answer.content = GENERIC_ERROR
      if (answer.model && !answer.error) {
        view.meta.textContent = shortLabel(answer.model)
        view.meta.title = `Odpověděl: ${answer.model}`
        view.meta.hidden = false
      }
      save()
      setLoading(false)
      updateModelNotice()
      void checkStatus() // fresh limits after each answer
      if (!panel.hidden) input.focus()
    }
  }

  fab.addEventListener('click', open)
  closeBtn.addEventListener('click', close)
  resetBtn.addEventListener('click', () => {
    if (loading) return
    messages = []
    save()
    renderLog()
    input.focus()
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // don't also leave the quote view
      if (!menu.hidden) {
        closeMenu()
        modelBtn.focus()
      } else close()
    }
  })
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text || loading) return
    input.value = ''
    void send(text.slice(0, MAX_LEN))
  })

  renderLog()
}
