<template>
  <section class="page" data-module="excitation">
    <header class="page-head">
      <div>
        <h2>励磁系统管理</h2>
        <p class="page-desc">
          勾选多台励磁装置一次批量发起检查，逐台回执；强励次数超过 {{ threshold }} 次但检查日期未到的单列，越权他班的挡回。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="openImport">批量导入装置</button>
        <button class="btn" type="button" @click="showHistory = !showHistory">
          {{ showHistory ? '收起检查历史' : '查看检查历史' }}
        </button>
        <button class="btn" type="button" @click="showSaved = !showSaved">
          {{ showSaved ? '收起批量记录' : `已保存批量结果（${savedBatches.length}）` }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出励磁系统清单</button>
        <button class="btn ghost danger" type="button" @click="resetAll">恢复示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">正常装置</span>
        <strong class="stat-value">{{ counts['正常'] ?? 0 }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">异常装置</span>
        <strong class="stat-value warn">{{ counts['异常'] ?? 0 }}</strong>
      </article>
      <article class="stat-card highlight">
        <span class="stat-label">待检查装置（与运营概览联动）</span>
        <strong class="stat-value">{{ counts['待检查'] ?? 0 }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已退出</span>
        <strong class="stat-value">{{ counts['已退出'] ?? 0 }}</strong>
      </article>
    </div>

    <div class="batch-bar">
      <div class="batch-bar-left">
        <label class="team-switch">
          当前值班班组
          <select v-model="currentTeam">
            <option v-for="team in teams" :key="team" :value="team">{{ team }}</option>
          </select>
        </label>
        <span class="select-hint">整组处理：</span>
        <button
          v-for="team in teams"
          :key="team"
          class="btn mini"
          type="button"
          @click="selectGroup(team)"
        >
          全选{{ team }}
        </button>
        <button class="btn mini ghost" type="button" @click="selectEligible">全选本班可检</button>
        <button class="btn mini ghost" type="button" @click="selected.clear()">清空勾选</button>
      </div>
      <div class="batch-bar-right">
        <span class="selected-count">已勾选 <strong>{{ selected.size }}</strong> 台</span>
        <button class="btn primary" type="button" :disabled="!selected.size" @click="submitBatch()">
          批量发起检查
        </button>
        <button
          class="btn"
          type="button"
          :disabled="!lastBatch"
          title="用同一个防重令牌再触发一次，验证只生效一次"
          @click="repeatSubmit"
        >
          重复触发（验幂等）
        </button>
      </div>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">勾选</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-other-team': !isOwnTeam(row) }">
          <td class="col-check">
            <input
              type="checkbox"
              :checked="selected.has(Number(row.id))"
              :disabled="String(row.status) === '已退出'"
              @change="toggleRow(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '强励次数'">
              <span :class="{ 'force-over': Number(row[column]) > threshold }">{{ row[column] }}</span>
            </template>
            <template v-else-if="column === '责任班组'">
              {{ row[column] }}
              <span v-if="!isOwnTeam(row)" class="tag tag-reject">他班</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span :class="['status-pill', `status-${String(row.status)}`]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-if="String(row.status) === '待检查'"
              class="link"
              type="button"
              @click="openComplete(row)"
            >
              完成检查并回写
            </button>
            <button v-else class="link" type="button" @click="runAction('提交检查', row)">提交检查</button>
            <button class="link" type="button" @click="runAction('标记异常', row)">标记异常</button>
            <button class="link danger-text" type="button" @click="runAction('退出运行', row)">退出运行</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无励磁装置数据，可先批量导入</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 台励磁装置；待检查台数与运营概览、技术供水值班台账实时一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 批量提交回执 -->
    <div v-if="batchResult" class="result-panel">
      <div class="result-head">
        <div>
          <h3>
            批量检查计划 · 批次 {{ batchResult.batchNo }} · 第 v{{ batchResult.version }} 版
            <span class="muted">{{ submittedAtText }}</span>
            <span v-if="lastSubmitRepeated" class="tag tag-info">重复触发，返回首次结果，未重复生效</span>
          </h3>
          <p class="muted">
            提交人 {{ batchResult.operator }}（{{ batchResult.team }}）· 共 {{ batchResult.receipts.length }} 台：
            进待检查 <strong>{{ summary.queued }}</strong> ·
            <span class="warn">超限未到期单列 <strong>{{ summary.deferred }}</strong></span> ·
            <span class="danger-text">挡回 <strong>{{ summary.rejected }}</strong></span>
          </p>
        </div>
        <div class="result-actions">
          <button class="btn mini" type="button" @click="saveBatchAgain">另存本批结果(CSV)</button>
          <button class="btn mini primary" type="button" @click="resubmitSameSelection">
            同组再提交（覆盖为最新版）
          </button>
          <button class="btn mini ghost" type="button" @click="batchResult = null">关闭</button>
        </div>
      </div>
      <table class="data-table inner-table">
        <thead>
          <tr>
            <th>装置编号</th><th>所属机组</th><th>责任班组</th><th>强励次数</th><th>检查日期</th><th>处理结果</th><th>原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="receipt in batchResult.receipts" :key="receipt.rowId" :class="`outcome-${receipt.outcome}`">
            <td>{{ receipt.装置编号 }}</td>
            <td>{{ receipt.所属机组 }}</td>
            <td>{{ receipt.责任班组 }}</td>
            <td><span :class="{ 'force-over': receipt.强励次数 > batchResult.threshold }">{{ receipt.强励次数 }}</span></td>
            <td>{{ receipt.检查日期 || '—' }}</td>
            <td><span :class="['outcome-pill', `outcome-${receipt.outcome}`]">{{ outcomeLabel(receipt.outcome) }}</span></td>
            <td class="reason-cell">{{ receipt.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 完成检查回写表单 -->
    <div v-if="completeTarget" class="modal-mask" @click.self="completeTarget = null">
      <div class="modal-card">
        <h3>完成检查并回写台账 · {{ completeTarget['装置编号'] }}</h3>
        <p class="muted">提交后可控硅温度与励磁电压回写装置台账，运营概览待检查台数 -1，并联动技术供水值班台账。</p>
        <label class="form-row">
          <span>可控硅温度（℃）</span>
          <input v-model="completeForm.temperature" placeholder="如 62.5" />
        </label>
        <label class="form-row">
          <span>励磁电压（V）</span>
          <input v-model="completeForm.voltage" placeholder="如 110" />
        </label>
        <label class="form-row">
          <span>检查结论</span>
          <input v-model="completeForm.conclusion" placeholder="如 检查合格" />
        </label>
        <p v-if="completeError" class="error-text">{{ completeError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="completeTarget = null">取消</button>
          <button class="btn primary" type="button" @click="confirmComplete">确认完成并回写</button>
        </div>
      </div>
    </div>

    <!-- 批量导入 -->
    <div v-if="showImport" class="modal-mask" @click.self="showImport = false">
      <div class="modal-card wide">
        <h3>批量导入励磁装置</h3>
        <p class="muted">
          每行一台：<code>装置编号,所属机组</code>（可带表头）。判重按装置编号（去空格、不区分大小写），
          文件内先出现的为准，与台账同号也算重复；重复导入只保留一次，不会多出行。
        </p>
        <textarea v-model="importText" class="import-area" placeholder="装置编号,所属机组&#10;EXCI-2001,9号机组&#10;exci-2001,9号机组（与上行重复，将跳过）"></textarea>
        <p v-if="importMessage" class="error-text">{{ importMessage }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="showImport = false">关闭</button>
          <button class="btn primary" type="button" @click="confirmImport">导入并判重</button>
        </div>
        <table v-if="importResult" class="data-table inner-table">
          <thead>
            <tr><th>行号</th><th>装置编号</th><th>结果</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="line in importResult.lines" :key="line.lineNo" :class="`import-${line.action}`">
              <td>{{ line.lineNo }}</td>
              <td>{{ line.装置编号 || '—' }}</td>
              <td>{{ importActionLabel(line.action) }}</td>
              <td class="reason-cell">{{ line.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 检查历史 -->
    <div v-if="showHistory" class="sub-panel">
      <h3>检查历史（实测 + 建账补录）</h3>
      <table class="data-table inner-table">
        <thead>
          <tr><th>业务时间</th><th>装置编号</th><th>类型</th><th>结论</th><th>可控硅温度</th><th>励磁电压</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in history" :key="item.id">
            <td>{{ item.businessDate }}</td>
            <td>{{ item.装置编号 }}</td>
            <td><span :class="['tag', item.kind === '补录' ? 'tag-deferred' : 'tag-info']">{{ item.kind }}</span></td>
            <td>{{ item.conclusion }}</td>
            <td>{{ item.可控硅温度 || '—' }}</td>
            <td>{{ item.励磁电压 || '—' }}</td>
            <td class="reason-cell">{{ item.remark }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 另存的批量结果 -->
    <div v-if="showSaved" class="sub-panel">
      <h3>另存的批量结果（覆盖旧版时只保留最近生效的一版）</h3>
      <table class="data-table inner-table">
        <thead>
          <tr><th>批次号</th><th>版本</th><th>提交时间</th><th>提交班组</th><th>台数</th><th>进待检查</th><th>单列</th><th>挡回</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="batch in savedBatches" :key="`${batch.batchNo}-${batch.version}`">
            <td>{{ batch.batchNo }}</td>
            <td>v{{ batch.version }}</td>
            <td>{{ batch.submittedAt.slice(0, 19).replace('T', ' ') }}</td>
            <td>{{ batch.team }}</td>
            <td>{{ batch.receipts.length }}</td>
            <td>{{ summarizeReceipts(batch.receipts).queued }}</td>
            <td class="warn">{{ summarizeReceipts(batch.receipts).deferred }}</td>
            <td class="danger-text">{{ summarizeReceipts(batch.receipts).rejected }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="batchResult = batch; lastSubmitRepeated = false">查看回执</button>
              <button class="link" type="button" @click="downloadBatch(batch)">另存CSV</button>
            </td>
          </tr>
          <tr v-if="!savedBatches.length">
            <td colspan="9" class="empty-state">还没有批量提交记录</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  FORCE_EXCITATION_LIMIT,
  INSPECTION_TEAMS,
  OUTCOME_LABELS,
  completeInspection,
  exportBatchResult,
  importDevices,
  listBatchResults,
  listExcitationRows,
  listInspectionHistory,
  resetInspectionData,
  statusCounts,
  submitInspectionBatch,
  summarizeReceipts as summarizeReceiptsFn,
} from '@/api/inspection-service'
import { useSessionStore } from '@/stores/session'
import type { BatchInspectionResult, ImportResult, InspectionOutcome } from '@/data/domain-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('excitation')
const columns = meta.fields
const filterFields = ['装置编号', '所属机组', '责任班组']
const threshold = FORCE_EXCITATION_LIMIT
const teams = INSPECTION_TEAMS
const summarizeReceipts = summarizeReceiptsFn

const session = useSessionStore()
const currentTeam = ref(session.team)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = reactive<Record<string, string>>({})
const selected = reactive(new Set<number>())
const counts = ref<Record<string, number>>({})

const batchResult = ref<BatchInspectionResult | null>(null)
const lastBatch = ref<BatchInspectionResult | null>(null)
const lastSubmitRepeated = ref(false)
let draftToken = ''

const showImport = ref(false)
const importText = ref('')
const importResult = ref<ImportResult | null>(null)
const importMessage = ref('')

const completeTarget = ref<EntryRow | null>(null)
const completeForm = reactive({ temperature: '', voltage: '', conclusion: '' })
const completeError = ref('')

const showHistory = ref(false)
const showSaved = ref(false)
const history = ref(listInspectionHistory())
const savedBatches = ref(listBatchResults())

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const summary = computed(() =>
  batchResult.value ? summarizeReceipts(batchResult.value.receipts) : { queued: 0, deferred: 0, rejected: 0 },
)
const submittedAtText = computed(() =>
  batchResult.value ? batchResult.value.submittedAt.slice(0, 19).replace('T', ' ') : '',
)

function isOwnTeam(row: EntryRow): boolean {
  return String(row['责任班组'] ?? '') === currentTeam.value
}

function makeToken(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toggleRow(id: number) {
  if (selected.has(id)) {
    selected.delete(id)
  } else {
    selected.add(id)
  }
}

function selectGroup(team: string) {
  selected.clear()
  for (const row of rows.value) {
    if (String(row['责任班组']) === team && String(row.status) !== '已退出') {
      selected.add(Number(row.id))
    }
  }
}

function selectEligible() {
  selected.clear()
  for (const row of rows.value) {
    if (isOwnTeam(row) && String(row.status) !== '已退出') {
      selected.add(Number(row.id))
    }
  }
}

function submitBatch(reuseToken = false): void {
  errorMessage.value = ''
  session.setTeam(currentTeam.value)
  if (!selected.size) {
    errorMessage.value = '请先勾选至少一台励磁装置'
    return
  }
  if (!reuseToken || !draftToken) {
    draftToken = makeToken('batch')
  }
  try {
    const output = submitInspectionBatch({
      ids: [...selected],
      clientToken: draftToken,
      operator: session.operator,
      team: currentTeam.value,
    })
    batchResult.value = output.result
    lastBatch.value = output.result
    lastSubmitRepeated.value = output.repeated
    reload()
    savedBatches.value = listBatchResults()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批量提交失败'
  }
}

function repeatSubmit(): void {
  // 同一勾选、同一令牌再触发一次：服务层应直接返回首次结果，不新增任何待检查装置。
  submitBatch(true)
}

function resubmitSameSelection(): void {
  if (!batchResult.value) {
    return
  }
  selected.clear()
  for (const receipt of batchResult.value.receipts) {
    selected.add(receipt.rowId)
  }
  // 覆盖旧版本走新令牌：同选择集合拿到同一批次号的新版本，旧版整版被替换而不是叠加。
  draftToken = makeToken('batch')
  submitBatch(true)
}

function saveBatchAgain(): void {
  if (batchResult.value) {
    downloadBatch(batchResult.value)
  }
}

function downloadBatch(batch: BatchInspectionResult): void {
  const { filename, content } = exportBatchResult(batch)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function outcomeLabel(outcome: InspectionOutcome): string {
  return OUTCOME_LABELS[outcome]
}

function openComplete(row: EntryRow): void {
  completeTarget.value = row
  completeForm.temperature = ''
  completeForm.voltage = ''
  completeForm.conclusion = ''
  completeError.value = ''
}

function confirmComplete(): void {
  if (!completeTarget.value) {
    return
  }
  const result = completeInspection(
    {
      rowId: Number(completeTarget.value.id),
      可控硅温度: completeForm.temperature,
      励磁电压: completeForm.voltage,
      conclusion: completeForm.conclusion,
    },
    session.operator,
  )
  if (!result.ok) {
    completeError.value = result.message
    return
  }
  completeTarget.value = null
  errorMessage.value = result.message
  reload()
  history.value = listInspectionHistory()
  savedBatches.value = listBatchResults()
}

function openImport(): void {
  showImport.value = true
  importText.value = ''
  importResult.value = null
  importMessage.value = ''
}

function confirmImport(): void {
  importMessage.value = ''
  try {
    importResult.value = importDevices({
      text: importText.value,
      clientToken: makeToken('import'),
      operator: session.operator,
      team: currentTeam.value,
    })
    reload()
    history.value = listInspectionHistory()
    savedBatches.value = listBatchResults()
  } catch (error) {
    importMessage.value = error instanceof Error ? error.message : '导入失败'
  }
}

function importActionLabel(action: 'imported' | 'duplicate' | 'invalid'): string {
  if (action === 'imported') return '已导入'
  if (action === 'duplicate') return '重复跳过'
  return '无效行'
}

function runAction(action: string, row: EntryRow): void {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function exportRows(): void {
  downloadEntries(meta.key)
}

function resetAll(): void {
  resetInspectionData()
  selected.clear()
  batchResult.value = null
  lastBatch.value = null
  reload()
  history.value = listInspectionHistory()
  savedBatches.value = listBatchResults()
}

function resetFilters(): void {
  for (const key of Object.keys(filters)) {
    filters[key] = ''
  }
  reload()
}

function reload(): void {
  const keywordFields = ['装置编号', '所属机组', '责任班组']
  let list = listExcitationRows()
  for (const field of keywordFields) {
    const keyword = filters[field]?.trim()
    if (keyword) {
      list = list.filter((row) => String(row[field] ?? '').includes(keyword))
    }
  }
  rows.value = list
  total.value = list.length
  counts.value = statusCounts()
}

onMounted(reload)
</script>

<style scoped>
.danger { color: #b42318; }
.danger-text { color: #b42318; }
.warn { color: #b54708; }
.muted { color: var(--muted); font-size: 12px; font-weight: normal; }
.mini { padding: 4px 10px; font-size: 12px; }
.highlight { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
.batch-bar {
  display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
  background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px;
}
.batch-bar-left, .batch-bar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.team-switch { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.team-switch select { padding: 4px 8px; }
.select-hint { font-size: 12px; color: var(--muted); }
.selected-count { font-size: 13px; }
.selected-count strong { color: var(--brand); font-size: 16px; }
.col-check { width: 40px; text-align: center; }
.force-over { color: #b42318; font-weight: 700; }
.row-other-team { background: #faf6f6; }
.tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 4px; }
.tag-reject { background: #fee4e2; color: #b42318; }
.tag-deferred { background: #fef3c7; color: #b54708; }
.tag-info { background: #e0edff; color: #1f6feb; }
.status-pill, .outcome-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.status-待检查 { background: #fef3c7; color: #b54708; }
.status-正常 { background: #dcfce7; color: #166534; }
.status-异常 { background: #fee4e2; color: #b42318; }
.status-已退出 { background: #e5e7eb; color: #475569; }
.outcome-queued { background: #e0edff; color: #1f6feb; }
.outcome-deferred { background: #fef3c7; color: #b54708; }
.outcome-rejected { background: #fee4e2; color: #b42318; }
.outcome-completed { background: #dcfce7; color: #166534; }
.outcome-backfilled { background: #f1f5f9; color: #475569; }
tr.outcome-deferred { background: #fffdf5; }
tr.outcome-rejected { background: #fef7f7; }
.result-panel, .sub-panel {
  background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 14px;
}
.result-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.result-head h3 { margin: 0 0 4px; font-size: 15px; }
.result-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.inner-table { margin-top: 8px; }
.reason-cell { color: #475569; font-size: 12px; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 20;
}
.modal-card { background: #fff; border-radius: 10px; padding: 18px 20px; width: 420px; max-height: 86vh; overflow: auto; }
.modal-card.wide { width: 680px; }
.modal-card h3 { margin: 0 0 6px; }
.form-row { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; font-size: 13px; }
.form-row input { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.import-area { width: 100%; height: 120px; border: 1px solid var(--border); border-radius: 6px; padding: 8px; font-family: monospace; }
tr.import-duplicate { background: #fffdf5; }
tr.import-invalid { background: #fef7f7; }
.sub-panel h3 { margin: 0 0 8px; font-size: 14px; }
</style>
