/**
 * Floating AI assistant („AI Pomocník“) — bottom-right button + chat panel.
 * Talks to POST /acc-db/api/chat, which streams Ollama's NDJSON (`{"message":{"content":"…"}}` per line).
 * All text is rendered via textContent (never innerHTML) → model output cannot inject markup.
 */

type Role = 'user' | 'assistant'
type Msg = { role: Role; content: string; error?: boolean }
type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

const HISTORY_KEY = 'acc-db-chat-v1'
const MAX_SEND = 20
const MAX_LEN = 4000
const GENERIC_ERROR = 'Došlo k chybě při komunikaci se serverem.'

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

export function mountChatWidget(apiFetch: ApiFetch) {
  let messages: Msg[] = loadHistory()
  let loading = false
  let statusChecked = false

  const root = el('div', 'chat-widget no-print')

  const fab = el('button', 'chat-fab')
  fab.type = 'button'
  fab.setAttribute('aria-controls', 'chat-panel')
  fab.setAttribute('aria-expanded', 'false')
  fab.append(el('span', 'chat-fab-icon', '💬'), el('span', 'chat-fab-label', 'Asistent'))
  fab.title = 'AI Pomocník — zeptejte se na cokoli k aplikaci'

  const panel = el('section', 'chat-panel')
  panel.id = 'chat-panel'
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'AI Pomocník')

  const head = el('header', 'chat-head')
  const titleWrap = el('div', 'chat-title-wrap')
  titleWrap.append(el('span', 'chat-dot'), el('h2', 'chat-title', 'AI Pomocník'))
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
    row.append(b)
    return { row, b }
  }

  function renderLog() {
    log.replaceChildren()
    if (!messages.length) {
      log.append(el('p', 'chat-empty', 'S čím v aplikaci potřebujete pomoct?'))
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
      showNotice(s.available ? null : s.error || 'AI asistent zatím není dostupný.')
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
    const { b } = bubble(answer)
    const lastRow = log.lastElementChild as HTMLElement
    lastRow.replaceChildren(b)
    b.classList.add('is-typing')
    b.setAttribute('aria-label', 'Asistent píše…')

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
        body: JSON.stringify({ messages: history }),
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
