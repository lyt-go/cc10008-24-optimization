<template>
  <section class="page" data-module="funnel">
    <header class="page-head">
      <div>
        <h2>漏斗诊断管理</h2>
        <p class="page-desc">对行为转化漏斗进行流失诊断，定位流失节点和原因分类。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记诊断报告</button>
        <button class="btn" type="button" @click="exportRows">导出漏斗诊断清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无漏斗诊断数据，可先登记诊断报告</td>
        </tr>
      </tbody>
    </table>

    <section class="drill-panel">
      <header class="drill-head">
        <div>
          <h3>漏斗表单流失诊断 · 增量重算范围</h3>
          <p class="page-desc">
            报告修订号 {{ activeReport?.revision ?? '—' }}，
            {{ activeReport?.status === 'complete' ? '当前为完整快照' : '当前为增量更新' }}；
            未受影响的诊断报告继续读取第 {{ activeReport?.lastComplete.revision ?? '—' }} 版完整流失绝对量与流失占比。
          </p>
        </div>
        <div class="page-actions">
          <select v-model="activeFormId" class="btn" @change="selectForm">
            <option v-for="item in formOptions" :key="item.formId" :value="item.formId">
              {{ item.funnelId }} · {{ item.formName }}
            </option>
          </select>
          <button class="btn" type="button" @click="recompute">完整重算当前表单</button>
        </div>
      </header>
      <div v-if="activeReport" class="drill-grid">
        <article class="drill-card">
          <h4>原因组汇总</h4>
          <table class="data-table">
            <thead>
              <tr><th>原因组</th><th>关联字段</th><th>流失绝对量</th><th>流失占比</th><th>来源</th></tr>
            </thead>
            <tbody>
              <tr v-for="group in activeReport.groups" :key="group.groupId">
                <td>{{ group.groupName }}</td>
                <td>{{ group.fieldKeys.join('、') }}</td>
                <td>{{ group.lossCount }}</td>
                <td>{{ percent(group.lossRatio) }}</td>
                <td>{{ sourceLabel(group) }}</td>
              </tr>
            </tbody>
          </table>
        </article>
        <article class="drill-card">
          <h4>字段优化优先级（可下钻）</h4>
          <table class="data-table">
            <thead>
              <tr><th>序号</th><th>原因组</th><th>错误字段</th><th>流失绝对量</th><th>计入组级</th><th>待汇总</th></tr>
            </thead>
            <tbody>
              <tr v-for="field in activeReport.fieldPriority" :key="field.fieldKey">
                <td>{{ field.rank }}</td>
                <td>{{ field.groupName }}</td>
                <td>{{ field.fieldKey }}</td>
                <td>{{ field.lossCount }}</td>
                <td>{{ field.countedLoss }}</td>
                <td>{{ field.pendingLoss }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="activeReport.pending.length" class="page-desc">
            组级待汇总：{{ activeReport.pending.map((item) => `${item.groupName} ${item.pendingLoss}`).join('；') }}
          </p>
        </article>
      </div>
      <p v-if="chain" class="page-desc">
        调用链：{{ chain.steps.map((step) => `${step.module}/${step.recordId}`).join(' → ') }}；
        合计一致：{{ chain.totalsConsistent ? '是' : '否' }}；模块行同步：{{ chain.moduleRowsSynced ? '是' : '否' }}
      </p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条漏斗诊断记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getCallChain,
  getReport,
  listEntries,
  listFormSummaries,
  moduleMeta,
  recomputeCompleteReport,
  runAction as applyAction,
} from '@/api/local-service'
import type { CallChainResult, LossDiagnosisReport } from '@/data/loss-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('funnel')
const columns = ["报告编号", "漏斗名称", "步骤定义", "流失绝对量", "流失占比", "流失原因分类", "优化建议", "诊断日期"]
const actions = ["发起诊断", "确诊原因", "标记修复"]
const statuses = ["草稿", "诊断中", "已确诊", "已修复", "已验证"]
const stats = [{"label": "诊断报告总数", "value": 0}, {"label": "已确诊报告", "value": 0}, {"label": "诊断中报告", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const activeFormId = ref('')
const activeReport = ref<LossDiagnosisReport | null>(null)
const chain = ref<CallChainResult | null>(null)
const formOptions = ref<{ formId: string; formName: string; funnelId: string }[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function percent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`
}

function sourceLabel(row: { source: string; recalculatedInRevision: number | null; retainedFromRevision?: number }): string {
  if (row.source === 'retained') return `沿用第 ${row.retainedFromRevision ?? '—'} 版`
  if (row.source === 'incremental') return `第 ${row.recalculatedInRevision ?? '—'} 版重算`
  return '完整快照'
}

// 以当前列表里的漏斗报告编号找到对应的表单流失诊断报告。
function loadDiagnosis() {
  formOptions.value = listFormSummaries()
  const funnelId = String(rows.value[0]?.['报告编号'] ?? '')
  const summary =
    listFormSummaries().find((item) => item.formId === activeFormId.value) ??
    listFormSummaries().find((item) => item.funnelId === funnelId)
  activeFormId.value = summary?.formId ?? ''
  activeReport.value = summary ? getReport(summary.formId) : null
  chain.value = summary ? getCallChain(summary.formId) : null
}

function selectForm() {
  activeReport.value = getReport(activeFormId.value)
  chain.value = getCallChain(activeFormId.value)
}

function recompute() {
  if (!activeFormId.value) return
  recomputeCompleteReport(activeFormId.value)
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
  errorMessage.value = '诊断报告登记入口尚未接入审批流'
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
    loadDiagnosis()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '漏斗诊断列表读取失败'
  }
}

onMounted(reload)
</script>
