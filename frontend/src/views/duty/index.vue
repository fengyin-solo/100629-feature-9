<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>技术供水值班台账</h2>
        <p class="page-desc">
          励磁装置批量检查的处理结果回写在这里；当班清单按装置编号覆盖（重新覆盖以最近生效版为准），历史台账按业务时间留存。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="panel?.refresh()">刷新核对</button>
      </div>
    </header>

    <p class="status-legend">
      <span class="legend-item">业务日期：{{ BUSINESS_DATE }}</span>
      <span class="legend-item">强励超限阈值：{{ FORCE_LIMIT }} 次</span>
      <span class="legend-item">检查周期：{{ INSPECT_CYCLE_MONTHS }} 个月</span>
    </p>

    <DutyLedgerPanel ref="panel" />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import DutyLedgerPanel from '@/components/DutyLedgerPanel.vue'
import { BUSINESS_DATE, FORCE_LIMIT, INSPECT_CYCLE_MONTHS } from '@/api/excitation-service'

const panel = ref<InstanceType<typeof DutyLedgerPanel> | null>(null)
</script>
