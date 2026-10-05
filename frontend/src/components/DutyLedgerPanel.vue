<template>
  <section class="duty-panel">
    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">当班清单（联动待检查）</span>
        <strong class="stat-value">{{ current.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">其中待检查</span>
        <strong class="stat-value">{{ planCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已完成回执</span>
        <strong class="stat-value">{{ doneCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">历史台账条数（老台账已回填）</span>
        <strong class="stat-value">{{ history.length }}</strong>
      </article>
    </div>

    <h3>当班清单（与技术供水值班台账同一份，条数一致）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>装置编号</th>
          <th>所属机组</th>
          <th>所属班组</th>
          <th>业务时间</th>
          <th>状态</th>
          <th>励磁电压</th>
          <th>可控硅温度</th>
          <th>来源批次</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in current" :key="entry.id">
          <td>{{ entry.deviceCode }}</td>
          <td>{{ entry.unit }}</td>
          <td>{{ entry.crew }}</td>
          <td>{{ entry.businessDate }}</td>
          <td>
            <span :class="['tag', entry.type === 'done' ? 'tag-ok' : 'tag-pending']">{{ entry.result }}</span>
          </td>
          <td>{{ entry.voltage || '—' }}</td>
          <td>{{ entry.temp || '—' }}</td>
          <td>{{ entry.batchNo }}</td>
          <td>{{ entry.note }}</td>
        </tr>
        <tr v-if="!current.length">
          <td colspan="9" class="empty-state">暂无当班记录，批量提交检查计划后会写入这里</td>
        </tr>
      </tbody>
    </table>

    <details class="history-box">
      <summary>历史检查台账（按业务时间回填，{{ history.length }} 条；早年缺项按条补齐）</summary>
      <table class="data-table">
        <thead>
          <tr>
            <th>业务时间</th>
            <th>装置编号</th>
            <th>所属班组</th>
            <th>结果</th>
            <th>励磁电压</th>
            <th>可控硅温度</th>
            <th>来源</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in latestHistory" :key="`${entry.deviceCode}-${entry.businessDate}`">
            <td>{{ entry.businessDate }}</td>
            <td>{{ entry.deviceCode }}</td>
            <td>{{ entry.crew }}</td>
            <td>{{ entry.result }}</td>
            <td>{{ entry.voltage || '—' }}</td>
            <td>{{ entry.temp || '—' }}</td>
            <td>{{ entry.source }}</td>
            <td>{{ entry.note }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { listCurrentDuty, listDutyHistory } from '@/data/duty-store'
import type { DutyEntry } from '@/data/types'

// 每次切回页面都会重新读 localStorage：值班清单与台账始终联动。
const current = ref<DutyEntry[]>([])
const history = ref<DutyEntry[]>([])

function refresh() {
  current.value = listCurrentDuty()
  history.value = listDutyHistory()
}

refresh()
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refresh()
  }
})

const planCount = computed(() => current.value.filter((e) => e.type === 'plan').length)
const doneCount = computed(() => current.value.filter((e) => e.type === 'done').length)
// 历史台账很长时，页面只展示最近 50 条，条数仍按全量统计。
const latestHistory = computed(() => history.value.slice(-50).reverse())

defineExpose({ refresh })
</script>
