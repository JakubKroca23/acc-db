/**
 * Floating AI assistant „Kapitán Karel“ (mascot: pirate robot) — bottom-right button + chat panel.
 * Talks to POST /acc-db/api/chat, which streams Ollama's NDJSON (`{"message":{"content":"…"}}` per line).
 * All text is rendered via textContent (never innerHTML) → model output cannot inject markup.
 */

import karelHead from './assets/kapitan-karel-head.png'
import karelFull from './assets/kapitan-karel.png'

type Role = 'user' | 'assistant'
type Msg = { role: Role; content: string; error?: boolean }
type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

const HISTORY_KEY = 'acc-db-chat-v1'
const MAX_SEND = 20
const MAX_LEN = 4000
const GENERIC_ERROR = 'Došlo k chybě při komunikaci se serverem.'
const NAME = 'Kapitán Karel'

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

/** getContext: compact snapshot of the user's current screen, sent with every question (the model answers product/price questions only from it). */
export function mountChatWidget(apiFetch: ApiFetch, getContext?: () => unknown) {
  let messages: Msg[] = loadHistory()
  let loading = false
  let statusChecked = false

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
  titleText.append(el('h2', 'chat-title', NAME), el('span', 'chat-subtitle', 'AI asistent katalogu'))
  titleWrap.append(avatar('chat-head-avatar'), titleText)
  const headActions = el('div', 'chat-head-actions')
  const resetBtn = el('button', 'chat-icon-btn chat-reset', 'Nová konverzace')
  resetBtn.type = 'button'
  resetBtn.title = 'Smazat konverzaci a začít znovu'
  const closeBtn = el('button', 'chat-icon-btn chat-close', '✕')
  closeBtn.type = 'button'
  closeBtn.title = 'Zavřít'
  closeBtn.setAttribute('aria-label', 'Zavřít asistenta')
  headActions.append(resetBtn, closeBtn)
  head.append(titleWrap, headActions)

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

  panel.append(head, log, notice, form)
  root.append(fab, panel)
  document.body.append(root)

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60
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
    const b = el('div', `chat-bubble${m.error ? ' is-error' : ''}`, m.content)
    if (m.role === 'assistant') row.append(avatar('chat-msg-avatar'))
    row.append(b)
    return { row, b }
  }

  function renderLog() {
    log.replaceChildren()
    if (!messages.length) {
      const empty = el('div', 'chat-empty')
      const img = el('img', 'chat-empty-mascot')
      img.src = karelFull
      img.alt = NAME
      empty.append(img, el('p', 'chat-empty-hello', `Ahoj, jsem ${NAME}.`), el('p', 'chat-empty-ask', 'S čím v katalogu potřebujete pomoct?'))
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
    panel.classList.toggle('is-loading', v)
  }

  function showNotice(text: string | null) {
    notice.textContent = text || ''
    notice.hidden = !text
  }

  async function checkStatus() {
    if (statusChecked) return
    statusChecked = true
    try {
      const res = await apiFetch('/chat/status')
      if (!res.ok) return
      const s = (await res.json()) as { available?: boolean; error?: string | null }
      showNotice(s.available ? null : s.error || `${NAME} zatím není dostupný.`)
    } catch {
      /* the send itself reports errors */
    }
  }

  function open() {
    panel.hidden = false
    root.classList.add('is-open')
    fab.setAttribute('aria-expanded', 'true')
    renderLog()
    void checkStatus()
    if (!loading) input.focus()
  }

  function close() {
    panel.hidden = true
    root.classList.remove('is-open')
    fab.setAttribute('aria-expanded', 'false')
    fab.focus()
  }

  function safeContext(): unknown {
    try {
      return getContext?.() ?? null
    } catch {
      return null
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
    const b = log.querySelector<HTMLElement>('.chat-row:last-child .chat-bubble')!
    b.classList.add('is-typing')
    b.setAttribute('aria-label', `${NAME} píše…`)

    const fail = (msg: string) => {
      answer.error = true
      answer.content = answer.content ? `${answer.content}\n\n${msg}` : msg
      b.classList.add('is-error')
      b.textContent = answer.content
    }

    try {
      const res = await apiFetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, context: safeContext() }),
      })
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        fail(data.error || GENERIC_ERROR)
        return
      }
      showNotice(null)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const handleLine = (line: string) => {
        if (!line.trim()) return
        let obj: { message?: { content?: string }; error?: string }
        try {
          obj = JSON.parse(line)
        } catch {
          return
        }
        if (obj.error) {
          fail(obj.error)
          return
        }
        const delta = obj.message?.content
        if (delta) {
          const stick = nearBottom()
          answer.content += delta
          b.classList.remove('is-typing')
          b.removeAttribute('aria-label')
          b.textContent = answer.content
          if (stick) scrollDown()
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
      if (!answer.content.trim() && !answer.error) fail(GENERIC_ERROR)
    } catch (err) {
      // apiFetch redirects to the login on 401 and throws; anything else = network problem
      fail(err instanceof Error && /Nepřihlášen/.test(err.message) ? err.message : GENERIC_ERROR)
    } finally {
      b.classList.remove('is-typing')
      b.removeAttribute('aria-label')
      if (answer.error && !answer.content.trim()) answer.content = GENERIC_ERROR
      save()
      setLoading(false)
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
      close()
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
