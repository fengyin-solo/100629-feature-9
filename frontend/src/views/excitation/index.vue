<template>
  <section class="page" data-module="excitation">
    <header class="page-head">
      <div>
        <h2>励磁系统管理</h2>
        <p class="page-desc">
          强励次数超过 {{ FORCE_LIMIT }} 次即应安排检查；可勾选多台一次提交批量检查计划，逐台给出回执。业务日期：{{ BUSINESS_DATE }}，检查周期 {{ INSPECT_CYCLE_MONTHS }} 个月。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!selected.length || submitting" @click="submitBatch">
          批量发起检查（已选 {{ selected.length }} 台）
        </button>
        <button class="btn" type="button" @click="triggerImport">导入装置（按装置编号去重）</button>
        <button class="btn ghost" type="button" @click="downloadTemplate">下载导入模板</button>
        <button class="btn" type="button" @click="exportRows">导出励磁系统清单</button>
        <button class="btn ghost" type="button" @click="openArchive">批量结果存档</button>
        <input ref="fileInput" class="hidden-input" type="file" accept=".csv" @change="onFilePicked" />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
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
          <th class="col-check">
            <input
              type="checkbox"
              :checked="allVisibleSelected"
              :disabled="submitting"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              v-model.number="selected"
              type="checkbox"
              :value="Number(row.id)"
              :disabled="submitting"
            />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '强励次数'">
              <span :class="{ 'over-limit': forceOf(row) > FORCE_LIMIT }">{{ row[column] ?? '—' }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="isNoted(row)" class="tag tag-warn" title="超限但检查日期未到">超限单列</span>
            <span v-else-if="forceOf(row) > FORCE_LIMIT" class="tag tag-danger">超限</span>
            <span v-else-if="String(row['所属班组']) !== session.crew" class="tag tag-muted">别班组</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无励磁系统数据，可先导入或登记励磁装置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条励磁系统记录</span>
      <span v-if="notice" class="error-text">{{ notice }}</span>
    </footer>

    <!-- 逐台回执 -->
    <div v-if="summary" class="modal-mask" @click.self="summary = null">
      <div class="modal">
        <header class="modal-head">
          <h3>批量检查回执 · {{ summary.batch.batchNo }}</h3>
          <button class="link" type="button" @click="downloadBatch(summary!.batch)">另存结果 CSV</button>
        </header>
        <p class="modal-tip">
          <template v-if="summary.batch.effective">
            本次提交生效：进入待检查 {{ summary.queued }} 台，超限单列 {{ summary.noted }} 台，越权挡回 {{ summary.denied }} 台，跳过 {{ summary.skipped }} 台。
          </template>
          <template v-else>
            同一批提交被重复触发，已幂等返回首次回执，未再产生待检查装置。
          </template>
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th>装置编号</th>
              <th>所属机组</th>
              <th>所属班组</th>
              <th>强励次数</th>
              <th>检查日期</th>
              <th>处理结果</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="receipt in summary.batch.receipts" :key="String(receipt.rowId)">
              <td>{{ receipt.deviceCode }}</td>
              <td>{{ receipt.unit }}</td>
              <td>{{ receipt.crew }}</td>
              <td>{{ receipt.forceCount }}</td>
              <td>{{ receipt.inspectDate || '—' }}</td>
              <td><span :class="['tag', outcomeTagClassOf(receipt.outcome)]">{{ outcomeText[receipt.outcome] }}</span></td>
              <td class="reason-cell">{{ receipt.reason }}</td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="openComplete(summary!.batch)">填报检查结果（{{ summary.queued }} 台待检查）</button>
          <button class="btn primary" type="button" @click="afterBatch">关闭并刷新</button>
        </footer>
      </div>
    </div>

    <!-- 检查完成回写：可控硅温度、励磁电压逐台回写 -->
    <div v-if="completing" class="modal-mask" @click.self="completing = null">
      <div class="modal modal-wide">
        <header class="modal-head"><h3>检查结果回写 · {{ completing }}</h3></header>
        <table class="data-table">
          <thead>
            <tr><th>装置编号</th><th>所属机组</th><th>励磁电压</th><th>可控硅温度</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in completingRows" :key="String(row.rowId)">
              <td>{{ row.deviceCode }}</td>
              <td>{{ row.unit }}</td>
              <td><input v-model="row.voltage" placeholder="如 186.5" /></td>
              <td><input v-model="row.temp" placeholder="如 52.4" /></td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="fillSample">填入示例读数</button>
          <button class="btn" type="button" @click="completing = null">取消</button>
          <button class="btn primary" type="button" @click="finishComplete">确认完成并回写台账</button>
        </footer>
      </div>
    </div>

    <!-- 批量结果存档 -->
    <div v-if="archiveOpen" class="modal-mask" @click.self="archiveOpen = false">
      <div class="modal modal-wide">
        <header class="modal-head">
          <h3>批量结果存档</h3>
          <span class="modal-tip">另存结果与页面台数一致：每条回执台数、越权挡回均保留</span>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>批量单号</th>
              <th>业务时间</th>
              <th>提交班组</th>
              <th>回执台数</th>
              <th>待检查</th>
              <th>超限单列</th>
              <th>越权挡回</th>
              <th>跳过</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.batchNo">
              <td>{{ batch.batchNo }}</td>
              <td>{{ batch.businessDate }}</td>
              <td>{{ batch.crew }}</td>
              <td>{{ batch.receipts.length }}</td>
              <td>{{ countOutcome(batch, 'queued') }}</td>
              <td>{{ countOutcome(batch, 'noted') }}</td>
              <td>{{ countOutcome(batch, 'denied') }}</td>
              <td>{{ countOutcome(batch, 'skipped') }}</td>
              <td>
                <button class="link" type="button" @click="viewBatch(batch)">查看回执</button>
                <button class="link" type="button" @click="downloadBatch(batch)">另存CSV</button>
              </td>
            </tr>
            <tr v-if="!batches.length">
              <td colspan="9" class="empty-state">还没有批量提交记录</td>
            </tr>
          </tbody>
        </table>
        <footer class="modal-foot">
          <button class="btn primary" type="button" @click="archiveOpen = false">关闭</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  allBatches,
  batchResultCsv,
  BUSINESS_DATE,
  completeBatch,
  excitationStats,
  FORCE_LIMIT,
  getBatch,
  importDevices,
  INSPECT_CYCLE_MONTHS,
  parseForceCount,
  prepareExcitationData,
  submitInspectionBatch,
  type SubmitSummary,
} from '@/api/excitation-service'
import type { BatchResult, EntryRow, ReceiptOutcome } from '@/data/types'
import { useSessionStore } from '@/stores/session'
import { currentDutyCount } from '@/data/duty-store'

