import type { DomainDB, DutyLedgerEntry, InspectionHistory } from './domain-types'

// 励磁装置批量检查领域的播种数据：只放历次实测记录。
// 「上次检查日期」回填、早年缺项补录、值班台账按条补齐都交给 inspection-service 的幂等回填，
// 这里不直接写补录条目，避免与回填口径两处维护。
const HISTORY: InspectionHistory[] = [
  {
    id: '1001:2026-09-12:实测',
    rowId: 1001,
    装置编号: 'EXCI-1001',
    businessDate: '2026-09-12',
    kind: '实测',
    conclusion: '正常',
    可控硅温度: '61.2',
    励磁电压: '108',
    remark: '季度检查合格',
  },
  {
    id: '1002:2026-09-18:实测',
    rowId: 1002,
    装置编号: 'EXCI-1002',
    businessDate: '2026-09-18',
    kind: '实测',
    conclusion: '正常',
    可控硅温度: '62.8',
    励磁电压: '109',
    remark: '季度检查合格',
  },
  {
    id: '1003:2026-09-20:实测',
    rowId: 1003,
    装置编号: 'EXCI-1003',
    businessDate: '2026-09-20',
    kind: '实测',
    conclusion: '正常',
    可控硅温度: '64.0',
    励磁电压: '110',
    remark: '季度检查合格',
  },
  {
    id: '1004:2026-09-22:实测',
    rowId: 1004,
    装置编号: 'EXCI-1004',
    businessDate: '2026-09-22',
    kind: '实测',
    conclusion: '强励频繁，跟踪观察',
    可控硅温度: '68.5',
    励磁电压: '112',
    remark: '强励次数偏高，列入跟踪',
  },
  {
    id: '1006:2026-09-25:实测',
    rowId: 1006,
    装置编号: 'EXCI-1006',
    businessDate: '2026-09-25',
    kind: '实测',
    conclusion: '正常',
    可控硅温度: '60.1',
    励磁电压: '107',
    remark: '季度检查合格',
  },
  {
    id: '1007:2026-09-26:实测',
    rowId: 1007,
    装置编号: 'EXCI-1007',
    businessDate: '2026-09-26',
    kind: '实测',
    conclusion: '正常',
    可控硅温度: '63.4',
    励磁电压: '110',
    remark: '季度检查合格',
  },
  {
    id: '1008:2026-09-28:实测',
    rowId: 1008,
    装置编号: 'EXCI-1008',
    businessDate: '2026-09-28',
    kind: '实测',
    conclusion: '强励超限，建议缩短检查周期',
    可控硅温度: '69.7',
    励磁电压: '113',
    remark: '强励次数超限',
  },
]

// 老值班台账：按历史实测的业务时间逐条补齐，缺的条目由回填按条补上，不做整批覆盖。
const DUTY: DutyLedgerEntry[] = HISTORY.map((item) => ({
  key: `history:${item.rowId}:${item.businessDate}`,
  rowId: item.rowId,
  装置编号: item.装置编号,
  责任班组: '',
  batchNo: 'HISTORY',
  version: 0,
  source: '历史回填' as const,
  outcome: 'backfilled' as const,
  reason: `按业务时间 ${item.businessDate} 回填老台账`,
  businessTime: item.businessDate,
  completedAt: item.businessDate,
  可控硅温度: item.可控硅温度,
  励磁电压: item.励磁电压,
}))

export function buildDomainSeed(): DomainDB {
  return {
    batches: [],
    history: HISTORY.map((item) => ({ ...item })),
    duty: DUTY.map((item) => ({ ...item })),
    imports: [],
    tokens: { batch: {}, import: {} },
    schemaVersion: 1,
  }
}
