import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const STATUS_PATH = join(ROOT, 'scripts', 'catalog-update-status.json')

export type CatalogUpdateStatus = {
  state: 'idle' | 'running' | 'ok' | 'error'
  phase: string
  startedAt: string | null
  finishedAt: string | null
  logs: string[]
  error: string | null
  counts: {
    total: number
    bySupplier: Record<string, number>
    byType: Record<string, number>
  } | null
  seed: { accessories: number; products: number; created: number; updated: number } | null
}

export type CatalogUpdateOptions = {
  /** Which suppliers to scrape. Empty / omitted = all. Others keep last scrape. */
  suppliers?: string[]
  /** @deprecated use suppliers without Pavlínek */
  skipPavlinek?: boolean
}

const ALL_SUPPLIERS = ['ALSAP', 'Trans-Technik', 'Hydrotruck', 'Pavlínek', 'Olejspol', 'Hydrolider'] as const

function resolveSuppliers(opts: CatalogUpdateOptions): string[] {
  if (opts.suppliers?.length) {
    const allowed = new Set(ALL_SUPPLIERS)
    const picked = [...new Set(opts.suppliers.map((s) => s.trim()).filter((s) => allowed.has(s as (typeof ALL_SUPPLIERS)[number])))]
    return picked.length ? picked : [...ALL_SUPPLIERS]
  }
  if (opts.skipPavlinek) return ALL_SUPPLIERS.filter((s) => s !== 'Pavlínek')
  return [...ALL_SUPPLIERS]
}

const MAX_LOGS = 200

let status: CatalogUpdateStatus = loadStatus()
let running = false
let stopRequested = false
let currentChild: ChildProcess | null = null

function loadStatus(): CatalogUpdateStatus {
  try {
    if (existsSync(STATUS_PATH)) {
      return JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as CatalogUpdateStatus
    }
  } catch {
    /* ignore */
  }
  return {
    state: 'idle',
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    logs: [],
    error: null,
    counts: null,
    seed: null,
  }
}

function saveStatus() {
  try {
    mkdirSync(dirname(STATUS_PATH), { recursive: true })
    writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

function pushLog(line: string) {
  const trimmed = line.replace(/\r/g, '').trimEnd()
  if (!trimmed) return
  status.logs.push(trimmed)
  if (status.logs.length > MAX_LOGS) status.logs = status.logs.slice(-MAX_LOGS)
  saveStatus()
}

function summarizeJson(): CatalogUpdateStatus['counts'] {
  try {
    const raw = readFileSync(join(ROOT, 'scripts', 'scraped_products.json'), 'utf8')
    const items = JSON.parse(raw) as { supplier: string; typeSlug: string }[]
    const bySupplier: Record<string, number> = {}
    const byType: Record<string, number> = {}
    for (const p of items) {
      bySupplier[p.supplier] = (bySupplier[p.supplier] || 0) + 1
      byType[p.typeSlug] = (byType[p.typeSlug] || 0) + 1
    }
    return { total: items.length, bySupplier, byType }
  } catch {
    return null
  }
}

function killChild(child: ChildProcess | null) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, 1500)
}

function runCmd(
  cmd: string,
  args: string[],
  phase: string,
  envExtra: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (stopRequested) {
      resolve(130)
      return
    }
    status.phase = phase
    pushLog(`$ ${cmd} ${args.join(' ')}`)
    saveStatus()
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    currentChild = child
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) pushLog(line)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => {
      if (currentChild === child) currentChild = null
      reject(err)
    })
    child.on('close', (code, signal) => {
      if (currentChild === child) currentChild = null
      if (stopRequested || signal === 'SIGTERM' || signal === 'SIGKILL') {
        resolve(130)
        return
      }
      resolve(code ?? 1)
    })
  })
}

export function getCatalogUpdateStatus(): CatalogUpdateStatus {
  return status
}

export function stopCatalogUpdate(): { stopped: boolean; status: CatalogUpdateStatus } {
  if (!running && status.state !== 'running') {
    return { stopped: false, status }
  }
  stopRequested = true
  pushLog('STOP — zastavuji aktualizaci…')
  killChild(currentChild)
  status.state = 'error'
  status.phase = 'stopped'
  status.error = 'Zastaveno uživatelem'
  status.finishedAt = new Date().toISOString()
  status.counts = summarizeJson()
  running = false
  saveStatus()
  return { stopped: true, status }
}

export function startCatalogUpdate(
  opts: CatalogUpdateOptions = {},
): { started: boolean; status: CatalogUpdateStatus } {
  if (running || status.state === 'running') {
    return { started: false, status }
  }
  running = true
  stopRequested = false
  currentChild = null
  status = {
    state: 'running',
    phase: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    error: null,
    counts: null,
    seed: null,
  }
  const suppliers = resolveSuppliers(opts)
  pushLog(`Volba dodavatelů: ${suppliers.join(', ')}`)
  saveStatus()

  const scrapeEnv: Record<string, string> = {
    SCRAPE_SUPPLIERS: suppliers.join(','),
  }

  void (async () => {
    try {
      const scrapeCode = await runCmd('python3', ['-u', 'scripts/scrape_products.py'], 'scrape', scrapeEnv)
      if (stopRequested || scrapeCode === 130) throw new Error('Zastaveno uživatelem')
      if (scrapeCode !== 0) throw new Error(`Scrape failed (exit ${scrapeCode})`)
      status.counts = summarizeJson()
      saveStatus()

      if (stopRequested) throw new Error('Zastaveno uživatelem')

      const seedCode = await runCmd('node', ['scripts/seed.mjs'], 'seed')
      if (stopRequested || seedCode === 130) throw new Error('Zastaveno uživatelem')
      if (seedCode !== 0) throw new Error(`Seed failed (exit ${seedCode})`)

      const jsonLine = [...status.logs].reverse().find((l) => l.trim().startsWith('{') && l.includes('"ok"'))
      if (jsonLine) {
        try {
          const parsed = JSON.parse(jsonLine) as {
            accessories: number
            products: number
            created: number
            updated: number
          }
          status.seed = {
            accessories: parsed.accessories,
            products: parsed.products,
            created: parsed.created,
            updated: parsed.updated,
          }
        } catch {
          /* ignore */
        }
      }

      status.state = 'ok'
      status.phase = 'done'
      status.finishedAt = new Date().toISOString()
      pushLog('Catalogue update finished OK')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      status.state = 'error'
      status.phase = stopRequested || msg.includes('Zastaveno') ? 'stopped' : 'error'
      status.error = msg
      status.finishedAt = new Date().toISOString()
      status.counts = status.counts || summarizeJson()
      pushLog(`ERROR: ${status.error}`)
    } finally {
      running = false
      currentChild = null
      stopRequested = false
      saveStatus()
    }
  })()

  return { started: true, status }
}