const meta = moduleMeta('excitation')
const session = useSessionStore()
const columns = ['装置编号', '所属机组', '所属班组', '励磁电压', '励磁电流', '可控硅温度', '强励次数', '上次检查日期', '检查日期']
const actions = ['提交检查', '标记异常', '退出运行']
const statuses = ['待检查', '正常', '异常', '已退出']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['装置编号', '所属机组', '所属班组']
const selected = ref<number[]>([])
const submitting = ref(false)
const summary = ref<SubmitSummary | null>(null)
const archiveOpen = ref(false)
const batches = ref<BatchResult[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const completing = ref<string | null>(null)
const completingRows = ref<{ rowId: number; deviceCode: string; unit: string; voltage: string; temp: string }[]>([])

const stats = computed(() => excitationStats(rows.value))
const statCards = computed(() => [
  { label: '正常装置', value: stats.value.normal },
  { label: '异常装置', value: stats.value.abnormal },
  { label: '待检查装置', value: stats.value.pending },
  { label: '超限未到期（单列）', value: stats.value.noted },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const visibleIds = computed(() => rows.value.map((row) => Number(row.id)))
const allVisibleSelected = computed(
  () => visibleIds.value.length > 0 && visibleIds.value.every((id) => selected.value.includes(id)),
)

const outcomeText: Record<ReceiptOutcome, string> = {
  queued: '进入待检查',
  noted: '超限单列',
  denied: '越权挡回',
  skipped: '跳过',
  done: '检查完成',
}
const outcomeTagClass: Record<ReceiptOutcome, string> = {
  queued: 'tag-pending',
  noted: 'tag-warn',
  denied: 'tag-danger',
  skipped: 'tag-muted',
  done: 'tag-ok',
}
function outcomeTagClassOf(outcome: ReceiptOutcome): string {
  return outcomeTagClass[outcome]
}

function forceOf(row: EntryRow): number {
  return parseForceCount(row['强励次数'])
}

function isNoted(row: EntryRow): boolean {
  return forceOf(row) > FORCE_LIMIT && String(row['检查日期'] ?? '') > BUSINESS_DATE
}

function countOutcome(batch: BatchResult, outcome: ReceiptOutcome): number {
  return batch.receipts.filter((r) => r.outcome === outcome).length
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  notice.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    notice.value = result.message
    return
  }
  reload()
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selected.value = checked ? visibleIds.value : selected.value.filter((id) => !visibleIds.value.includes(id))
}

function submitBatch() {
  if (!selected.value.length || submitting.value) {
    return
  }
  submitting.value = true
  notice.value = ''
  try {
    const result = submitInspectionBatch({
      rowIds: selected.value,
      crew: session.crew,
      operator: session.operator,
    })
    summary.value = result
    selected.value = []
    reload()
  } finally {
    submitting.value = false
  }
}

function afterBatch() {
  summary.value = null
  reload()
}

function openComplete(batch: BatchResult) {
  if (!batch.receipts.some((r) => r.outcome === 'queued')) {
    notice.value = '该批次没有仍在待检查的装置'
    return
  }
  completing.value = batch.batchNo
  completingRows.value = batch.receipts
    .filter((r) => r.outcome === 'queued')
    .map((r) => ({ rowId: r.rowId, deviceCode: r.deviceCode, unit: r.unit, voltage: '', temp: '' }))
}

function fillSample() {
  completingRows.value = completingRows.value.map((row, i) => ({
    ...row,
    voltage: (184 + i * 0.4).toFixed(1),
    temp: (49 + (i % 5) * 1.8).toFixed(1),
  }))
}

function finishComplete() {
  if (!completing.value) {
    return
  }
  const missing = completingRows.value.some((row) => !row.voltage.trim() || !row.temp.trim())
  if (missing) {
    notice.value = '每台都要填写励磁电压与可控硅温度后才能完成'
    return
  }
  const result = completeBatch(
    completing.value,
    completingRows.value.map((row) => ({ rowId: row.rowId, voltage: row.voltage, temp: row.temp })),
  )
  completing.value = null
  reload()
  if (result.batch) {
    const refreshed = getBatch(result.batch.batchNo)
    if (refreshed) {
      summary.value = {
        batch: refreshed,
        queued: countOutcome(refreshed, 'queued'),
        noted: countOutcome(refreshed, 'noted'),
        denied: countOutcome(refreshed, 'denied'),
        skipped: countOutcome(refreshed, 'skipped'),
      }
    }
  }
  notice.value = `已完成 ${result.done} 台并回写台账；值班台账当前共 ${currentDutyCount()} 条`
}

function openArchive() {
  batches.value = allBatches()
  archiveOpen.value = true
}

function viewBatch(batch: BatchResult) {
  const current = getBatch(batch.batchNo)
  if (current) {
    summary.value = {
      batch: current,
      queued: countOutcome(current, 'queued'),
      noted: countOutcome(current, 'noted'),
      denied: countOutcome(current, 'denied'),
      skipped: countOutcome(current, 'skipped'),
    }
    archiveOpen.value = false
  }
}

function downloadBatch(batch: BatchResult) {
  const { filename, content } = batchResultCsv(batch)
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

function triggerImport() {
  fileInput.value?.click()
}

const TEMPLATE_HEADER = '装置编号,所属机组,所属班组,励磁电压,励磁电流,可控硅温度,强励次数,检查日期'

function downloadTemplate() {
  const sample = ['EXCI-NEW,13号机,电气一班,186.5,910,52.0,2,2026-12-01']
  const blob = new Blob([`﻿${[TEMPLATE_HEADER, ...sample].join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '励磁装置导入模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') {
        i += 1
      }
      row.push(cell)
      if (row.some((part) => part.trim() !== '')) {
        rows.push(row)
      }
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((part) => part.trim() !== '')) {
    rows.push(row)
  }
  return rows
}

function onFilePicked(event: Event) {
  const inputEl = event.target as HTMLInputElement
  const file = inputEl.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const parsed = parseCsv(String(reader.result ?? ''))
    const body = parsed.slice(1).filter((line) => line.some((cell) => cell.trim() !== ''))
    const result = importDevices(body)
    notice.value = `导入完成：新增 ${result.added} 台，重复 ${result.duplicated} 台（装置编号重复只保留一次），无效 ${result.invalid} 行`
    inputEl.value = ''
    reload()
  }
  reader.readAsText(file, 'utf-8')
}

function reload() {
  notice.value = ''
  try {
    prepareExcitationData()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '励磁系统列表读取失败'
  }
}

onMounted(reload)
</script>
