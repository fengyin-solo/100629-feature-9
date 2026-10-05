import type { DutyEntry, EntryRow } from './types'

// 技术供水值班台账：current 是当班待办（按装置编号覆盖，不叠加），
// history 是按业务时间留存的历史检查台账（早年缺项按条补齐）。
const CURRENT_KEY = 'hydropower-plant-om:duty-current'
const HISTORY_KEY = 'hydropower-plant-om:duty-history'
const HISTORY_SEEDED_KEY = 'hydropower-plant-om:duty-history-seeded'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

// 去重口径：同「装置编号 + 业务时间 + 类型」视为同一条，重复触发只保留一次。
function historyDedupKey(entry: Pick<DutyEntry, 'deviceCode' | 'businessDate' | 'type'>): string {
  return `${entry.deviceCode}@${entry.businessDate}#${entry.type}`
}

export function listCurrentDuty(): DutyEntry[] {
  return read<DutyEntry[]>(CURRENT_KEY, [])
}

export function listDutyHistory(): DutyEntry[] {
  return read<DutyEntry[]>(HISTORY_KEY, [])
}

export function nextDutyId(entries: DutyEntry[]): number {
  return entries.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

// 批量提交时按装置编号 upsert 当班清单：覆盖旧版本，绝不叠加出多条。
export function upsertCurrentDuty(
  incoming: DutyEntry[],
  options: { batchNo: string; businessDate: string },
): DutyEntry[] {
  const current = listCurrentDuty()
  const map = new Map(current.map((entry) => [entry.deviceCode, entry]))
  for (const entry of incoming) {
    map.set(entry.deviceCode, {
      ...entry,
      id: map.get(entry.deviceCode)?.id ?? nextDutyId([...map.values()]),
      batchNo: options.batchNo,
      businessDate: options.businessDate,
    })
  }
  const next = [...map.values()]
  write(CURRENT_KEY, next)
  return next
}

// 检查完成：当班条目转为完成态（仍按装置编号覆盖），历史台账按业务时间追加并去重。
export function markDutyDone(params: {
  deviceCode: string
  unit: string
  crew: string
  batchNo: string
  businessDate: string
  voltage: string
  temp: string
  note: string
}): { current: DutyEntry[]; history: DutyEntry[] } {
  const current = listCurrentDuty()
  const existing = current.find((entry) => entry.deviceCode === params.deviceCode)
  const doneEntry: DutyEntry = {
    id: existing?.id ?? nextDutyId(current),
    deviceCode: params.deviceCode,
    unit: params.unit,
    crew: params.crew,
    batchNo: params.batchNo,
    businessDate: params.businessDate,
    type: 'done',
    result: '正常',
    voltage: params.voltage,
    temp: params.temp,
    source: existing?.source ?? '批量检查',
    note: params.note,
  }
  // 覆盖旧版本：同一装置编号只保留最近一次生效的结果。
  const nextCurrent = [
    ...current.filter((entry) => entry.deviceCode !== params.deviceCode),
    doneEntry,
  ]
  write(CURRENT_KEY, nextCurrent)

  const history = listDutyHistory()
  const historyMap = new Map(history.map((entry) => [historyDedupKey(entry), entry]))
  historyMap.set(historyDedupKey(doneEntry), {
    ...doneEntry,
    id: nextDutyId(history),
  })
  const nextHistory = [...historyMap.values()].sort((a, b) =>
    a.businessDate < b.businessDate ? -1 : a.businessDate > b.businessDate ? 1 : a.id - b.id,
  )
  write(HISTORY_KEY, nextHistory)
  return { current: nextCurrent, history: nextHistory }
}

// 老台账按业务时间回填：同口径条目不重复插，早年缺项按条补齐。
export function backfillDutyHistory(entries: DutyEntry[]): DutyEntry[] {
  const history = listDutyHistory()
  const map = new Map(history.map((entry) => [historyDedupKey(entry), entry]))
  for (const entry of entries) {
    const key = historyDedupKey(entry)
    if (!map.has(key)) {
      map.set(key, { ...entry, id: nextDutyId([...map.values()]) })
    }
  }
  const next = [...map.values()].sort((a, b) =>
    a.businessDate < b.businessDate ? -1 : a.businessDate > b.businessDate ? 1 : a.id - b.id,
  )
  write(HISTORY_KEY, next)
  return next
}

export function isDutyHistorySeeded(): boolean {
  return read<boolean>(HISTORY_SEEDED_KEY, false)
}

export function markDutyHistorySeeded(): void {
  write(HISTORY_SEEDED_KEY, true)
}

// 台账条目与装置台账核对：返回当前当班清单里仍在待检查的装置编号数。
export function pendingDutyDeviceCodes(): Set<string> {
  return new Set(
    listCurrentDuty()
      .filter((entry) => entry.type === 'plan')
      .map((entry) => entry.deviceCode),
  )
}

// 供批量回执与另一个入口做条数核对。
export function currentDutyCount(): number {
  return listCurrentDuty().length
}

export function seedHistoryFromRows(rows: EntryRow[]): void {
  if (isDutyHistorySeeded()) {
    return
  }
  const entries: DutyEntry[] = []
  for (const row of rows) {
    const code = String(row['装置编号'] ?? '').trim()
    const lastDate = String(row['上次检查日期'] ?? '')
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
      continue
    }
    const year = Number(lastDate.slice(0, 4))
    // 上次检查当年一条；到业务今天之间的早年缺项，按条补齐。
    for (let y = year; y <= 2026; y += 1) {
      const businessDate = `${y}-12-20`
      entries.push({
        id: 0,
        deviceCode: code,
        unit: String(row['所属机组'] ?? ''),
        crew: String(row['所属班组'] ?? ''),
        batchNo: 'HIST-BACKFILL',
        businessDate,
        type: 'done',
        result: '正常',
        voltage: String(row['励磁电压'] ?? ''),
        temp: String(row['可控硅温度'] ?? ''),
        source: '老台账回填',
        note:
          y === year
            ? '按上次检查日期回填'
            : '早年缺项按条补齐',
      })
    }
  }
  if (entries.length) {
    backfillDutyHistory(entries)
  }
  markDutyHistorySeeded()
}
