/** 励磁装置批量检查领域的公共类型：批量回执、检查历史、值班台账、导入结果都在这里收口。 */

// 单台装置在一次批量提交里的去向：
// queued   —— 进入待检查
// deferred —— 强励次数超限但检查日期未到，单独列管
// rejected —— 越权替别的班组提交，被挡回
export type InspectionOutcome = 'queued' | 'deferred' | 'rejected'

// 值班台账条目的去向在三类回执之外，还要能表达「已检查完成」和「早年缺项补录」。
export type DutyOutcome = InspectionOutcome | 'completed' | 'backfilled'

export type InspectionReceipt = {
  rowId: number
  装置编号: string
  所属机组: string
  责任班组: string
  强励次数: number
  检查日期: string
  outcome: InspectionOutcome
  reason: string
}

export type BatchInspectionResult = {
  batchNo: string
  clientToken: string
  version: number
  submittedAt: string
  operator: string
  team: string
  threshold: number
  receipts: InspectionReceipt[]
}

export type InspectionHistory = {
  // 自然键：实测用 `${rowId}:${businessDate}:实测`，补录用 `backfill:${rowId}`，保证回填不重复造条。
  id: string
  rowId: number
  装置编号: string
  businessDate: string
  kind: '实测' | '补录'
  conclusion: string
  可控硅温度: string
  励磁电压: string
  remark: string
}

export type DutyLedgerEntry = {
  // 自然键：批量提交 `${batchNo}:${rowId}`；历史回填 `history:${rowId}:${date}`；补录 `backfill:${rowId}`。
  key: string
  rowId: number
  装置编号: string
  责任班组: string
  batchNo: string
  version: number
  source: '批量提交' | '检查完成' | '历史回填'
  outcome: DutyOutcome
  reason: string
  businessTime: string
  completedAt: string
  可控硅温度: string
  励磁电压: string
}

export type ImportLineResult = {
  lineNo: number
  装置编号: string
  action: 'imported' | 'duplicate' | 'invalid'
  reason: string
  rowId: number | null
}

export type ImportResult = {
  importNo: string
  clientToken: string
  importedAt: string
  operator: string
  team: string
  lines: ImportLineResult[]
}

export type TokenIndex = {
  // 令牌 -> 批次号/导入号：同一次提交被重复触发时据此直接还原首次结果。
  batch: Record<string, string>
  import: Record<string, string>
}

export type DomainDB = {
  batches: BatchInspectionResult[]
  history: InspectionHistory[]
  duty: DutyLedgerEntry[]
  imports: ImportResult[]
  tokens: TokenIndex
  schemaVersion: number
}
