<template>
  <section class="page" data-module="cooling">
    <header class="page-head">
      <div>
        <h2>技术供水管理</h2>
        <p class="page-desc">维护供水系统；励磁装置批量检查的处理结果回写到本页值班台账，与「值班清单」是同一份记录的两个入口。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记供水系统</button>
        <button class="btn" type="button" @click="exportRows">导出技术供水清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无技术供水数据，可先登记供水系统</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条技术供水记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 值班台账（励磁批量检查处理结果回写处） -->
    <section class="duty-section">
      <header class="duty-head">
        <div>
          <h3>值班台账 · 励磁检查处理结果回写</h3>
          <p class="page-desc">
            每一次批量提交的每一台（含进待检查、超限未到期单列、越权挡回、检查完成）都逐条回写于此；
            本入口共 <strong class="brand-text">{{ dutyEntries.length }}</strong> 条，与「值班清单」入口的
            <strong class="brand-text">{{ dutyEntries.length }}</strong> 条为同一数据源，始终相等。
          </p>
        </div>
      </header>

      <div class="duty-stat-row">
        <span class="duty-chip">总数 {{ dutyEntries.length }}</span>
        <span class="duty-chip queued">进待检查 {{ countOutcome('queued') }}</span>
        <span class="duty-chip deferred">超限单列 {{ countOutcome('deferred') }}</span>
        <span class="duty-chip rejected">已挡回 {{ countOutcome('rejected') }}</span>
        <span class="duty-chip completed">检查完成 {{ countOutcome('completed') }}</span>
        <span class="duty-chip backfilled">历史补录 {{ countOutcome('backfilled') }}</span>
      </div>

      <form class="filter-bar" @submit.prevent="filterDuty">
        <label class="filter-item">
          <span>装置编号</span>
          <input v-model="dutyKeyword" placeholder="按装置编号检索" />
        </label>
        <label class="filter-item">
          <span>处理结果</span>
          <select v-model="dutyOutcome">
            <option value="">全部</option>
            <option v-for="item in outcomeOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="dutyKeyword = ''; dutyOutcome = ''; filterDuty()">重置</button>
      </form>

      <table class="data-table inner-table">
        <thead>
          <tr>
            <th>业务时间</th>
            <th>装置编号</th>
            <th>责任班组</th>
            <th>来源批次</th>
            <th>处理结果</th>
            <th>可控硅温度</th>
            <th>励磁电压</th>
            <th>说明/原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in filteredDuty" :key="entry.key">
            <td>{{ entry.businessTime }}</td>
            <td>{{ entry.装置编号 }}</td>
            <td>{{ entry.责任班组 }}</td>
            <td>{{ entry.batchNo }}{{ entry.version ? ` v${entry.version}` : '' }}</td>
            <td><span :class="['outcome-pill', `outcome-${entry.outcome}`]">{{ OUTCOME_LABELS[entry.outcome] }}</span></td>
            <td>{{ entry.可控硅温度 || '—' }}</td>
            <td>{{ entry.励磁电压 || '—' }}</td>
            <td class="reason-cell">{{ entry.reason }}</td>
          </tr>
          <tr v-if="!filteredDuty.length">
            <td colspan="8" class="empty-state">值班台账暂无匹配记录</td>
          </tr>
        </tbody>
      </table>
    </section>
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
import { OUTCOME_LABELS, listDutyLedger } from '@/api/inspection-service'
import type { DutyLedgerEntry } from '@/data/domain-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cooling')
const columns = ["系统编号", "供水类型", "供水压力", "供水流量", "水温数值", "滤水器压差", "检查日期", "系统状态"]
const actions = ["提交检查", "标记异常", "停运系统"]
const statuses = ["待检查", "运行中", "异常", "已停运"]
const stats = [{"label": "运行系统", "value": 0}, {"label": "异常系统", "value": 0}, {"label": "待检查系统", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const dutyEntries = ref<DutyLedgerEntry[]>([])
const dutyKeyword = ref('')
const dutyOutcome = ref('')
const filteredDuty = ref<DutyLedgerEntry[]>([])
const outcomeOptions = Object.entries(OUTCOME_LABELS).map(([value, label]) => ({ value, label }))

function countOutcome(outcome: DutyLedgerEntry['outcome']): number {
  return dutyEntries.value.filter((entry) => entry.outcome === outcome).length
}

function filterDuty(): void {
  filteredDuty.value = listDutyLedger({ outcome: dutyOutcome.value, keyword: dutyKeyword.value })
}

function loadDuty(): void {
  dutyEntries.value = listDutyLedger()
  filterDuty()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '供水系统登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadDuty()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '技术供水列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.duty-section {
  margin-top: 22px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.duty-head h3 { margin: 0 0 4px; font-size: 15px; }
.brand-text { color: var(--brand); }
.duty-stat-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.duty-chip {
  border-radius: 999px; padding: 3px 12px; font-size: 12px;
  background: #f1f5f9; color: #334155;
}
.duty-chip.queued { background: #e0edff; color: #1f6feb; }
.duty-chip.deferred { background: #fef3c7; color: #b54708; }
.duty-chip.rejected { background: #fee4e2; color: #b42318; }
.duty-chip.completed { background: #dcfce7; color: #166534; }
.duty-chip.backfilled { background: #e2e8f0; color: #475569; }
.inner-table { margin-top: 6px; }
.reason-cell { color: #475569; font-size: 12px; }
.outcome-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.outcome-queued { background: #e0edff; color: #1f6feb; }
.outcome-deferred { background: #fef3c7; color: #b54708; }
.outcome-rejected { background: #fee4e2; color: #b42318; }
.outcome-completed { background: #dcfce7; color: #166534; }
.outcome-backfilled { background: #f1f5f9; color: #475569; }
</style>
