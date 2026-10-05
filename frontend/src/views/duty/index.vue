<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>值班清单</h2>
        <p class="page-desc">
          励磁装置批量检查的处理结果逐条回写到技术供水值班台账。本页与「技术供水」页是同一份记录的两个入口，条数必须一致。
        </p>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">值班台账总条数</span>
        <strong class="stat-value">{{ allEntries.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">进待检查</span>
        <strong class="stat-value">{{ countOf('queued') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超限未到期单列</span>
        <strong class="stat-value warn">{{ countOf('deferred') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已挡回</span>
        <strong class="stat-value danger-text">{{ countOf('rejected') }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">检查完成</span>
        <strong class="stat-value">{{ countOf('completed') }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>装置编号</span>
        <input v-model="keyword" placeholder="按装置编号检索" />
      </label>
      <label class="filter-item">
        <span>处理结果</span>
        <select v-model="outcomeFilter">
          <option value="">全部</option>
          <option v-for="item in outcomeOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="keyword = ''; outcomeFilter = ''">重置</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>业务时间</th>
          <th>装置编号</th>
          <th>责任班组</th>
          <th>来源批次</th>
          <th>版本</th>
          <th>来源</th>
          <th>处理结果</th>
          <th>可控硅温度</th>
          <th>励磁电压</th>
          <th>完成时间</th>
          <th>说明/原因</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.key">
          <td>{{ entry.businessTime }}</td>
          <td>{{ entry.装置编号 }}</td>
          <td>{{ entry.责任班组 }}</td>
          <td>{{ entry.batchNo }}</td>
          <td>{{ entry.version ? `v${entry.version}` : '—' }}</td>
          <td>{{ entry.source }}</td>
          <td><span :class="['outcome-pill', `outcome-${entry.outcome}`]">{{ OUTCOME_LABELS[entry.outcome] }}</span></td>
          <td>{{ entry.可控硅温度 || '—' }}</td>
          <td>{{ entry.励磁电压 || '—' }}</td>
          <td>{{ entry.completedAt ? entry.completedAt.slice(0, 10) : '—' }}</td>
          <td class="reason-cell">{{ entry.reason }}</td>
        </tr>
        <tr v-if="!entries.length">
          <td colspan="11" class="empty-state">值班台账暂无记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        清单条数 <strong>{{ entries.length }}</strong>
        <template v-if="!keyword && !outcomeFilter">（= 台账总条数 {{ allEntries.length }}，两个入口一致）</template>
      </span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { OUTCOME_LABELS, listDutyLedger } from '@/api/inspection-service'
import type { DutyLedgerEntry } from '@/data/domain-types'

const entries = ref<DutyLedgerEntry[]>([])
const allEntries = ref<DutyLedgerEntry[]>([])
const keyword = ref('')
const outcomeFilter = ref('')
const outcomeOptions = Object.entries(OUTCOME_LABELS).map(([value, label]) => ({ value, label }))

function countOf(outcome: DutyLedgerEntry['outcome']): number {
  return allEntries.value.filter((entry) => entry.outcome === outcome).length
}

function reload(): void {
  allEntries.value = listDutyLedger()
  entries.value = listDutyLedger({ outcome: outcomeFilter.value, keyword: keyword.value })
}

onMounted(reload)
</script>

<style scoped>
.danger-text { color: #b42318; }
.warn { color: #b54708; }
.reason-cell { color: #475569; font-size: 12px; }
.outcome-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; white-space: nowrap; }
.outcome-queued { background: #e0edff; color: #1f6feb; }
.outcome-deferred { background: #fef3c7; color: #b54708; }
.outcome-rejected { background: #fee4e2; color: #b42318; }
.outcome-completed { background: #dcfce7; color: #166534; }
.outcome-backfilled { background: #f1f5f9; color: #475569; }
</style>
