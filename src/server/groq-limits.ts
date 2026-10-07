/**
 * Per-model GroqCloud rate-limit state for Kapitán Karel.
 *
 * Sources:
 *  - Groq response headers (authoritative, org-wide):  x-ratelimit-*-requests = requests per DAY (RPD),
 *    x-ratelimit-*-tokens = tokens per MINUTE (TPM); reset given as durations like "1m26.4s" / "2.29s".
 *  - Local counters (only what THIS app used): requests in the last 60 s (RPM) and tokens today (TPD, UTC day),
 *    from the `usage` Groq returns at the end of each stream.
 *  - Known limits from the org's plan (defaults below = free tier), overridable via env GROQ_LIMITS (JSON).
 * State is kept in memory and (optionally) saved to a small JSON file so a restart doesn't zero it.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export type KnownLimits = { rpm: number; rpd: number; tpm: number; tpd?: number }

const DEFAULT_LIMITS: Record<string, KnownLimits> = {
  'openai/gpt-oss-120b': { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 },
  'openai/gpt-oss-20b': { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 },
  'qwen/qwen3.8-27b': { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 },
  'openai/gpt-oss-safeguard-20b': { rpm: 3, rpd: 1000, tpm: 2000, tpd: 200_000 },
  'llama-3.3-70b-versatile': { rpm: 30, rpd: 1000, tpm: 12_000, tpd: 100_000 },
  'llama-3.1-8b-instant': { rpm: 30, rpd: 14_400, tpm: 6000, tpd: 500_000 },
}
const FALLBACK_LIMITS: KnownLimits = { rpm: 30, rpd: 1000, tpm: 6000, tpd: 100_000 }

type Window = { limit: number; remaining: number; resetAt: number }
type ModelState = {
  rpd?: Window // from headers
  tpm?: Window // from headers
  headersAt?: number
  reqTimes: number[] // local, last 60 s
  tpdDay: string
  tpdUsed: number // local, tokens today (UTC)
  rpdDay?: string // local mode: requests today (provider's day)
  rpdUsed?: number
  tokWin?: [number, number][] // local mode: [time, tokens] in the last 60 s
  blockedUntil?: number // after a 429
}

export type LimitBar = { limit: number; used: number; remaining: number; resetAt: number | null; source: 'groq' | 'local' } | null

export type ModelLimits = {
  rpd: LimitBar
  tpm: LimitBar
  rpm: LimitBar
  tpd: LimitBar
  blockedUntil: number | null
  updatedAt: number | null
}

/** "1m26.4s" | "2.295s" | "450ms" | "2h3m" → milliseconds */
export function parseDuration(v: string | null | undefined): number | null {
  if (!v) return null
  const s = v.trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  let ms = 0
  let matched = false
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true
    const n = Number(m[1])
    ms += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n
  }
  return matched ? Math.round(ms) : null
}

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)
const nextUtcMidnight = (t = Date.now()) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}
/** calendar day + next midnight in a time zone (Gemini resets daily quotas at midnight Pacific time) */
function tzDay(tz: string, t = Date.now()) {
  const day = new Date(t).toLocaleDateString('en-CA', { timeZone: tz })
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  const sinceMidnight = ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000
  return { day, next: t - sinceMidnight + 86_400_000 }
}

export type LimitsOptions = {
  /** known per-model limits (free tier) */
  defaults?: Record<string, KnownLimits>
  fallback?: KnownLimits
  /** env var with JSON overrides */
  overridesVar?: string
  /** state file (default env.CHAT_STATE_FILE) */
  file?: string
  /** no rate-limit headers (Gemini): RPD and TPM come from local counters too */
  localOnly?: boolean
  dayTimeZone?: string
}

