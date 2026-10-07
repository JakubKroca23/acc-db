import { spawn } from 'node:child_process'
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

const MAX_LOGS = 200

let status: CatalogUpdateStatus = loadStatus()
let running = false

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

function runCmd(cmd: string, args: string[], phase: string): Promise<number> {
  return new Promise((resolve, reject) => {
    status.phase = phase
    pushLog(`$ ${cmd} ${args.join(' ')}`)
    saveStatus()
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) pushLog(line)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export function getCatalogUpdateStatus(): CatalogUpdateStatus {
  return status
}

export function startCatalogUpdate(): { started: boolean; status: CatalogUpdateStatus } {
  if (running || status.state === 'running') {
    return { started: false, status }
  }
  running = true
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
  saveStatus()

  void (async () => {
    try {
      const scrapeCode = await runCmd('python3', ['-u', 'scripts/scrape_products.py'], 'scrape')
      if (scrapeCode !== 0) throw new Error(`Scrape failed (exit ${scrapeCode})`)
      status.counts = summarizeJson()
      saveStatus()

      const seedCode = await runCmd('node', ['scripts/seed.mjs'], 'seed')
      if (seedCode !== 0) throw new Error(`Seed failed (exit ${seedCode})`)

      // Try parse last JSON line from seed
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
      status.state = 'error'
      status.phase = 'error'
      status.error = err instanceof Error ? err.message : String(err)
      status.finishedAt = new Date().toISOString()
      pushLog(`ERROR: ${status.error}`)
    } finally {
      running = false
      saveStatus()
    }
  })()

  return { started: true, status }
}
