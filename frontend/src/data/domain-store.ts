import { buildDomainSeed } from './domain-seed'
import type { DomainDB } from './domain-types'

// 励磁批量检查领域的独立持久化：与通用台账（hydropower-plant-om:entries）分开存，
// 老模块清数据不会误伤批量结果，批量结果另存、另读、另核对。
const DOMAIN_KEY = 'hydropower-plant-om:excitation-inspection'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyDB(): DomainDB {
  return {
    batches: [],
    history: [],
    duty: [],
    imports: [],
    tokens: { batch: {}, import: {} },
    schemaVersion: 1,
  }
}

function normalize(raw: Partial<DomainDB> | null): DomainDB {
  const fallback = buildDomainSeed()
  if (!raw || typeof raw !== 'object') {
    return fallback
  }
  return {
    batches: Array.isArray(raw.batches) ? raw.batches : [],
    history: Array.isArray(raw.history) ? raw.history : fallback.history,
    duty: Array.isArray(raw.duty) ? raw.duty : fallback.duty,
    imports: Array.isArray(raw.imports) ? raw.imports : [],
    tokens: {
      batch: raw.tokens?.batch ?? {},
      import: raw.tokens?.import ?? {},
    },
    schemaVersion: 1,
  }
}

let cache: DomainDB | null = null

export function domainDB(): DomainDB {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = buildDomainSeed()
    return cache
  }
  const raw = window.localStorage.getItem(DOMAIN_KEY)
  if (!raw) {
    cache = buildDomainSeed()
    window.localStorage.setItem(DOMAIN_KEY, JSON.stringify(cache))
    return cache
  }
  try {
    cache = normalize(JSON.parse(raw) as Partial<DomainDB>)
  } catch {
    cache = emptyDB()
    window.localStorage.setItem(DOMAIN_KEY, JSON.stringify(cache))
  }
  return cache
}

export function saveDomainDB(db: DomainDB): void {
  cache = db
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DOMAIN_KEY, JSON.stringify(db))
  }
}

export function resetDomainDB(): DomainDB {
  const fresh = buildDomainSeed()
  saveDomainDB(clone(fresh))
  return fresh
}

export function domainStorageKey(): string {
  return DOMAIN_KEY
}