export function createGroqLimits(env: Record<string, string | undefined>, opts: LimitsOptions = {}) {
  const defaults = opts.defaults || DEFAULT_LIMITS
  const fallback = opts.fallback || FALLBACK_LIMITS
  const overridesVar = opts.overridesVar || 'GROQ_LIMITS'
  let overrides: Record<string, Partial<KnownLimits>> = {}
  try {
    if (env[overridesVar]) overrides = JSON.parse(env[overridesVar]!)
  } catch {
    console.warn(`[acc-db chat] ${overridesVar} is not valid JSON — using defaults`)
  }
  const file = (opts.file ?? env.CHAT_STATE_FILE ?? '').trim()
  const state = new Map<string, ModelState>()

  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ModelState>
      for (const [k, v] of Object.entries(raw)) state.set(k, { ...v, reqTimes: Array.isArray(v.reqTimes) ? v.reqTimes : [] })
    } catch {
      /* first start */
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  function save() {
    if (!file || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(state)))
        renameSync(`${file}.tmp`, file)
      } catch (err) {
        console.warn('[acc-db chat] cannot save rate state:', err instanceof Error ? err.message : err)
      }
    }, 2000)
    saveTimer.unref?.()
  }

  const known = (model: string): KnownLimits => ({ ...(defaults[model] || fallback), ...(overrides[model] || {}) })

  function get(model: string): ModelState {
    let s = state.get(model)
    if (!s) {
      s = { reqTimes: [], tpdDay: utcDay(), tpdUsed: 0 }
      state.set(model, s)
    }
    const now = Date.now()
    s.reqTimes = s.reqTimes.filter((t) => now - t < 60_000)
    if (s.tpdDay !== utcDay(now)) {
      s.tpdDay = utcDay(now)
      s.tpdUsed = 0
    }
    if (opts.localOnly) {
      const d = tzDay(opts.dayTimeZone || 'UTC', now).day
      if (s.rpdDay !== d) {
        s.rpdDay = d
        s.rpdUsed = 0
      }
      s.tokWin = (s.tokWin || []).filter(([t]) => now - t < 60_000)
    }
    return s
  }

  /** count a request we are about to send (RPM) */
  function noteRequest(model: string) {
    const s = get(model)
    s.reqTimes.push(Date.now())
    if (opts.localOnly) s.rpdUsed = (s.rpdUsed || 0) + 1
    save()
  }

  function noteHeaders(model: string, h: Headers) {
    const s = get(model)
    const now = Date.now()
    const num = (k: string) => {
      const v = h.get(k)
      return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
    }
    const lr = num('x-ratelimit-limit-requests')
    const rr = num('x-ratelimit-remaining-requests')
    if (lr != null && rr != null) s.rpd = { limit: lr, remaining: rr, resetAt: now + (parseDuration(h.get('x-ratelimit-reset-requests')) ?? 0) }
    const lt = num('x-ratelimit-limit-tokens')
    const rt = num('x-ratelimit-remaining-tokens')
    if (lt != null && rt != null) s.tpm = { limit: lt, remaining: rt, resetAt: now + (parseDuration(h.get('x-ratelimit-reset-tokens')) ?? 0) }
    if (lr != null || lt != null) s.headersAt = now
    save()
  }

  function noteUsage(model: string, totalTokens: number, cachedTokens = 0) {
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return
    const s = get(model)
    const n = Math.max(0, totalTokens - (cachedTokens || 0))
    s.tpdUsed += n
    if (opts.localOnly) (s.tokWin ||= []).push([Date.now(), n])
    save()
  }

  function note429(model: string, retryAfterSec: number | null) {
    get(model).blockedUntil = Date.now() + Math.max(1, retryAfterSec ?? 30) * 1000
    save()
  }

  function blockedFor(model: string): number {
    const b = get(model).blockedUntil
    return b && b > Date.now() ? Math.ceil((b - Date.now()) / 1000) : 0
  }

  function hasData(model: string) {
    return opts.localOnly ? true : !!get(model).headersAt
  }

  function snapshot(model: string): ModelLimits {
    const s = get(model)
    const k = known(model)
    const now = Date.now()
    const fromWindow = (w: Window | undefined): LimitBar => {
      if (!w) return null
      // the window has rolled over since the header → assume full again
      const fresh = w.resetAt > now
      const remaining = fresh ? w.remaining : w.limit
      return { limit: w.limit, remaining, used: w.limit - remaining, resetAt: fresh ? w.resetAt : null, source: 'groq' }
    }
    const rpmUsed = s.reqTimes.length
    const local = (limit: number, used: number, resetAt: number | null): LimitBar => ({ limit, used, remaining: Math.max(0, limit - used), resetAt, source: 'local' })
    const tokMin = (s.tokWin || []).reduce((a, [, n]) => a + n, 0)
    return {
      rpd: opts.localOnly ? local(k.rpd, s.rpdUsed || 0, tzDay(opts.dayTimeZone || 'UTC', now).next) : fromWindow(s.rpd),
      tpm: opts.localOnly ? local(k.tpm, tokMin, s.tokWin?.length ? s.tokWin[0][0] + 60_000 : null) : fromWindow(s.tpm),
      rpm: { limit: k.rpm, used: rpmUsed, remaining: Math.max(0, k.rpm - rpmUsed), resetAt: s.reqTimes.length ? s.reqTimes[0] + 60_000 : null, source: 'local' },
      tpd: k.tpd ? { limit: k.tpd, used: s.tpdUsed, remaining: Math.max(0, k.tpd - s.tpdUsed), resetAt: nextUtcMidnight(now), source: 'local' } : null,
      blockedUntil: s.blockedUntil && s.blockedUntil > now ? s.blockedUntil : null,
      updatedAt: s.headersAt || null,
    }
  }

  return { noteRequest, noteHeaders, noteUsage, note429, blockedFor, hasData, snapshot, known }
}

export type GroqLimits = ReturnType<typeof createGroqLimits>
