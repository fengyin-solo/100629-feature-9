import { domainDB, saveDomainDB } from '@/data/domain-store'
import { buildDomainSeed } from '@/data/domain-seed'
import type {
  BatchInspectionResult,
  DomainDB,
  DutyLedgerEntry,
  ImportLineResult,
  ImportResult,
  InspectionHistory,
  InspectionOutcome,
  InspectionReceipt,
} from '@/data/domain-types'
import { listRows, resetRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const MODULE_KEY = 'excitation'
const PENDING_STATUS = '待检查'
const LAST_STATUS = '已退出'

// 强励次数限值：一个检查周期内超过该值即视为超限（口径集中在此，页面不做判断）。
export const FORCE_EXCITATION_LIMIT = 10
export const INSPECTION_TEAMS = ['电气一班', '电气二班']
// 从来没有检查记录的存量装置，统一按建账口径补录，业务时间取这一天。
const LEGACY_FALLBACK_DATE = '2026-01-01'
const REJECTED_NOTE = '越权拦截：该装置属{team}，当前由{current}提交，已挡回且未改动该装置'

export const OUTCOME_LABELS: Record<DutyLedgerEntry['outcome'], string> = {
  queued: '进待检查',
  deferred: '超限未到期',
  rejected: '已挡回',
  completed: '检查完成',
  backfilled: '历史补录',
}

export function todayText(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function shiftDays(base: string, days: number): string {
  const date = new Date(`${base}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// 强励次数必须逐台读装置自己的记录：非数字的老脏数据按 0 处理，绝不沿用上一台读到的值。
function readForceCount(row: EntryRow): number {
  const n = Number(String(row['强励次数'] ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

function text(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

// 判重口径（统一一处）：装置编号 trim 后大小写不敏感；EXCI-0001 与 exci-0001 视为同一台。
export function normalizeDeviceCode(code: string): string {
  return code.trim().toUpperCase()
}

let initialized = false

/**
 * 存量数据回填（幂等，缺什么补什么，绝不整批覆盖）：
 * 1. 老台账缺「责任班组」「强励次数」「上次检查日期」字段的，按默认口径补齐；
 * 2. 有实测记录的装置，「上次检查日期」取最近一次实测的业务时间；
 * 3. 从无检查记录的装置，按建账口径补录一条（业务时间 2026-01-01），列入待检查；
 * 4. 技术供水值班台账按历史记录逐条补齐早年缺项。
 */
export function ensureInspectionData(force = false): void {
  if (initialized && !force) {
    return
  }
  const rows = listRows(MODULE_KEY)
  let rowsChanged = false
  const normalized = rows.map((row) => {
    const copy: EntryRow = { ...row }
    if (!text(copy, '责任班组')) {
      copy['责任班组'] = INSPECTION_TEAMS[0]
      rowsChanged = true
    }
    if (!Number.isFinite(Number(String(copy['强励次数'] ?? '').trim()))) {
      copy['强励次数'] = 0
      rowsChanged = true
    }
    if (copy['上次检查日期'] === undefined) {
      copy['上次检查日期'] = ''
      rowsChanged = true
    }
    return copy
  })

  const db = domainDB()
  let dbChanged = false
  const historyById = new Map<string, InspectionHistory>()
  for (const item of db.history) {
    historyById.set(item.id, item)
  }
  const dutyByKey = new Map<string, DutyLedgerEntry>()
  for (const item of db.duty) {
    dutyByKey.set(item.key, item)
  }
  const historyByRow = new Map<number, InspectionHistory[]>()
  for (const item of historyById.values()) {
    const list = historyByRow.get(item.rowId) ?? []
    list.push(item)
    historyByRow.set(item.rowId, list)
  }

  for (const row of normalized) {
    const rowId = Number(row.id)
    const code = text(row, '装置编号')
    const team = text(row, '责任班组') || INSPECTION_TEAMS[0]
    const items = historyByRow.get(rowId) ?? []

    if (items.length === 0) {
      // 从无检查记录：建账补录一条，并把上次检查日期回填为补录业务时间。
      const historyId = `backfill:${rowId}`
      historyById.set(historyId, {
        id: historyId,
        rowId,
        装置编号: code,
        businessDate: LEGACY_FALLBACK_DATE,
        kind: '补录',
        conclusion: '建账补录（无检查记录）',
        可控硅温度: '',
        励磁电压: '',
        remark: '存量装置无任何检查记录，按建账口径补录，列入待检查',
      })
      historyByRow.set(rowId, [...items, historyById.get(historyId)!])
      dbChanged = true
      if (!text(row, '上次检查日期')) {
        row['上次检查日期'] = LEGACY_FALLBACK_DATE
        rowsChanged = true
      }
    } else {
      // 有记录：上次检查日期按最近一次实测的业务时间回填（补录条不参与“最近实测”）。
      const measured = items
        .filter((item) => item.kind === '实测')
        .sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))
      const latest = measured[0] ?? items[0]
      if (!text(row, '上次检查日期')) {
        row['上次检查日期'] = latest.businessDate
        rowsChanged = true
      }
    }

    // 值班台账按条补齐：每条历史记录对应一条值班台账，早年缺项按条补上，不做整批重写。
    for (const item of historyByRow.get(rowId) ?? []) {
      const key = item.kind === '补录' ? `backfill:${rowId}` : `history:${rowId}:${item.businessDate}`
      const existing = dutyByKey.get(key)
      if (!existing) {
        dutyByKey.set(key, {
          key,
          rowId,
          装置编号: code,
          责任班组: team,
          batchNo: 'HISTORY',
          version: 0,
          source: '历史回填',
          outcome: 'backfilled',
          reason: `按业务时间 ${item.businessDate} 回填老台账`,
          businessTime: item.businessDate,
          completedAt: item.businessDate,
          可控硅温度: item.可控硅温度,
          励磁电压: item.励磁电压,
        })
        dbChanged = true
      } else if (!existing.责任班组) {
        existing.责任班组 = team
        dbChanged = true
      }
    }
  }

  if (rowsChanged) {
    saveRows(MODULE_KEY, normalized)
  }
  if (dbChanged) {
    persist(db, historyById, dutyByKey)
  }
  initialized = true
}

function persist(
  db: DomainDB,
  historyById: Map<string, InspectionHistory>,
  dutyByKey: Map<string, DutyLedgerEntry>,
): void {
  db.history = [...historyById.values()].sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))
  db.duty = [...dutyByKey.values()].sort((a, b) => (a.businessTime < b.businessTime ? 1 : -1))
  saveDomainDB(db)
}

function isDateFuture(dateStr: string, today: string): boolean {
  const value = dateStr.trim()
  if (!value || Number.isNaN(Date.parse(value))) {
    // 检查日期缺失或无法解析，按已到期处理，照常进待检查。
    return false
  }
  return value > today
}

// 同一组装置的批次号稳定不变：同选择集合再次提交时拿到同一批次号的新版本，而不是多开一批。
function batchNoOf(ids: number[]): string {
  const signature = [...new Set(ids)].sort((a, b) => a - b).join('-')
  let hash = 0x811c9dc5
  for (let i = 0; i < signature.length; i += 1) {
    hash ^= signature.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `PI-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export type SubmitBatchInput = {
  ids: number[]
  clientToken: string
  operator: string
  team: string
}

export type SubmitBatchOutput = {
  result: BatchInspectionResult
  repeated: boolean
}

/** 勾选多台励磁装置，一次提交检查计划，逐台给出回执。 */
export function submitInspectionBatch(input: SubmitBatchInput): SubmitBatchOutput {
  ensureInspectionData()
  const clientToken = input.clientToken.trim()
  if (!clientToken) {
    throw new Error('缺少本次提交的防重令牌')
  }
  const db = domainDB()

  // 幂等：同一次批量提交被重复触发（同令牌）时只生效一次，直接还原首次结果，不再多排一批。
  const existedBatchNo = db.tokens.batch[clientToken]
  if (existedBatchNo) {
    const existed = db.batches.find((item) => item.batchNo === existedBatchNo)
    if (existed) {
      return { result: existed, repeated: true }
    }
  }

  const uniqueIds = [...new Set(input.ids.map(Number))]
  if (uniqueIds.length === 0) {
    throw new Error('请先勾选要安排检查的励磁装置')
  }
  if (!INSPECTION_TEAMS.includes(input.team)) {
    throw new Error(`当前班组「${input.team}」不在可提交班组范围内`)
  }

  const today = todayText()
  const now = new Date().toISOString()
  const rows = listRows(MODULE_KEY)
  const rowById = new Map(rows.map((row) => [Number(row.id), row]))
  const nextRows = [...rows]

  // 同一选择集合 = 同一个批次号；覆盖旧版本时整版替换，不把两版回执叠加。
  const batchNo = batchNoOf(uniqueIds)
  const previousVersions = db.batches.filter((item) => item.batchNo === batchNo)
  const version = previousVersions.reduce((max, item) => Math.max(max, item.version), 0) + 1

  const receipts: InspectionReceipt[] = []
  for (const rowId of uniqueIds) {
    const row = rowById.get(rowId)
    if (!row) {
      receipts.push({
        rowId,
        装置编号: `#${rowId}`,
        所属机组: '',
        责任班组: '',
        强励次数: 0,
        检查日期: '',
        outcome: 'rejected',
        reason: '装置台账记录不存在，未执行',
      })
      continue
    }

    const code = text(row, '装置编号')
    const unit = text(row, '所属机组')
    const ownerTeam = text(row, '责任班组')
    const count = readForceCount(row)
    const dueDate = text(row, '检查日期')
    const base = {
      rowId,
      装置编号: code,
      所属机组: unit,
      责任班组: ownerTeam,
      强励次数: count,
      检查日期: dueDate,
    }

    // 越权：替别的班组提交的部分挡回来，其余装置照常处理。
    if (ownerTeam && ownerTeam !== input.team) {
      receipts.push({
        ...base,
        outcome: 'rejected',
        reason: REJECTED_NOTE.replace('{team}', ownerTeam).replace('{current}', input.team),
      })
      continue
    }

    const status = String(row.status)
    if (status === LAST_STATUS) {
      receipts.push({
        ...base,
        outcome: 'rejected',
        reason: '装置已退出运行，不安排检查',
      })
      continue
    }

    // 强励次数逐台取自该装置自己的记录；已在待检查队列的不重复排产。
    if (status === PENDING_STATUS) {
      receipts.push({
        ...base,
        outcome: 'queued',
        reason: '该装置已在待检查队列，本次不重复排产',
      })
      continue
    }

    if (count > FORCE_EXCITATION_LIMIT && isDateFuture(dueDate, today)) {
      receipts.push({
        ...base,
        outcome: 'deferred',
        reason: `强励次数${count}已超过${FORCE_EXCITATION_LIMIT}次限值，但检查日期${dueDate}尚未到期，暂不安排（原因：未到计划检查周期，到期前持续跟踪强励次数）`,
      })
      continue
    }

    // 其余照常进待检查。
    const index = nextRows.findIndex((item) => Number(item.id) === rowId)
    if (index >= 0) {
      nextRows[index] = { ...nextRows[index], status: PENDING_STATUS, pending: true, abnormal: false }
    }
    const countNote =
      count > FORCE_EXCITATION_LIMIT
        ? `强励次数${count}超限且检查周期已到，优先安排检查`
        : `强励次数${count}未超${FORCE_EXCITATION_LIMIT}次限值，按计划安排检查`
    receipts.push({ ...base, outcome: 'queued', reason: `${countNote}（检查日期${dueDate || '未登记，按到期处理'}）` })
  }

  const result: BatchInspectionResult = {
    batchNo,
    clientToken,
    version,
    submittedAt: now,
    operator: input.operator,
    team: input.team,
    threshold: FORCE_EXCITATION_LIMIT,
    receipts,
  }

  // 台账写入：先落装置状态，再落批量结果与值班台账。
  saveRows(MODULE_KEY, nextRows)

  db.batches = [...db.batches.filter((item) => item.batchNo !== batchNo), result]
  db.tokens.batch[clientToken] = batchNo
  upsertDutyForBatch(db, batchNo, version, now, receipts)
  saveDomainDB(db)
  return { result, repeated: false }
}

// 值班清单与台账联动：一次批量提交的每一条回执（含挡回、单列）都对应一条值班台账，
// 条数与回执严格相等；整版覆盖时撤掉该批所有版本的「批量提交」条，再写入最新版，绝不两版叠加。
// 「检查完成」是独立来源的留痕，覆盖批次时保留，检查事实不会丢。
function upsertDutyForBatch(
  db: DomainDB,
  batchNo: string,
  version: number,
  now: string,
  receipts: InspectionReceipt[],
): void {
  const retained = db.duty.filter((entry) => entry.batchNo !== batchNo || entry.source !== '批量提交')
  const byKey = new Map(retained.map((entry) => [entry.key, entry]))
  for (const receipt of receipts) {
    const key = `${batchNo}:v${version}:${receipt.rowId}`
    byKey.set(key, {
      key,
      rowId: receipt.rowId,
      装置编号: receipt.装置编号,
      责任班组: receipt.责任班组,
      batchNo,
      version,
      source: '批量提交',
      outcome: receipt.outcome,
      reason: receipt.reason,
      businessTime: now.slice(0, 10),
      completedAt: '',
      可控硅温度: '',
      励磁电压: '',
    })
  }
  db.duty = [...byKey.values()].sort((a, b) => (a.businessTime < b.businessTime ? 1 : -1))
}

export type CompleteInspectionInput = {
  rowId: number
  可控硅温度: string
  励磁电压: string
  conclusion: string
}

export type CompleteInspectionOutput = { ok: boolean; message: string }

/** 检查完成：可控硅温度与励磁电压回写装置台账、检查历史与值班台账。 */
export function completeInspection(
  input: CompleteInspectionInput,
  operator = '值班管理员',
): CompleteInspectionOutput {
  ensureInspectionData()
  const temperature = input.可控硅温度.trim()
  const voltage = input.励磁电压.trim()
  if (!temperature || !voltage || Number.isNaN(Number(temperature)) || Number.isNaN(Number(voltage))) {
    return { ok: false, message: '可控硅温度与励磁电压都必须填写数值，才能完成检查回写' }
  }

  const rows = listRows(MODULE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === input.rowId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${input.rowId} 的励磁装置` }
  }
  const row = rows[index]
  if (String(row.status) !== PENDING_STATUS) {
    return { ok: false, message: `装置当前为「${row.status}」，不在待检查队列，不能完成检查` }
  }

  const today = todayText()
  const next: EntryRow = {
    ...row,
    可控硅温度: temperature,
    励磁电压: voltage,
    上次检查日期: today,
    检查日期: shiftDays(today, 90),
    status: '正常',
    pending: true,
    abnormal: false,
  }
  const nextRows = [...rows]
  nextRows[index] = next
  saveRows(MODULE_KEY, nextRows)

  const db = domainDB()
  const historyId = `${input.rowId}:${today}:实测`
  const historyMap = new Map(db.history.map((item) => [item.id, item]))
  historyMap.set(historyId, {
    id: historyId,
    rowId: input.rowId,
    装置编号: text(row, '装置编号'),
    businessDate: today,
    kind: '实测',
    conclusion: input.conclusion.trim() || '检查合格',
    可控硅温度: temperature,
    励磁电压: voltage,
    remark: `检查人：${operator}`,
  })
  db.history = [...historyMap.values()].sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))

  // 联动值班台账：在该装置最近一条批量排产条上标注完成（覆盖版本时会被新版回执替换，属正常）；
  // 同时永远追加一条「检查完成」来源的独立留痕，覆盖旧版本不会把它清掉。
  const nowIso = new Date().toISOString()
  const dutyMap = new Map(db.duty.map((entry) => [entry.key, entry]))
  const scheduled = [...dutyMap.values()]
    .filter(
      (entry) =>
        entry.rowId === input.rowId &&
        entry.source === '批量提交' &&
        (entry.outcome === 'queued' || entry.outcome === 'deferred'),
    )
    .sort((a, b) => (a.businessTime < b.businessTime ? 1 : -1))[0]
  if (scheduled) {
    scheduled.outcome = 'completed'
    scheduled.reason = '检查完成，温度与电压已回写装置台账'
    scheduled.completedAt = nowIso
    scheduled.可控硅温度 = temperature
    scheduled.励磁电压 = voltage
  }
  const completeKey = `complete:${input.rowId}:${today}`
  if (!dutyMap.has(completeKey)) {
    dutyMap.set(completeKey, {
      key: completeKey,
      rowId: input.rowId,
      装置编号: text(row, '装置编号'),
      责任班组: text(row, '责任班组'),
      batchNo: 'MANUAL',
      version: 0,
      source: '检查完成',
      outcome: 'completed',
      reason: '完成检查回写：温度与电压已回写装置台账',
      businessTime: today,
      completedAt: nowIso,
      可控硅温度: temperature,
      励磁电压: voltage,
    })
  }
  db.duty = [...dutyMap.values()].sort((a, b) => (a.businessTime < b.businessTime ? 1 : -1))
  saveDomainDB(db)
  return { ok: true, message: `${text(row, '装置编号')}检查完成，可控硅温度${temperature}℃、励磁电压${voltage}V 已回写台账` }
}

export type ImportDevicesInput = {
  text: string
  clientToken: string
  operator: string
  team: string
}

/**
 * 批量导入励磁装置。判重口径：装置编号 trim 后大小写不敏感；
 * 文件内先出现的一条为准（文件内重复 + 与台账已存在同号都算重复），重复行只保留一次，不会多出行。
 */
export function importDevices(input: ImportDevicesInput): ImportResult {
  ensureInspectionData()
  const clientToken = input.clientToken.trim()
  if (!clientToken) {
    throw new Error('缺少本次导入的防重令牌')
  }
  const db = domainDB()
  const existedImportNo = db.tokens.import[clientToken]
  if (existedImportNo) {
    const existed = db.imports.find((item) => item.importNo === existedImportNo)
    if (existed) {
      return existed
    }
  }

  const rawLines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const lines = rawLines.length > 0 && rawLines[0].includes('装置编号') ? rawLines.slice(1) : rawLines

  const rows = listRows(MODULE_KEY)
  const existing = new Set(rows.map((row) => normalizeDeviceCode(text(row, '装置编号'))))
  const seenInFile = new Set<string>()
  const lineResults: ImportLineResult[] = []
  const nextRows = [...rows]
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 1000)
  const today = todayText()
  const codePattern = /^[A-Za-z0-9][A-Za-z0-9-]*$/

  lines.forEach((line, offset) => {
    const lineNo = rawLines[0] && rawLines[0].includes('装置编号') ? offset + 2 : offset + 1
    const parts = line.split(/[,，、\t]/).map((part) => part.trim())
    const code = parts[0] ?? ''
    const unit = parts[1] ?? ''
    if (!code || !codePattern.test(code)) {
      lineResults.push({
        lineNo,
        装置编号: code,
        action: 'invalid',
        reason: '装置编号为空或含非法字符（仅允许字母、数字、连字符）',
        rowId: null,
      })
      return
    }
    const key = normalizeDeviceCode(code)
    if (seenInFile.has(key)) {
      lineResults.push({
        lineNo,
        装置编号: code,
        action: 'duplicate',
        reason: '文件内重复装置编号，以先出现的一条为准，本行跳过',
        rowId: null,
      })
      return
    }
    if (existing.has(key)) {
      lineResults.push({
        lineNo,
        装置编号: code,
        action: 'duplicate',
        reason: '台账中已存在同编号装置（大小写不敏感判重），本行跳过',
        rowId: null,
      })
      return
    }
    seenInFile.add(key)
    existing.add(key)
    nextId += 1
    const row: EntryRow = {
      id: nextId,
      status: PENDING_STATUS,
      pending: true,
      abnormal: false,
      装置编号: code.toUpperCase(),
      所属机组: unit || '未分配机组',
      责任班组: input.team,
      励磁电压: '',
      励磁电流: '',
      可控硅温度: '',
      强励次数: 0,
      上次检查日期: '',
      检查日期: today,
      装置状态: '新导入待检查',
    }
    nextRows.push(row)
    lineResults.push({
      lineNo,
      装置编号: code.toUpperCase(),
      action: 'imported',
      reason: '导入成功，按建账口径安排待检查',
      rowId: nextId,
    })
  })

  // 新导入、从无检查记录的装置，走统一的存量回填口径补录历史与值班台账。
  saveRows(MODULE_KEY, nextRows)
  initialized = false
  ensureInspectionData()

  const importNo = `IMP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(db.imports.length + 1)
    .toString()
    .padStart(3, '0')}`
  const result: ImportResult = {
    importNo,
    clientToken,
    importedAt: new Date().toISOString(),
    operator: input.operator,
    team: input.team,
    lines: lineResults,
  }
  const latestDB = domainDB()
  latestDB.imports = [result, ...latestDB.imports]
  latestDB.tokens.import[clientToken] = importNo
  saveDomainDB(latestDB)
  return result
}

// ---- 读取侧：页面、运营概览、两个台账入口都从这里取数，保证口径一致 ----

export function listExcitationRows(): EntryRow[] {
  ensureInspectionData()
  return listRows(MODULE_KEY)
}

export function pendingInspectionCount(): number {
  return listExcitationRows().filter((row) => String(row.status) === PENDING_STATUS).length
}

export function statusCounts(): Record<string, number> {
  const counts: Record<string, number> = { 待检查: 0, 正常: 0, 异常: 0, 已退出: 0 }
  for (const row of listExcitationRows()) {
    const status = String(row.status)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

export function summarizeReceipts(receipts: InspectionReceipt[]): Record<InspectionOutcome, number> {
  const summary: Record<InspectionOutcome, number> = { queued: 0, deferred: 0, rejected: 0 }
  for (const receipt of receipts) {
    summary[receipt.outcome] += 1
  }
  return summary
}

export function listBatchResults(): BatchInspectionResult[] {
  ensureInspectionData()
  return [...domainDB().batches].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
}

export function listInspectionHistory(rowId?: number): InspectionHistory[] {
  ensureInspectionData()
  const items = domainDB().history
  return (rowId ? items.filter((item) => item.rowId === rowId) : items).slice()
}

export type DutyFilter = { outcome?: string; keyword?: string }

export function listDutyLedger(filter: DutyFilter = {}): DutyLedgerEntry[] {
  ensureInspectionData()
  const keyword = filter.keyword?.trim().toUpperCase() ?? ''
  return domainDB()
    .duty.filter((entry) => {
      if (filter.outcome && entry.outcome !== filter.outcome) {
        return false
      }
      if (keyword && !normalizeDeviceCode(entry.装置编号).includes(keyword)) {
        return false
      }
      return true
    })
    .slice()
}

export function listImportResults(): ImportResult[] {
  ensureInspectionData()
  return [...domainDB().imports].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))
}

/** 另存批量结果：导出 CSV，台数与页面回执严格一致（含挡回与单列项）。 */
export function exportBatchResult(result: BatchInspectionResult): { filename: string; content: string } {
  const header = ['批次号', '版本', '装置编号', '所属机组', '责任班组', '强励次数', '检查日期', '处理结果', '原因']
  const lines = [header.join(',')]
  for (const receipt of result.receipts) {
    lines.push(
      [
        result.batchNo,
        `v${result.version}`,
        receipt.装置编号,
        receipt.所属机组,
        receipt.责任班组,
        receipt.强励次数,
        receipt.检查日期,
        OUTCOME_LABELS[receipt.outcome],
        receipt.reason,
      ]
        .map((cell) => String(cell).replace(/"/g, '""'))
        .map((cell) => `"${cell}"`)
        .join(','),
    )
  }
  return {
    filename: `励磁批量检查-${result.batchNo}-v${result.version}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

/** 回到初始示例数据：装置台账与批量检查领域一起重置，再跑一次幂等回填。 */
export function resetInspectionData(): void {
  resetRows(MODULE_KEY)
  const seed: DomainDB = buildDomainSeed()
  saveDomainDB(seed)
  initialized = false
  ensureInspectionData()
}
