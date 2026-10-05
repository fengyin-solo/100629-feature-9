/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 逐台回执的处理结果：queued 进待检查；noted 超限但日期未到单独列出；
// denied 跨班组越权挡回；skipped 不纳入计划；done 已完成检查并回写台账。
export type ReceiptOutcome = 'queued' | 'noted' | 'denied' | 'skipped' | 'done'

export type UnitReceipt = {
  rowId: number
  deviceCode: string
  unit: string
  crew: string
  forceCount: number
  inspectDate: string
  outcome: ReceiptOutcome
  statusBefore: string
  statusAfter: string
  reason: string
  dutyId?: number
}

export type BatchResult = {
  batchNo: string
  clientToken: string
  businessDate: string
  crew: string
  operator: string
  createdAt: string
  // effective=false 表示这次调用是重复触发，只回传首次回执、没有再落一批数据。
  effective: boolean
  receipts: UnitReceipt[]
}

// 技术供水值班台账条目：current 为当班待办（按装置编号覆盖），history 为按业务时间留存的老台账。
export type DutyEntry = {
  id: number
  deviceCode: string
  unit: string
  crew: string
  batchNo: string
  businessDate: string
  type: 'plan' | 'done'
  result: string
  voltage: string
  temp: string
  source: string
  note: string
}
