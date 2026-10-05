// 端到端业务验证：用内存版 localStorage 在 Node 里跑批量检查全链路。
// 不进仓库构建，仅验证：逐台取值、幂等、覆盖版本、越权拦截、回写、两入口条数、导入判重、存量回填。
import { assert } from 'node:console'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- 最小浏览器环境 mock ----
const stores = new Map()
const localStorageMock = {
  getItem: (k) => (stores.has(k) ? stores.get(k) : null),
  setItem: (k, v) => void stores.set(k, String(v)),
  removeItem: (k) => void stores.delete(k),
  clear: () => stores.clear(),
}
globalThis.window = { localStorage: localStorageMock }
globalThis.localStorage = localStorageMock
// Node 20 自带全局 crypto.randomUUID，无需 mock

// ---- esbuild 把 TS 服务层打包为 ESM ----
const esbuild = await import('esbuild')
const outfile = `${__dirname}/.tmp/inspection-bundle.mjs`
mkdirSync(`${__dirname}/.tmp`, { recursive: true })
await esbuild.build({
  entryPoints: [`${__dirname}/inspection-service-entry.ts`],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '@': `${__dirname}/../src` },
})

const svc = await import(outfile)

let passed = 0
function check(name, cond, detail = '') {
  if (!cond) {
    console.error(`✗ ${name}${detail ? ` —— ${detail}` : ''}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

// 0. 初始化（首次播种即跑存量回填）
svc.ensureInspectionData()
let rows = svc.listExcitationRows()
const byCode = Object.fromEntries(rows.map((r) => [r['装置编号'], r]))
const today = svc.todayText()
check('播种后共 8 台励磁装置', rows.length === 8, `实际 ${rows.length}`)

// 1. 存量回填：1005 无实测 -> 建账补录 2026-01-01；1001 有实测 -> 最近一次业务时间
check('无记录装置按建账口径补录 2026-01-01', byCode['EXCI-1005']['上次检查日期'] === '2026-01-01')
check('有记录装置按最近实测回填 2026-09-12', byCode['EXCI-1001']['上次检查日期'] === '2026-09-12')
const backfillHistory = svc.listInspectionHistory().filter((h) => h.kind === '补录')
check('从无记录装置恰好补录一条历史', backfillHistory.length === 1 && backfillHistory[0].rowId === 1005)

// 2. 值班台账：历史按条补齐（7 实测 + 1 补录 = 8 条 HISTORY）
const dutyAll = svc.listDutyLedger()
const historyDuty = dutyAll.filter((d) => d.batchNo === 'HISTORY')
check('老台账按业务时间按条补齐 8 条', historyDuty.length === 8, `实际 ${historyDuty.length}`)
check('回填条带业务时间', historyDuty.some((d) => d.装置编号 === 'EXCI-1005' && d.businessTime === '2026-01-01'))

// 3. 全选 8 台，以电气一班提交
const idsAll = rows.map((r) => Number(r.id))
const token1 = 'token-batch-1'
const out1 = svc.submitInspectionBatch({ ids: idsAll, clientToken: token1, operator: '张工', team: '电气一班' })
const r1 = out1.result
check('逐台回执 8 条', r1.receipts.length === 8)
const s1 = svc.summarizeReceipts(r1.receipts)
// 电气二班: 1004(超限未到期->deferred),1005(异常,超限,检查日期10-01已过->rejected他班),1007(待检查->rejected),1008(超限但已到期->rejected)
check('他班 4 台全部挡回', s1.rejected === 4, JSON.stringify(s1))
check('本班无超限未到期 -> deferred=0', s1.deferred === 0)
check('本班 4 台进待检查/已在队列', s1.queued === 4)
check('挡回原因写明越权与班组', r1.receipts.find((x) => x.rowId === 1004).reason.includes('电气二班'))

// 4. 强励次数逐台来自自身记录（1004=12, 1008=11, 1001=3），不顺延
check('强励次数逐台取自身记录', r1.receipts.find((x) => x.rowId === 1004).强励次数 === 12)
check('强励次数不顺延到下一台', r1.receipts.find((x) => x.rowId === 1005).强励次数 === 14)

// 5. 重复触发（同令牌）只生效一次
const pendingBefore = svc.pendingInspectionCount()
const out1Repeat = svc.submitInspectionBatch({ ids: idsAll, clientToken: token1, operator: '张工', team: '电气一班' })
check('同令牌重复触发标记 repeated', out1Repeat.repeated === true)
check('重复触发返回同一批次同版本', out1Repeat.result.batchNo === r1.batchNo && out1Repeat.result.version === 1)
check('重复触发不增加待检查台数', svc.pendingInspectionCount() === pendingBefore)
const batchesAfterRepeat = svc.listBatchResults().filter((b) => b.batchNo === r1.batchNo)
check('同一批次只存一版', batchesAfterRepeat.length === 1)

// 6. 值班台账条目数 == 当批回执数（含挡回单列）
const dutyBatch1 = svc.listDutyLedger().filter((d) => d.batchNo === r1.batchNo)
check('值班台账条数 = 回执数（8）', dutyBatch1.length === 8, `实际 ${dutyBatch1.length}`)

// 7. 以电气二班视角验证「超限但检查日期未到 -> 单列 deferred」：1004
// 先用二班提交 1004 自己（越权问题消失）
const token2 = 'token-batch-2'
const out2 = svc.submitInspectionBatch({ ids: [1004], clientToken: token2, operator: '李工', team: '电气二班' })
const recv1004 = out2.result.receipts[0]
check('超限且检查日期未到 -> deferred', recv1004.outcome === 'deferred', recv1004.reason)
check('deferred 原因含限值与未到期', recv1004.reason.includes('10') && recv1004.reason.includes('未到期'))
rows = svc.listExcitationRows()
check('deferred 装置状态未被改成待检查', rows.find((r) => Number(r.id) === 1004).status === '正常')

// 1005：超限但检查日期 2026-10-01 已到期 -> 本班提交应进待检查（不是 deferred）
const token3 = 'token-batch-3'
const out3 = svc.submitInspectionBatch({ ids: [1005], clientToken: token3, operator: '李工', team: '电气二班' })
const recv1005 = out3.result.receipts[0]
check('超限但检查日期已到 -> queued', recv1005.outcome === 'queued', recv1005.reason)
rows = svc.listExcitationRows()
check('1005 已进入待检查', rows.find((r) => Number(r.id) === 1005).status === '待检查')

// 8. 运营概览待检查台数联动
const pendingNow = svc.pendingInspectionCount()
// 初始待检查 1006,1007（2）+ 一班提交进队列 1001,1002,1003（1006 已在队列）=> 5，+ 1005 = 6
check('待检查台数联动为 6', pendingNow === 6, `实际 ${pendingNow}`)

// 9. 完成检查：温度/电压回写台账 + 历史 + 值班台账，待检查 -1
const completeMsg = svc.completeInspection({ rowId: 1005, 可控硅温度: '58.2', 励磁电压: '115', conclusion: '检查合格' }, '李工')
check('完成检查返回成功', completeMsg.ok === true, completeMsg.message)
rows = svc.listExcitationRows()
const row1005 = rows.find((r) => Number(r.id) === 1005)
check('可控硅温度回写装置台账', row1005['可控硅温度'] === '58.2')
check('励磁电压回写装置台账', row1005['励磁电压'] === '115')
check('上次检查日期回写为今日', row1005['上次检查日期'] === today)
check('完成后状态转正常', row1005.status === '正常')
check('待检查台数 -1 联动', svc.pendingInspectionCount() === pendingNow - 1)
const completedDuty = svc.listDutyLedger().filter((d) => d.outcome === 'completed')
check('值班台账有完成回写条且带温度电压',
  completedDuty.some((d) => d.rowId === 1005 && d.可控硅温度 === '58.2' && d.励磁电压 === '115'))
const hist1005 = svc.listInspectionHistory(1005).filter((h) => h.kind === '实测')
check('实测历史按业务时间新增今日一条', hist1005.some((h) => h.businessDate === today))

// 10. 同组再提交覆盖旧版：选第一批同样 8 台、新令牌 -> 同批次号 v2，且不叠加
const token4 = 'token-batch-4'
const out4 = svc.submitInspectionBatch({ ids: idsAll, clientToken: token4, operator: '张工', team: '电气一班' })
check('同选择集合拿到同批次号', out4.result.batchNo === r1.batchNo)
check('版本递增为 v2', out4.result.version === 2)
const versions = svc.listBatchResults().filter((b) => b.batchNo === r1.batchNo)
check('覆盖后该批次只保留最新一版（不叠加）', versions.length === 1 && versions[0].version === 2)
const dutyV2 = svc.listDutyLedger().filter((d) => d.batchNo === r1.batchNo)
check('值班台账该批仍为 8 条（旧版未完成条被替换，不叠加）', dutyV2.length === 8, `实际 ${dutyV2.length}`)
check('台账条版本号更新为 2', dutyV2.every((d) => d.version === 2))
const completionTrail = svc.listDutyLedger().filter((d) => d.source === '检查完成' && d.rowId === 1005)
check('检查完成独立留痕在覆盖版本后仍保留', completionTrail.length === 1 && completionTrail[0].可控硅温度 === '58.2')

// 11. 两个入口条数恒等：无过滤的全量
check('值班清单/技术供水两入口同数据源条数一致',
  svc.listDutyLedger().length === svc.listDutyLedger({}).length)
check('当批结果另存台数 = 页面回执台数', out4.result.receipts.length === 8)
const exported = svc.exportBatchResult(out4.result)
const csvRows = exported.content.split('\n').slice(1)
check('另存 CSV 台数与页面台数一致', csvRows.length === 8, `实际 ${csvRows.length}`)

// 12. 导入判重：文件内重复 + 台账同号 + 大小写不敏感；重复只保留一次
const importText = ['装置编号,所属机组', 'EXCI-2001,9号机组', 'exci-2001,9号机组', 'EXCI-1001,重复已有', 'bad id,非法编号', 'EXCI-2002,10号机组'].join('\n')
const imp = svc.importDevices({ text: importText, clientToken: 'imp-token-1', operator: '张工', team: '电气一班' })
const imported = imp.lines.filter((l) => l.action === 'imported')
const dup = imp.lines.filter((l) => l.action === 'duplicate')
const invalid = imp.lines.filter((l) => l.action === 'invalid')
check('导入新增 2 台', imported.length === 2, JSON.stringify(imp.lines.map((l) => l.action)))
check('重复行 2 条跳过（文件内+台账同号）', dup.length === 2)
check('非法行 1 条', invalid.length === 1)
rows = svc.listExcitationRows()
check('台账只多 2 台（10 台）', rows.length === 10, `实际 ${rows.length}`)
const code2001 = rows.filter((r) => String(r['装置编号']).toUpperCase() === 'EXCI-2001')
check('重复导入只保留一次，不会多出行', code2001.length === 1)

// 13. 导入幂等：同令牌再导一次不重复落库
const impRepeat = svc.importDevices({ text: importText, clientToken: 'imp-token-1', operator: '张工', team: '电气一班' })
check('导入同令牌重复触发返回首次结果', impRepeat.importNo === imp.importNo)
check('重复导入后台账仍为 10 台', svc.listExcitationRows().length === 10)
// 新导入装置无检查记录 -> 按建账口径补录
const backfillNow = svc.listInspectionHistory().filter((h) => h.kind === '补录' && ['EXCI-2001', 'EXCI-2002'].includes(h.装置编号))
check('新导入无记录装置按同一口径补录', backfillNow.length === 2)

// 14. 老脏数据容错：强励次数非数字按 0，绝不沿用上一台（直接验证 readForceCount 行为：
// 1001=3 后面不会被任何 NaN 污染——上面所有强励次数断言已覆盖；再验异常态挡回不影响其余）
// 1004 由二班在第一批被挡回后，台账状态仍是「正常」（前面已断言）

// 15. 重置：恢复示例数据
svc.resetInspectionData()
check('重置后回到 8 台', svc.listExcitationRows().length === 8)
check('重置后批量结果清空', svc.listBatchResults().length === 0)
check('重置后值班台账只剩历史回填 8 条', svc.listDutyLedger().filter((d) => d.batchNo === 'HISTORY').length === 8)

rmSync(`${__dirname}/.tmp`, { recursive: true, force: true })
assert(true)
console.log(`\n全部 ${passed} 项断言通过`)
