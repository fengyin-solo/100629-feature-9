import { listRows, resetRows, saveRows } from '../data/local-store'
import {
  markDutyDone,
  pendingDutyDeviceCodes,
  seedHistoryFromRows,
  upsertCurrentDuty,
} from '../data/duty-store'
import type { BatchResult, DutyEntry, EntryRow, ReceiptOutcome, UnitReceipt } from '../data/types'

// 业务口径（页面与单据上同样标注）：
// 1) 强励次数超过 10 次即超限；2) 检查周期 12 个月，与业务今天比较；
// 3) 业务今天固定为 2026-10-05，保证演示可复现；
// 4) 从无检查记录的装置，以建档基准日 2025-01-01 补录首检口径。
export const BUSINESS_DATE = '2026-10-05'
export const FORCE_LIMIT = 10
export const INSPECT_CYCLE_MONTHS = 12
export const BASELINE_DATE = '2025-01-01'
export const CREWS = ['电气一班', '电气二班', '电气三班']

const BATCH_STORE_KEY = 'hydropower-plant-om:excitation-batches'
const MODULE_KEY = 'excitation'

function readJson<T>(key: string, fallback: T): T {
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

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

// 去重字段：装置编号。归一化口径：去首尾/中间空白、全角转半角、转大写。
export function normalizeCode(value: unknown): string {
  return String(value ?? '')
    .replace(/[　\s]+/g, '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toUpperCase()
}

export function parseForceCount(value: unknown): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

function parseDate(value: unknown): Date | null {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null
  }
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null
  }
  return date
}

function addMonths(value: string, months: number): string {
  const [y, m, d] = value.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  const day = String(Math.min(d, lastDay)).padStart(2, '0')
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0')
  return `${target.getUTCFullYear()}-${mm}-${day}`
}

