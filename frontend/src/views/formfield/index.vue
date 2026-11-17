<template>
  <section class="page" data-module="formfield">
    <header class="page-head">
      <div>
        <h2>表单分析管理</h2>
        <p class="page-desc">分析表单填写的用户行为，诊断高放弃率和错误集中的字段。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记表单诊断</button>
        <button class="btn" type="button" @click="exportRows">导出表单分析清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无表单分析数据，可先登记表单诊断</td>
        </tr>
      </tbody>
    </table>

    <section class="drill-panel">
      <header class="drill-head">
        <div>
          <h3>复核清单 · 随增量流失诊断报告同步</h3>
          <p class="page-desc">{{ checklist?.note ?? '尚无流失诊断报告' }}</p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="recompute">完整重算流失诊断</button>
        </div>
      </header>
      <div v-if="checklist" class="drill-grid">
        <article class="drill-card">
          <h4>流失绝对量与流失占比</h4>
          <table class="data-table">
            <thead>
              <tr><th>口径</th><th>修订号</th><th>流失绝对量</th><th>流失占比</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>当前报告（{{ checklist.status === 'complete' ? '完整' : '增量' }}）</td>
                <td>{{ checklist.revision }}</td>
                <td>{{ checklist.totalLoss }}</td>
                <td>{{ percent(checklist.totalLossRatio) }}</td>
              </tr>
              <tr>
                <td>上一完整报告</td>
                <td>{{ checklist.baselineRevision }}</td>
                <td>{{ checklist.baselineLoss }}</td>
                <td>{{ percent(checklist.baselineLossRatio) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="page-desc">
            关联漏斗报告 {{ checklist.funnelId }} · 受影响字段：{{ checklist.affectedFieldKeys.join('、') || '无' }}
            · 组级待汇总 {{ checklist.pendingCount }} 组
          </p>
        </article>
        <article class="drill-card">
          <h4>字段复核清单</h4>
          <table class="data-table">
            <thead>
              <tr><th>序号</th><th>原因组</th><th>错误字段</th><th>流失绝对量</th><th>流失占比</th><th>优先优化</th><th>复核状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in checklist.items" :key="item.key">
                <td>{{ item.priorityRank }}</td>
                <td>{{ item.groupName }}</td>
                <td>{{ item.fieldKey }}</td>
                <td>{{ item.lossCount }}</td>
                <td>{{ percent(item.lossRatio) }}</td>
                <td>{{ item.optimizationDirection }}</td>
                <td>{{ item.status }}</td>
              </tr>
            </tbody>
          </table>
        </article>
      </div>
      <p v-if="chain" class="page-desc">
        调用链：{{ chain.steps.map((step) => `${step.module}/${step.recordId}`).join(' → ') }}
        · 合计一致：{{ chain.totalsConsistent ? '是' : '否' }}
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条表单分析记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getCallChain,
  getFormChecklist,
  listEntries,
  moduleMeta,
  recomputeCompleteReport,
  runAction as applyAction,
} from '@/api/local-service'
import type { CallChainResult, FormReviewChecklist } from '@/data/loss-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('formfield')
const columns = ["诊断编号", "表单名称", "总字段数", "放弃字段", "错误字段", "平均填写秒", "放弃率", "优化方向"]
const actions = ["发起诊断", "确诊问题", "标记优化"]
const statuses = ["草稿", "诊断中", "已确诊", "已优化"]
const stats = [{"label": "表单诊断总数", "value": 0}, {"label": "已确诊问题", "value": 0}, {"label": "诊断中问题", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const checklist = ref<FormReviewChecklist | null>(null)
const chain = ref<CallChainResult | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function percent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`
}

// 表单分析按诊断编号找到同一份流失诊断报告，复核清单与漏斗侧读数一致。
function loadChecklist() {
  const formId = String(rows.value[0]?.['诊断编号'] ?? '')
  checklist.value = formId ? getFormChecklist(formId) : null
  chain.value = formId ? getCallChain(formId) : null
}

function recompute() {
  if (!checklist.value) return
  recomputeCompleteReport(checklist.value.formId)
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '表单诊断登记入口尚未接入审批流'
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
    loadChecklist()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '表单分析列表读取失败'
  }
}

onMounted(reload)
</script>