function djb2(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// 旧版本本地数据迁移：补齐班组与检查日期字段；检测到样例占位值就整体重播种。
export function prepareExcitationData(): EntryRow[] {
  const rows = listRows(MODULE_KEY)
  const isPlaceholder = rows.some((row) => String(row['励磁电压'] ?? '').includes('励磁系统样例'))
  if (isPlaceholder) {
    const seeded = resetRows(MODULE_KEY)
    seedHistoryFromRows(seeded)
    return seeded
  }
  let changed = false
  const next = rows.map((row) => {
    const updated: EntryRow = { ...row }
    if (!String(updated['所属班组'] ?? '').trim()) {
      updated['所属班组'] = CREWS[0]
      changed = true
    }
    const forceRaw = updated['强励次数']
    const force = parseForceCount(forceRaw)
    if (forceRaw !== force) {
      updated['强励次数'] = force
      changed = true
    }
    const dueDate = parseDate(updated['检查日期'])
    const lastDate = parseDate(updated['上次检查日期'])
    if (dueDate && !lastDate) {
      updated['上次检查日期'] = addMonths(String(updated['检查日期']), -INSPECT_CYCLE_MONTHS)
      changed = true
    } else if (!dueDate && !lastDate) {
      // 从来没有检查记录：建档基准日补录首检口径，下次检查日即基准日。
      updated['上次检查日期'] = ''
      updated['检查日期'] = BASELINE_DATE
      changed = true
    } else if (!dueDate && lastDate) {
      updated['检查日期'] = addMonths(String(updated['上次检查日期']), INSPECT_CYCLE_MONTHS)
      changed = true
    }
    return updated
  })
  if (changed) {
    saveRows(MODULE_KEY, next)
  }
  seedHistoryFromRows(next)
  return next
}

function listBatches(): BatchResult[] {
  return readJson<BatchResult[]>(BATCH_STORE_KEY, [])
}

function saveBatches(batches: BatchResult[]): void {
  writeJson(BATCH_STORE_KEY, batches)
}

export function findBatch(clientToken: string): BatchResult | undefined {
  return listBatches().find((batch) => String(batch.clientToken) === String(clientToken))
}

export function getBatch(batchNo: string): BatchResult | undefined {
  return listBatches().find((batch) => batch.batchNo === batchNo)
}

export function allBatches(): BatchResult[] {
  return [...listBatches()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

function nextBatchNo(): string {
  const seq = listBatches().length + 1
  return `BATCH-${BUSINESS_DATE.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`
}

// 幂等指纹：勾选装置编号（与勾选顺序无关）+ 班组 + 业务日期。同一次提交重复触发时只生效一次。
function buildClientToken(rowIds: number[], crew: string): string {
  const rows = listRows(MODULE_KEY)
  const idSet = new Set(rowIds.map(Number))
  const codes = rows
    .filter((row) => idSet.has(Number(row.id)))
    .map((row) => normalizeCode(row['装置编号']))
    .sort()
  return djb2([...codes, crew, BUSINESS_DATE].join('|'))
}

type SubmitInput = {
  rowIds: number[]
  crew: string
  operator: string
  clientToken?: string
}

export type SubmitSummary = {
  batch: BatchResult
  queued: number
  noted: number
  denied: number
  skipped: number
}

export function submitInspectionBatch(input: SubmitInput): SubmitSummary {
  prepareExcitationData()
  // 调用方（页面）按勾选顺序算出指纹并回传；以它为幂等键，同一批重复触发只生效一次。
  const clientToken = input.clientToken || buildClientToken(input.rowIds, input.crew)
  const existing = findBatch(clientToken)
  if (existing) {
    // 重复触发：回传首次回执的副本并标记本次未生效（存档里的首版仍是 true，不改动）。
    return summarize({ ...existing, effective: false })
  }

  const rows = listRows(MODULE_KEY)
  const uniqueIds = [...new Set(input.rowIds.map(Number))]
  const queuedDutyCodes = pendingDutyDeviceCodes()
  const receipts: UnitReceipt[] = []
  const planDutyEntries: DutyEntry[] = []
  let pendingRowUpdates: EntryRow[] | null = null

  for (const rowId of uniqueIds) {
    const index = rows.findIndex((row) => Number(row.id) === rowId)
    const row = rows[index]
    if (!row) {
      receipts.push({
        rowId,
        deviceCode: '—',
        unit: '—',
        crew: input.crew,
        forceCount: 0,
        inspectDate: '',
        outcome: 'skipped',
        statusBefore: '—',
        statusAfter: '—',
        reason: '装置台账中找不到该编号，未纳入本次计划',
      })
      continue
    }
    const code = normalizeCode(row['装置编号'])
    const unit = String(row['所属机组'] ?? '')
    const crew = String(row['所属班组'] ?? CREWS[0])
    const forceCount = parseForceCount(row['强励次数'])
    const inspectDate = String(row['检查日期'] ?? '')
    const statusBefore = String(row.status ?? '')
    const base = {
      rowId: Number(row.id),
      deviceCode: code,
      unit,
      crew,
      forceCount,
      inspectDate,
      statusBefore,
    }

    if (crew !== input.crew) {
      receipts.push({
        ...base,
        outcome: 'denied',
        statusAfter: statusBefore,
        reason: `装置归属${crew}，${input.crew}无权跨班组提交，已挡回；其余装置照常处理`,
      })
      continue
    }
    if (statusBefore === '已退出' || statusBefore === '异常') {
      receipts.push({
        ...base,
        outcome: 'skipped',
        statusAfter: statusBefore,
        reason: `装置当前为「${statusBefore}」，不纳入检查计划`,
      })
      continue
    }

    const overLimit = forceCount > FORCE_LIMIT
    const due = parseDate(inspectDate) !== null && inspectDate <= BUSINESS_DATE
    if (overLimit && !due) {
      // 强励次数超限但检查日期还没到：单独列出，不进待检查。
      receipts.push({
        ...base,
        outcome: 'noted',
        statusAfter: statusBefore,
        reason: `强励次数 ${forceCount} 次已超过 ${FORCE_LIMIT} 次限值，但检查日期 ${inspectDate} 未到，暂不安排，单列提醒`,
      })
      continue
    }

    if (statusBefore === '待检查' && queuedDutyCodes.has(code)) {
      receipts.push({
        ...base,
        outcome: 'queued',
        statusAfter: '待检查',
        reason: '已在待检查队列中，沿用原计划不重复进单',
      })
      continue
    }

    receipts.push({
      ...base,
      outcome: 'queued',
      statusAfter: '待检查',
      reason:
        overLimit && due
          ? `强励次数 ${forceCount} 次超限且检查日期 ${inspectDate} 已到，优先安排`
          : '检查计划已受理，进入待检查',
    })
    planDutyEntries.push({
      id: 0,
      deviceCode: code,
      unit,
      crew,
      batchNo: '',
      businessDate: BUSINESS_DATE,
      type: 'plan',
      result: '待检查',
      voltage: '',
      temp: '',
      source: '批量检查',
      note: '批量提交检查计划',
    })

    if (statusBefore !== '待检查') {
      if (pendingRowUpdates === null) {
        pendingRowUpdates = [...rows]
      }
      pendingRowUpdates[index] = { ...row, status: '待检查', pending: true, abnormal: false }
    }
  }

  const batch: BatchResult = {
    batchNo: nextBatchNo(),
    clientToken,
    businessDate: BUSINESS_DATE,
    crew: input.crew,
    operator: input.operator,
    createdAt: new Date().toISOString(),
    // 能走到这里就是首次生效；重复触发在入口处直接回传首版副本。
    effective: true,
    receipts,
  }
  for (const entry of planDutyEntries) {
    entry.batchNo = batch.batchNo
  }

  if (pendingRowUpdates) {
    saveRows(MODULE_KEY, pendingRowUpdates)
  }
  if (planDutyEntries.length) {
    upsertCurrentDuty(planDutyEntries, { batchNo: batch.batchNo, businessDate: BUSINESS_DATE })
  }
  saveBatches([...listBatches(), batch])
  return summarize(batch)
}

function summarize(batch: BatchResult): SubmitSummary {
  const count = (outcome: ReceiptOutcome) => batch.receipts.filter((r) => r.outcome === outcome).length
  return {
    batch,
    queued: count('queued'),
    noted: count('noted'),
    denied: count('denied'),
    skipped: count('skipped'),
  }
}

export type CompleteItem = { rowId: number; voltage: string; temp: string }

// 检查完成：可控硅温度、励磁电压逐台回写装置台账；值班台账覆盖为完成态。
export function completeBatch(batchNo: string, items: CompleteItem[]): {
  batch?: BatchResult
  done: number
  missing: number
} {
  const batches = listBatches()
  const batch = batches.find((item) => item.batchNo === batchNo)
  if (!batch) {
    return { done: 0, missing: items.length }
  }
  let rows = listRows(MODULE_KEY)
  let changed = false
  let done = 0
  let missing = 0

  for (const item of items) {
    const receipt = batch.receipts.find((r) => Number(r.rowId) === Number(item.rowId))
    if (!receipt || receipt.outcome !== 'queued') {
      missing += 1
      continue
    }
    const index = rows.findIndex((row) => Number(row.id) === Number(item.rowId))
    const row = rows[index]
    if (!row) {
      missing += 1
      continue
    }
    const updated: EntryRow = {
      ...row,
      status: '正常',
      pending: false,
      abnormal: false,
      '励磁电压': item.voltage,
      '可控硅温度': item.temp,
      '上次检查日期': BUSINESS_DATE,
      '检查日期': addMonths(BUSINESS_DATE, INSPECT_CYCLE_MONTHS),
    }
    rows = [...rows]
    rows[index] = updated
    changed = true
    done += 1
    receipt.statusAfter = '正常'

    markDutyDone({
      deviceCode: receipt.deviceCode,
      unit: receipt.unit,
      crew: receipt.crew,
      batchNo,
      businessDate: BUSINESS_DATE,
      voltage: item.voltage,
      temp: item.temp,
      note: `强励 ${receipt.forceCount} 次，检查完成`,
    })
  }
  if (changed) {
    saveRows(MODULE_KEY, rows)
  }
  saveBatches(batches)
  return { batch, done, missing }
}

// 批量结果另存为 CSV：回执台数 = 页面台数，可逐条核对。
export function batchResultCsv(batch: BatchResult): { filename: string; content: string } {
  const header = [
    '批量单号',
    '装置编号',
    '所属机组',
    '所属班组',
    '强励次数',
    '检查日期',
    '处理结果',
    '处理前状态',
    '处理后状态',
    '原因说明',
  ]
  const outcomeText: Record<ReceiptOutcome, string> = {
    queued: '进入待检查',
    noted: '超限单列',
    denied: '越权挡回',
    skipped: '跳过',
    done: '检查完成',
  }
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
  const lines = [header.map(cell).join(',')]
  for (const r of batch.receipts) {
    lines.push(
      [
        batch.batchNo,
        r.deviceCode,
        r.unit,
        r.crew,
        r.forceCount,
        r.inspectDate,
        outcomeText[r.outcome],
        r.statusBefore,
        r.statusAfter,
        r.reason,
      ]
        .map(cell)
        .join(','),
    )
  }
  return { filename: `励磁批量检查结果-${batch.batchNo}.csv`, content: `﻿${lines.join('\n')}` }
}

export type ImportSummary = {
  added: number
  duplicated: number
  invalid: number
  total: number
}

// 重复导入：同装置编号只保留一次，已存在的跳过，绝不多出一行。
export function importDevices(lines: string[][]): ImportSummary {
  prepareExcitationData()
  const rows = listRows(MODULE_KEY)
  const existing = new Set(rows.map((row) => normalizeCode(row['装置编号'])))
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let added = 0
  let duplicated = 0
  let invalid = 0
  const next = [...rows]

  // 同一文件内部的重复也按装置编号判重。
  const seenInFile = new Set<string>()
  for (const line of lines) {
    const code = normalizeCode(line[0])
    if (!code) {
      invalid += 1
      continue
    }
    if (existing.has(code) || seenInFile.has(code)) {
      duplicated += 1
      continue
    }
    seenInFile.add(code)
    existing.add(code)
    const inspectDate = /^\d{4}-\d{2}-\d{2}$/.test(String(line[7] ?? '').trim())
      ? String(line[7]).trim()
      : BASELINE_DATE
    next.push({
      id: nextId,
      status: '待检查',
      pending: true,
      abnormal: false,
      装置编号: code,
      所属机组: String(line[1] ?? '').trim(),
      所属班组: String(line[2] ?? '').trim() || CREWS[0],
      励磁电压: String(line[3] ?? '').trim(),
      励磁电流: String(line[4] ?? '').trim(),
      可控硅温度: String(line[5] ?? '').trim(),
      强励次数: parseForceCount(line[6]),
      上次检查日期: '',
      检查日期: inspectDate,
      装置状态: '运行',
    })
    nextId += 1
    added += 1
  }
  if (added) {
    saveRows(MODULE_KEY, next)
  }
  return { added, duplicated, invalid, total: lines.length }
}

export function excitationStats(rows: EntryRow[]) {
  return {
    normal: rows.filter((r) => String(r.status) === '正常').length,
    abnormal: rows.filter((r) => String(r.status) === '异常').length,
    pending: rows.filter((r) => String(r.status) === '待检查').length,
    noted: rows.filter(
      (r) => parseForceCount(r['强励次数']) > FORCE_LIMIT && String(r['检查日期']) > BUSINESS_DATE,
    ).length,
  }
}
