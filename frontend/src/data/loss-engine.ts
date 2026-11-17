import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import type {
  CallChainResult,
  CallChainStep,
  CauseGroupDefinition,
  ConflictResolution,
  ConflictResolutionInput,
  DiagnosisOverview,
  EvidenceSubmitRequest,
  EvidenceSubmitResult,
  FieldDrilldownRow,
  FieldErrorEvidence,
  FieldPriorityRow,
  FormDefinition,
  FormReviewChecklist,
  FormReviewChecklistItem,
  FormSummary,
  GroupLossSummary,
  GroupPendingAggregation,
  LossDiagnosisReport,
  LossEngineSnapshot,
  LossSource,
  MergeBatchInput,
  MergeBatchResult,
  PersistedFormState,
  PriorCompleteReport,
  ReportSnapshot,
} from '@/data/loss-types'

/**
 * 漏斗表单流失诊断引擎。
 *
 * 数据流：漏斗诊断（funnel 模块）→ 流失诊断报告（本文件）→ 表单分析（formfield 模块）。
 *
 * 三条硬约束：
 * 1. 证据以 evidenceId 幂等，同一份错误证据不会因为被多个归并批次读到而重复计入流失量。
 * 2. 组级流失按指纹去重，字段下钻保留全部证据，字段 countedLoss 之和等于组级 lossCount。
 * 3. 增量报告只重算受影响原因组；未受影响原因组沿用上一版报告数值并标记 retained。
 */

const STORAGE_KEY = 'behavior-event-trace-hub:loss-diagnosis'

const FORM_DEFINITIONS: FormDefinition[] = [
  {
    formId: 'FORM-0001',
    formName: '表单分析样例1',
    funnelId: 'FUNN-0001',
    enteredCount: 1200,
    groups: [
      {
        groupId: 'FORM-0001-G1',
        groupName: '联系方式格式校验',
        fieldKeys: ['手机号', '备用手机号'],
        funnelStep: '步骤2 提交联系方式',
      },
      {
        groupId: 'FORM-0001-G2',
        groupName: '地址完整性校验',
        fieldKeys: ['详细地址', '所在城市'],
        funnelStep: '步骤3 填写地址',
      },
    ],
  },
  {
    formId: 'FORM-0002',
    formName: '表单分析样例2',
    funnelId: 'FUNN-0002',
    enteredCount: 900,
    groups: [
      {
        groupId: 'FORM-0002-G1',
        groupName: '证件信息校验',
        fieldKeys: ['证件号', '证件有效期'],
        funnelStep: '步骤2 实名认证',
      },
      {
        groupId: 'FORM-0002-G2',
        groupName: '邮箱格式校验',
        fieldKeys: ['邮箱'],
        funnelStep: '步骤1 注册',
      },
    ],
  },
  {
    formId: 'FORM-0003',
    formName: '表单分析样例3',
    funnelId: 'FUNN-0003',
    enteredCount: 600,
    groups: [
      {
        groupId: 'FORM-0003-G1',
        groupName: '验证码校验',
        fieldKeys: ['短信验证码'],
        funnelStep: '步骤2 验证码',
      },
    ],
  },
]

const BASELINE_EVIDENCE: Record<string, FieldErrorEvidence[]> = {
  'FORM-0001': [
    { evidenceId: 'EV-F1-001', fieldKey: '手机号', lossCount: 120, observedAt: '2026-09-01T09:00:00.000Z', fingerprint: 'user-001', version: 1 },
    { evidenceId: 'EV-F1-002', fieldKey: '备用手机号', lossCount: 45, observedAt: '2026-09-01T09:05:00.000Z', fingerprint: 'user-002', version: 1 },
    // 与手机号同指纹：字段下钻保留两条，组级合计只计一次。
    { evidenceId: 'EV-F1-003', fieldKey: '备用手机号', lossCount: 45, observedAt: '2026-09-01T09:10:00.000Z', fingerprint: 'user-001', version: 1 },
    { evidenceId: 'EV-F1-004', fieldKey: '详细地址', lossCount: 80, observedAt: '2026-09-02T10:00:00.000Z', fingerprint: 'user-010', version: 1 },
    { evidenceId: 'EV-F1-005', fieldKey: '所在城市', lossCount: 30, observedAt: '2026-09-02T10:05:00.000Z', fingerprint: 'user-011', version: 1 },
  ],
  'FORM-0002': [
    { evidenceId: 'EV-F2-001', fieldKey: '证件号', lossCount: 90, observedAt: '2026-09-03T09:00:00.000Z', fingerprint: 'user-100', version: 1 },
    { evidenceId: 'EV-F2-002', fieldKey: '证件有效期', lossCount: 40, observedAt: '2026-09-03T09:05:00.000Z', fingerprint: 'user-100', version: 1 },
    { evidenceId: 'EV-F2-003', fieldKey: '邮箱', lossCount: 60, observedAt: '2026-09-04T09:00:00.000Z', fingerprint: 'user-120', version: 1 },
  ],
  'FORM-0003': [
    { evidenceId: 'EV-F3-001', fieldKey: '短信验证码', lossCount: 55, observedAt: '2026-09-05T09:00:00.000Z', fingerprint: 'user-200', version: 1 },
  ],
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowIso(): string {
  return new Date().toISOString()
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function toPercent(value: number): number {
  return round2(value * 100)
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function ratioOf(loss: number, entered: number): number {
  if (!entered) return 0
  return round4(loss / entered)
}

function toNumeric(value: unknown): number {
  const parsed = Number(String(value ?? '').replace('%', '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function evidenceVersion(item: FieldErrorEvidence): number {
  return item.version ?? 1
}

function compareEvidence(a: FieldErrorEvidence, b: FieldErrorEvidence): number {
  if (a.observedAt !== b.observedAt) {
    return a.observedAt < b.observedAt ? -1 : 1
  }
  return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0
}

/** 原因组级去重：同一指纹只计一次，没有指纹时按 evidenceId 各自计数。 */
function dedupeGroupEvidence(groupEvidence: FieldErrorEvidence[]): {
  counted: FieldErrorEvidence[]
  duplicated: FieldErrorEvidence[]
} {
  const seenFingerprints = new Set<string>()
  const seenEvidence = new Set<string>()
  const counted: FieldErrorEvidence[] = []
  const duplicated: FieldErrorEvidence[] = []
  for (const item of [...groupEvidence].sort(compareEvidence)) {
    if (seenEvidence.has(item.evidenceId)) {
      duplicated.push(item)
      continue
    }
    seenEvidence.add(item.evidenceId)
    if (item.fingerprint) {
      if (seenFingerprints.has(item.fingerprint)) {
        duplicated.push(item)
        continue
      }
      seenFingerprints.add(item.fingerprint)
    }
    counted.push(item)
  }
  return { counted, duplicated }
}

// ---------------------------------------------------------------------------
// 内存 + 本地持久化
// ---------------------------------------------------------------------------

let cache: LossEngineSnapshot | null = null

function formDefinition(formId: string): FormDefinition {
  const definition = FORM_DEFINITIONS.find((item) => item.formId === formId)
  if (!definition) {
    throw new Error(`没有找到编号为 ${formId} 的表单诊断定义`)
  }
  return definition
}

function groupOf(definition: FormDefinition, groupId: string): CauseGroupDefinition {
  const group = definition.groups.find((item) => item.groupId === groupId)
  if (!group) {
    throw new Error(`表单 ${definition.formId} 没有登记原因组 ${groupId}`)
  }
  return group
}

function groupOfField(definition: FormDefinition, fieldKey: string): CauseGroupDefinition {
  const group = definition.groups.find((item) => item.fieldKeys.includes(fieldKey))
  if (!group) {
    throw new Error(`表单 ${definition.formId} 没有登记错误字段 ${fieldKey}`)
  }
  return group
}

function computeGroup(
  definition: FormDefinition,
  group: CauseGroupDefinition,
  evidence: FieldErrorEvidence[],
  pendingEvidence: FieldErrorEvidence[],
  source: LossSource,
  revision: number | null,
  retainedFromRevision?: number,
): { summary: GroupLossSummary; fields: FieldDrilldownRow[] } {
  const groupEvidence = evidence.filter((item) => group.fieldKeys.includes(item.fieldKey))
  const { counted } = dedupeGroupEvidence(groupEvidence)
  const countedIds = new Set(counted.map((item) => item.evidenceId))
  const lossCount = counted.reduce((sum, item) => sum + item.lossCount, 0)
  const groupPending = pendingEvidence.filter((item) => group.fieldKeys.includes(item.fieldKey))

  const fields: FieldDrilldownRow[] = group.fieldKeys.map((fieldKey) => {
    const fieldEvidence = groupEvidence.filter((item) => item.fieldKey === fieldKey)
    const fieldTotal = fieldEvidence.reduce((sum, item) => sum + item.lossCount, 0)
    const fieldCounted = fieldEvidence
      .filter((item) => countedIds.has(item.evidenceId))
      .reduce((sum, item) => sum + item.lossCount, 0)
    const fieldPending = groupPending.filter((item) => item.fieldKey === fieldKey)
    return {
      fieldKey,
      groupId: group.groupId,
      groupName: group.groupName,
      lossCount: fieldTotal,
      countedLoss: fieldCounted,
      duplicateLoss: round2(fieldTotal - fieldCounted),
      pendingLoss: fieldPending.reduce((sum, item) => sum + item.lossCount, 0),
      evidenceCount: fieldEvidence.length,
      evidenceIds: fieldEvidence.map((item) => item.evidenceId).sort(),
      pendingEvidenceIds: fieldPending.map((item) => item.evidenceId).sort(),
      latestObservedAt: fieldEvidence.reduce(
        (latest, item) => (item.observedAt > latest ? item.observedAt : latest),
        '',
      ),
      version: fieldEvidence.reduce((max, item) => Math.max(max, evidenceVersion(item)), 0),
      priorityRank: 0,
      source,
      recalculatedInRevision: revision,
      retainedFromRevision,
    }
  })

  return {
    summary: {
      groupId: group.groupId,
      groupName: group.groupName,
      fieldKeys: [...group.fieldKeys],
      funnelStep: group.funnelStep,
      lossCount,
      lossRatio: ratioOf(lossCount, definition.enteredCount),
      version: groupEvidence.reduce((max, item) => Math.max(max, evidenceVersion(item)), 0),
      evidenceCount: groupEvidence.length,
      dedupedEvidenceCount: counted.length,
      source,
      recalculatedInRevision: revision,
      retainedFromRevision,
      updatedAt: nowIso(),
    },
    fields,
  }
}

function buildPending(
  definition: FormDefinition,
  pendingEvidence: FieldErrorEvidence[],
  sinceRevision: number,
): GroupPendingAggregation[] {
  const result: GroupPendingAggregation[] = []
  for (const group of definition.groups) {
    const groupPending = pendingEvidence.filter((item) => group.fieldKeys.includes(item.fieldKey))
    if (!groupPending.length) continue
    result.push({
      groupId: group.groupId,
      groupName: group.groupName,
      fieldKeys: [...group.fieldKeys],
      pendingEvidenceIds: groupPending.map((item) => item.evidenceId).sort(),
      pendingLoss: groupPending.reduce((sum, item) => sum + item.lossCount, 0),
      reason: '后到批次/旧版本证据等待下一次原因组汇总',
      sinceRevision,
    })
  }
  return result
}

function rankFields(rows: FieldDrilldownRow[]): FieldPriorityRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (b.lossCount !== a.lossCount) return b.lossCount - a.lossCount
    if (a.latestObservedAt !== b.latestObservedAt) {
      return a.latestObservedAt < b.latestObservedAt ? 1 : -1
    }
    return a.fieldKey < b.fieldKey ? -1 : a.fieldKey > b.fieldKey ? 1 : 0
  })
  return sorted.map((row, index) => ({
    fieldKey: row.fieldKey,
    groupId: row.groupId,
    groupName: row.groupName,
    lossCount: row.lossCount,
    countedLoss: row.countedLoss,
    pendingLoss: row.pendingLoss,
    latestObservedAt: row.latestObservedAt,
    version: row.version,
    rank: index + 1,
    source: row.source,
    recalculatedInRevision: row.recalculatedInRevision,
    retainedFromRevision: row.retainedFromRevision,
  }))
}

function snapshotOf(report: LossDiagnosisReport): ReportSnapshot {
  return {
    revision: report.revision,
    totalLoss: report.totalLoss,
    totalLossRatio: report.totalLossRatio,
    groups: clone(report.groups),
    fieldLoss: clone(
      report.drilldown.map((row) => ({
        fieldKey: row.fieldKey,
        groupId: row.groupId,
        lossCount: row.lossCount,
        lossRatio: ratioOf(row.lossCount, report.enteredCount),
        countedLoss: row.countedLoss,
      })),
    ),
    updatedAt: report.updatedAt,
  }
}

function priorCompleteOf(state: PersistedFormState): PriorCompleteReport {
  return {
    revision: state.report.lastComplete.revision,
    totalLoss: state.report.lastComplete.totalLoss,
    totalLossRatio: state.report.lastComplete.totalLossRatio,
    groups: clone(state.report.lastComplete.groups),
    fieldLoss: clone(state.report.lastComplete.fieldLoss),
  }
}

/**
 * 按受影响范围重建报告。affectedGroupIds 为空时保留全部原因组，仅刷新修订号。
 */
function rebuildReport(
  state: PersistedFormState,
  affectedGroupIds: Set<string>,
  revision: number,
  options: { complete?: boolean } = {},
): LossDiagnosisReport {
  const definition = state.definition
  const previous = state.report as LossDiagnosisReport | null
  const previousRevision = previous?.revision ?? 0
  const previousComplete: ReportSnapshot = previous?.lastComplete ?? {
    revision: 0,
    totalLoss: 0,
    totalLossRatio: 0,
    groups: [],
    fieldLoss: [],
    updatedAt: nowIso(),
  }
  const affectedFields = new Set<string>()
  for (const group of definition.groups) {
    if (affectedGroupIds.has(group.groupId)) {
      group.fieldKeys.forEach((field) => affectedFields.add(field))
    }
  }

  const previousGroups = new Map((previous?.groups ?? []).map((group) => [group.groupId, group]))
  const previousFields = new Map((previous?.drilldown ?? []).map((row) => [row.fieldKey, row]))
  const groups: GroupLossSummary[] = []
  const drilldown: FieldDrilldownRow[] = []

  for (const group of definition.groups) {
    const affected = affectedGroupIds.has(group.groupId)
    if (affected) {
      const computed = computeGroup(
        definition,
        group,
        state.evidence,
        state.pendingEvidence,
        'incremental',
        revision,
      )
      groups.push(computed.summary)
      drilldown.push(...computed.fields)
      continue
    }
    const retainedGroup = previousGroups.get(group.groupId)
    if (retainedGroup) {
      groups.push({
        ...clone(retainedGroup),
        source: 'retained',
        recalculatedInRevision: null,
        // 数值来源保留最初那次重算，连续多版增量不会把「沿用自哪版」往前挪。
        retainedFromRevision:
          retainedGroup.recalculatedInRevision ??
          retainedGroup.retainedFromRevision ??
          previousRevision,
      })
    } else {
      const computed = computeGroup(
        definition,
        group,
        state.evidence,
        state.pendingEvidence,
        'retained',
        null,
        previousComplete.revision,
      )
      groups.push(computed.summary)
    }
    for (const fieldKey of group.fieldKeys) {
      const retainedField = previousFields.get(fieldKey)
      if (retainedField) {
        // 沿用上一版流失绝对量，但把后到证据的组级待汇总量透出来。
        const fieldPending = state.pendingEvidence.filter((item) => item.fieldKey === fieldKey)
        drilldown.push({
          ...clone(retainedField),
          pendingLoss: fieldPending.reduce((sum, item) => sum + item.lossCount, 0),
          pendingEvidenceIds: fieldPending.map((item) => item.evidenceId).sort(),
          source: 'retained',
          recalculatedInRevision: null,
          retainedFromRevision:
            retainedField.recalculatedInRevision ??
            retainedField.retainedFromRevision ??
            previousRevision,
        })
        continue
      }
      const fallback = computeGroup(
        definition,
        group,
        state.evidence,
        state.pendingEvidence,
        'retained',
        null,
        previousComplete.revision,
      ).fields.find((row) => row.fieldKey === fieldKey)
      if (fallback) drilldown.push(fallback)
    }
  }

  const pending = buildPending(definition, state.pendingEvidence, revision)
  const fieldPriority = rankFields(drilldown)

  const totalLoss = groups.reduce((sum, group) => sum + group.lossCount, 0)
  const report: LossDiagnosisReport = {
    reportId: `LOSS-${definition.formId}`,
    formId: definition.formId,
    formName: definition.formName,
    funnelId: definition.funnelId,
    revision,
    status: 'incremental',
    updatedAt: nowIso(),
    enteredCount: definition.enteredCount,
    totalLoss,
    totalLossRatio: ratioOf(totalLoss, definition.enteredCount),
    groups,
    drilldown,
    fieldPriority,
    pending,
    affectedGroupIds: [...affectedGroupIds].sort(),
    affectedFieldKeys: [...affectedFields].sort(),
    appliedEvidenceIds: state.evidence.map((item) => item.evidenceId).sort(),
    sourceBatchIds: [...state.appliedBatchIds],
    lastComplete: clone(previousComplete),
  }

  const allGroupsFresh = definition.groups.every(
    (group) =>
      affectedGroupIds.has(group.groupId) &&
      !pending.some((item) => item.groupId === group.groupId),
  )
  const complete = options.complete === true || (allGroupsFresh && pending.length === 0)
  if (complete) {
    report.status = 'complete'
    report.lastComplete = snapshotOf(report)
    state.generatedGroupIds = definition.groups.map((group) => group.groupId)
  } else {
    for (const groupId of affectedGroupIds) {
      if (!state.generatedGroupIds.includes(groupId)) {
        state.generatedGroupIds.push(groupId)
      }
    }
  }
  return report
}

function touchModuleRows(state: PersistedFormState): void {
  const definition = state.definition
  const report = state.report
  const funnelRows = listRows('funnel')
  const funnel = funnelRows.find((row) => String(row['报告编号']) === definition.funnelId)
  if (funnel) {
    funnel['流失绝对量'] = String(report.totalLoss)
    funnel['流失占比'] = `${toPercent(report.totalLossRatio)}%`
    funnel['流失原因分类'] = report.groups.map((group) => group.groupName).join('、')
    funnel['优化建议'] = report.fieldPriority
      .slice(0, 2)
      .map((row) => `${row.fieldKey}(第${row.rank}优先)`)
      .join('；')
    saveRows('funnel', funnelRows)
  }

  const formRows = listRows('formfield')
  const form = formRows.find((row) => String(row['诊断编号']) === definition.formId)
  if (form) {
    form['错误字段'] = report.fieldPriority.map((row) => row.fieldKey).join('、')
    form['放弃率'] = `${toPercent(report.totalLossRatio)}%`
    form['优化方向'] = report.groups
      .slice()
      .sort((a, b) => b.lossCount - a.lossCount)
      .slice(0, 2)
      .map((group) => `${group.groupName}(${group.lossCount})`)
      .join('；')
    saveRows('formfield', formRows)
  }
}

function persist(): void {
  if (cache === null) return
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function createFormState(definition: FormDefinition): PersistedFormState {
  const evidence = clone(BASELINE_EVIDENCE[definition.formId] ?? [])
  const state = {
    definition: clone(definition),
    evidence,
    pendingEvidence: [],
    appliedBatchIds: ['BASELINE'],
    appliedRequestIds: [],
    generatedGroupIds: definition.groups.map((group) => group.groupId),
    report: null as unknown as LossDiagnosisReport,
  }
  const allGroups = new Set(definition.groups.map((group) => group.groupId))
  state.report = rebuildReport(state, allGroups, 1, { complete: true })
  return state
}

function seedSnapshot(): LossEngineSnapshot {
  const forms: Record<string, PersistedFormState> = {}
  for (const definition of FORM_DEFINITIONS) {
    forms[definition.formId] = createFormState(definition)
  }
  return { version: 1, forms }
}

function load(): LossEngineSnapshot {
  if (cache !== null) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = seedSnapshot()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = seedSnapshot()
    persist()
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as LossEngineSnapshot
    if (!parsed || parsed.version !== 1 || !parsed.forms) {
      cache = seedSnapshot()
      persist()
      return cache
    }
    // 定义以代码为准，报告沿用本地持久化结果。
    for (const definition of FORM_DEFINITIONS) {
      const state = parsed.forms[definition.formId]
      if (!state) {
        parsed.forms[definition.formId] = createFormState(definition)
        continue
      }
      state.definition = clone(definition)
    }
    cache = parsed
    return cache
  } catch {
    cache = seedSnapshot()
    persist()
    return cache
  }
}

export function resetLossEngine(): void {
  cache = seedSnapshot()
  persist()
}

export function listFormDefinitions(): FormDefinition[] {
  return clone(FORM_DEFINITIONS)
}

export function getFormDefinition(formId: string): FormDefinition {
  return clone(formDefinition(formId))
}

function formState(formId: string): PersistedFormState {
  const snapshot = load()
  const state = snapshot.forms[formId]
  if (!state) {
    throw new Error(`表单 ${formId} 还没有流失诊断数据`)
  }
  return state
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export function getReport(formId: string): LossDiagnosisReport {
  return clone(formState(formId).report)
}

export function listFormSummaries(): FormSummary[] {
  const snapshot = load()
  return FORM_DEFINITIONS.map((definition) => {
    const state = snapshot.forms[definition.formId]
    return {
      formId: definition.formId,
      formName: definition.formName,
      funnelId: definition.funnelId,
      enteredCount: definition.enteredCount,
      groupCount: definition.groups.length,
      revision: state.report.revision,
      totalLoss: state.report.totalLoss,
      totalLossRatio: state.report.totalLossRatio,
      pendingGroupCount: state.report.pending.length,
      updatedAt: state.report.updatedAt,
    }
  })
}

export function getDiagnosisOverview(formId: string): DiagnosisOverview {
  const report = getReport(formId)
  return {
    definition: getFormDefinition(formId),
    report,
    topFields: report.fieldPriority.slice(0, 3),
    pendingGroupCount: report.pending.length,
    groupCount: report.groups.length,
  }
}

export function getFormChecklist(formId: string): FormReviewChecklist {
  const state = formState(formId)
  const report = state.report
  const baseline = priorCompleteOf(state)
  const baselineFields = new Map(baseline.fieldLoss.map((row) => [row.fieldKey, row]))
  const items: FormReviewChecklistItem[] = report.fieldPriority.map((row) => {
    const base = baselineFields.get(row.fieldKey)
    const baselineLoss = base?.countedLoss ?? base?.lossCount ?? 0
    const baselineLossRatio = base?.lossRatio ?? 0
    const changedSinceComplete =
      row.countedLoss !== baselineLoss || row.pendingLoss > 0
    return {
      key: `${row.groupId}:${row.fieldKey}`,
      formId,
      formName: report.formName,
      funnelId: report.funnelId,
      groupId: row.groupId,
      groupName: row.groupName,
      fieldKey: row.fieldKey,
      lossCount: row.countedLoss,
      lossRatio: ratioOf(row.countedLoss, report.enteredCount),
      baselineLoss,
      baselineLossRatio,
      priorityRank: row.rank,
      source: row.source,
      updatedInRevision: row.recalculatedInRevision,
      reportRevision: report.revision,
      lastCompleteRevision: baseline.revision,
      changedSinceComplete,
      optimizationDirection: `${row.groupName} → 优先优化 ${row.fieldKey}`,
      status: changedSinceComplete ? '待复核' : '已对齐',
    }
  })
  return {
    formId,
    formName: report.formName,
    funnelId: report.funnelId,
    reportId: report.reportId,
    revision: report.revision,
    status: report.status,
    updatedAt: report.updatedAt,
    totalLoss: report.totalLoss,
    totalLossRatio: report.totalLossRatio,
    baselineLoss: baseline.totalLoss,
    baselineLossRatio: baseline.totalLossRatio,
    baselineRevision: baseline.revision,
    affectedFieldKeys: [...report.affectedFieldKeys],
    pendingCount: report.pending.length,
    items,
    note:
      report.status === 'complete'
        ? '当前报告为完整流失快照，复核清单与完整报告的流失绝对量、流失占比一致。'
        : `当前为增量报告：只有 ${report.affectedFieldKeys.join('、') || '无'} 被重算，其余字段沿用第 ${baseline.revision} 版完整报告。`,
  }
}

export function getCallChain(formId: string): CallChainResult {
  const state = formState(formId)
  const definition = state.definition
  const report = state.report
  const funnel = listRows('funnel').find((row) => String(row['报告编号']) === definition.funnelId)
  const form = listRows('formfield').find((row) => String(row['诊断编号']) === definition.formId)

  const funnelLoss = funnel ? toNumeric(funnel['流失绝对量']) : 0
  const funnelRatio = funnel ? toNumeric(funnel['流失占比']) : 0
  const formRatio = form ? toNumeric(form['放弃率']) : 0
  const expectedPercent = toPercent(report.totalLossRatio)

  const steps: CallChainStep[] = [
    {
      key: 'funnel',
      module: '漏斗诊断',
      entity: '诊断报告',
      recordId: definition.funnelId,
      fields: {
        流失绝对量: funnelLoss,
        流失占比: `${funnelRatio}%`,
        流失原因分类: String(funnel?.['流失原因分类'] ?? ''),
      },
      synced: Boolean(
        funnel &&
          funnelLoss === report.totalLoss &&
          Math.abs(funnelRatio - expectedPercent) < 0.01,
      ),
    },
    {
      key: 'loss-report',
      module: '流失诊断报告',
      entity: '原因组汇总',
      recordId: report.reportId,
      fields: {
        修订号: report.revision,
        流失绝对量: report.totalLoss,
        流失占比: `${expectedPercent}%`,
        原因组数: report.groups.length,
      },
      synced: true,
    },
    {
      key: 'form',
      module: '表单分析',
      entity: '表单诊断',
      recordId: definition.formId,
      fields: {
        错误字段: String(form?.['错误字段'] ?? ''),
        放弃率: `${formRatio}%`,
        优化方向: String(form?.['优化方向'] ?? ''),
      },
      synced: Boolean(
        form &&
          Math.abs(formRatio - expectedPercent) < 0.01 &&
          String(form['错误字段'] ?? '') === report.fieldPriority.map((row) => row.fieldKey).join('、'),
      ),
    },
  ]

  return {
    formId,
    steps,
    totalsConsistent:
      funnelLoss === report.totalLoss && Math.abs(funnelRatio - expectedPercent) < 0.01,
    moduleRowsSynced: steps.every((step) => step.synced),
  }
}

// ---------------------------------------------------------------------------
// 写入：证据归并
// ---------------------------------------------------------------------------

function normalizeEvidence(
  definition: FormDefinition,
  input: FieldErrorEvidence[],
  appliedIds: Set<string>,
): {
  valid: FieldErrorEvidence[]
  duplicates: string[]
  rejected: string[]
} {
  const valid: FieldErrorEvidence[] = []
  const duplicates: string[] = []
  const rejected: string[] = []
  const seenInBatch = new Set<string>()
  for (const item of input) {
    if (!definition.groups.some((group) => group.fieldKeys.includes(item.fieldKey))) {
      rejected.push(item.evidenceId)
      continue
    }
    if (!item.evidenceId || item.lossCount < 0 || !Number.isFinite(item.lossCount)) {
      rejected.push(item.evidenceId)
      continue
    }
    if (appliedIds.has(item.evidenceId) || seenInBatch.has(item.evidenceId)) {
      duplicates.push(item.evidenceId)
      continue
    }
    seenInBatch.add(item.evidenceId)
    valid.push({ ...item, version: evidenceVersion(item) })
  }
  return { valid, duplicates, rejected }
}

export function mergeEvidenceBatch(input: MergeBatchInput): MergeBatchResult {
  const state = formState(input.formId)
  const definition = state.definition
  const current = state.report
  const requestedAt = input.requestedAt ?? nowIso()
  const affected = new Set<string>()
  for (const item of input.evidence) {
    const group = definition.groups.find((candidate) => candidate.fieldKeys.includes(item.fieldKey))
    if (group) affected.add(group.groupId)
  }
  const affectedFields = new Set<string>()
  for (const groupId of affected) {
    groupOf(definition, groupId).fieldKeys.forEach((field) => affectedFields.add(field))
  }

  if (state.appliedBatchIds.includes(input.batchId)) {
    const groupIds = [
      ...new Set(
        input.evidence
          .map((item) => definition.groups.find((group) => group.fieldKeys.includes(item.fieldKey)))
          .filter((group): group is CauseGroupDefinition => Boolean(group))
          .map((group) => group.groupId),
      ),
    ].sort()
    return {
      ok: true,
      batchId: input.batchId,
      formId: input.formId,
      reportId: current.reportId,
      revision: current.revision,
      wroteReport: false,
      reused: true,
      generatedGroupIds: [],
      reusedGroupIds: groupIds,
      appliedEvidenceIds: [],
      duplicateEvidenceIds: input.evidence.map((item) => item.evidenceId),
      pendingEvidenceIds: [],
      rejectedEvidenceIds: [],
      affectedGroupIds: [],
      affectedFieldKeys: [],
      totalLoss: current.totalLoss,
      totalLossRatio: current.totalLossRatio,
      report: getReport(input.formId),
      message: `批次 ${input.batchId} 已汇总过，后到批次复用第 ${current.revision} 版报告，不重复增加流失量`,
    }
  }

  const appliedIds = new Set(state.evidence.map((item) => item.evidenceId))
  const { valid, duplicates, rejected } = normalizeEvidence(definition, input.evidence, appliedIds)
  const staleConcurrent =
    input.expectedRevision !== undefined && input.expectedRevision < current.revision
  state.appliedBatchIds.push(input.batchId)

  if (staleConcurrent) {
    // 后到批次不覆盖已写入的增量报告；新证据进入组级待汇总，等下一次汇总。
    for (const item of valid) {
      if (!state.pendingEvidence.some((pending) => pending.evidenceId === item.evidenceId)) {
        state.pendingEvidence.push(item)
      }
    }
    state.report = rebuildReport(state, new Set(), current.revision)
    touchModuleRows(state)
    persist()
    return {
      ok: true,
      batchId: input.batchId,
      formId: input.formId,
      reportId: current.reportId,
      revision: current.revision,
      wroteReport: false,
      reused: true,
      generatedGroupIds: [],
      reusedGroupIds: [...affected].sort(),
      appliedEvidenceIds: [],
      duplicateEvidenceIds: duplicates.sort(),
      pendingEvidenceIds: valid.map((item) => item.evidenceId).sort(),
      rejectedEvidenceIds: rejected.sort(),
      affectedGroupIds: [],
      affectedFieldKeys: [],
      totalLoss: state.report.totalLoss,
      totalLossRatio: state.report.totalLossRatio,
      report: getReport(input.formId),
      message: `批次 ${input.batchId} 基于旧修订 ${input.expectedRevision}，拦截报告写入；${valid.length} 份证据转入组级待汇总，复用第 ${current.revision} 版已汇总字段`,
    }
  }

  const fresh = valid.filter(
    (item) => !appliedIds.has(item.evidenceId) && !state.pendingEvidence.some((pending) => pending.evidenceId === item.evidenceId),
  )
  // 已经进入待汇总的新证据这次一并汇总。
  const fromPending = valid.filter((item) =>
    state.pendingEvidence.some((pending) => pending.evidenceId === item.evidenceId),
  )
  const toApply = [...fresh, ...fromPending]
  state.pendingEvidence = state.pendingEvidence.filter(
    (pending) => !toApply.some((item) => item.evidenceId === pending.evidenceId),
  )

  if (!toApply.length) {
    state.report = rebuildReport(state, new Set(), current.revision)
    touchModuleRows(state)
    persist()
    return {
      ok: true,
      batchId: input.batchId,
      formId: input.formId,
      reportId: current.reportId,
      revision: current.revision,
      wroteReport: false,
      reused: true,
      generatedGroupIds: [],
      reusedGroupIds: [...affected].sort(),
      appliedEvidenceIds: [],
      duplicateEvidenceIds: duplicates.sort(),
      pendingEvidenceIds: [],
      rejectedEvidenceIds: rejected.sort(),
      affectedGroupIds: [],
      affectedFieldKeys: [],
      totalLoss: state.report.totalLoss,
      totalLossRatio: state.report.totalLossRatio,
      report: getReport(input.formId),
      message: `批次 ${input.batchId} 没有新增证据，复用第 ${current.revision} 版原因组汇总，不重复增加流失量`,
    }
  }

  for (const item of toApply) {
    if (!state.evidence.some((applied) => applied.evidenceId === item.evidenceId)) {
      state.evidence.push({ ...item, observedAt: item.observedAt || requestedAt })
    }
  }

  const generatedBefore = new Set(state.generatedGroupIds)
  const revision = current.revision + 1
  state.report = rebuildReport(state, affected, revision)
  const generatedGroupIds = [...affected]
    .filter((groupId) => !generatedBefore.has(groupId))
    .sort()
  const reusedGroupIds = [...affected].filter((groupId) => generatedBefore.has(groupId)).sort()
  touchModuleRows(state)
  persist()

  return {
    ok: true,
    batchId: input.batchId,
    formId: input.formId,
    reportId: state.report.reportId,
    revision: state.report.revision,
    wroteReport: true,
    reused: false,
    generatedGroupIds,
    reusedGroupIds,
    appliedEvidenceIds: toApply.map((item) => item.evidenceId).sort(),
    duplicateEvidenceIds: duplicates.sort(),
    pendingEvidenceIds: [],
    rejectedEvidenceIds: rejected.sort(),
    affectedGroupIds: [...affected].sort(),
    affectedFieldKeys: [...affectedFields].sort(),
    totalLoss: state.report.totalLoss,
    totalLossRatio: state.report.totalLossRatio,
    report: getReport(input.formId),
    message: `批次 ${input.batchId} 已写入第 ${revision} 版增量流失报告，只重算 ${[...affectedFields].join('、')}`,
  }
}

export function submitFieldEvidence(request: EvidenceSubmitRequest): EvidenceSubmitResult {
  const state = formState(request.formId)
  const definition = state.definition
  const current = state.report
  const requestId = request.requestId ?? `REQ-${request.formId}-${current.revision + 1}-${nowIso()}`
  const revisionBefore = current.revision

  if (state.appliedRequestIds.includes(requestId)) {
    return {
      ok: false,
      blocked: true,
      blockedReason: 'DUPLICATE_REQUEST',
      wroteReport: false,
      reused: true,
      revisionBefore,
      revisionAfter: current.revision,
      report: getReport(request.formId),
      message: `证据请求 ${requestId} 已处理过，后到请求被拦截`,
    }
  }
  state.appliedRequestIds.push(requestId)

  const expected = request.expectedRevision ?? revisionBefore
  if (expected !== revisionBefore) {
    persist()
    return {
      ok: false,
      blocked: true,
      blockedReason: 'STALE_REVISION',
      wroteReport: false,
      reused: true,
      revisionBefore,
      revisionAfter: current.revision,
      report: getReport(request.formId),
      message: `证据请求基于第 ${expected} 版报告，当前已是第 ${revisionBefore} 版，后到请求被拦截，请读取最新报告后再提交`,
    }
  }
  const group = defGroupForEvidence(definition, request)
  if (!group) {
    persist()
    return {
      ok: false,
      blocked: true,
      blockedReason: 'INVALID_FIELD',
      wroteReport: false,
      reused: true,
      revisionBefore,
      revisionAfter: current.revision,
      report: getReport(request.formId),
      message: `字段 ${request.evidence.fieldKey} 未登记在任何原因组，证据请求被拦截`,
    }
  }

  if (state.evidence.some((item) => item.evidenceId === request.evidence.evidenceId)) {
    persist()
    return {
      ok: true,
      blocked: false,
      wroteReport: false,
      reused: true,
      revisionBefore,
      revisionAfter: current.revision,
      report: getReport(request.formId),
      message: `证据 ${request.evidence.evidenceId} 已汇总，复用现有字段流失量，不重复增加`,
    }
  }

  state.evidence.push({ ...request.evidence, version: evidenceVersion(request.evidence) })
  state.pendingEvidence = state.pendingEvidence.filter(
    (item) => item.evidenceId !== request.evidence.evidenceId,
  )
  state.report = rebuildReport(state, new Set([group.groupId]), current.revision + 1)
  touchModuleRows(state)
  persist()
  return {
    ok: true,
    blocked: false,
    wroteReport: true,
    reused: false,
    revisionBefore,
    revisionAfter: state.report.revision,
    report: getReport(request.formId),
    message: `证据 ${request.evidence.evidenceId} 已写入第 ${state.report.revision} 版增量报告，只重算原因组「${group.groupName}」`,
  }
}

function defGroupForEvidence(
  definition: FormDefinition,
  request: EvidenceSubmitRequest,
): CauseGroupDefinition | null {
  if (request.groupId) {
    const group = definition.groups.find((item) => item.groupId === request.groupId)
    if (group && group.fieldKeys.includes(request.evidence.fieldKey)) return group
    return null
  }
  return definition.groups.find((item) => item.fieldKeys.includes(request.evidence.fieldKey)) ?? null
}

// ---------------------------------------------------------------------------
// 写入：版本冲突仲裁
// ---------------------------------------------------------------------------

export function resolveConflict(input: ConflictResolutionInput): ConflictResolution {
  const state = formState(input.formId)
  const definition = state.definition
  const group = input.groupId
    ? groupOf(definition, input.groupId)
    : groupOfField(definition, input.fieldKey)
  if (!group.fieldKeys.includes(input.fieldKey)) {
    throw new Error(`字段 ${input.fieldKey} 不属于原因组 ${group.groupId}`)
  }
  const current = state.report
  const existing = state.evidence.find((item) => item.evidenceId === input.evidence.evidenceId)
  const sameFieldEvidence = state.evidence.filter((item) => item.fieldKey === input.fieldKey)
  const groupSummaryBefore = current.groups.find((item) => item.groupId === group.groupId)
  const currentGroupVersion = groupSummaryBefore?.version ?? 0
  const incomingVersion = evidenceVersion(input.evidence)
  const expected = input.expectedRevision ?? current.revision

  const currentGroupSummary = (): GroupLossSummary =>
    clone(
      state.report.groups.find((item) => item.groupId === group.groupId) ??
        computeGroup(definition, group, state.evidence, state.pendingEvidence, 'retained', null)
          .summary,
    )
  const currentGroupDrilldown = (): FieldDrilldownRow[] =>
    state.report.drilldown
      .filter((row) => row.groupId === group.groupId)
      .map((row) => clone(row))
  const currentPending = (): GroupPendingAggregation[] =>
    state.report.pending.filter((item) => item.groupId === group.groupId).map((item) => clone(item))
  const result = (
    applied: boolean,
    wroteReport: boolean,
    duplicate: boolean,
    message: string,
  ): ConflictResolution => ({
    strategy: input.strategy,
    applied,
    wroteReport,
    duplicate,
    revision: state.report.revision,
    groupSummary: currentGroupSummary(),
    drilldown: currentGroupDrilldown(),
    fieldPriority: state.report.fieldPriority
      .filter((row) => row.groupId === group.groupId)
      .map((row) => clone(row)),
    pending: currentPending(),
    report: getReport(input.formId),
    message,
  })

  if (expected !== current.revision) {
    return result(false, false, false, `冲突仲裁基于旧修订 ${expected}，当前第 ${current.revision} 版，拒绝写入`)
  }

  if (input.strategy === 'group') {
    // 原因组聚合：组级版本更新时才接收；旧版本证据只进入待汇总，确保组级合计不重复。
    if (existing) {
      return result(false, false, true, `证据 ${input.evidence.evidenceId} 已在组级汇总中，不重复计入`)
    }
    if (incomingVersion < currentGroupVersion) {
      if (!state.pendingEvidence.some((item) => item.evidenceId === input.evidence.evidenceId)) {
        state.pendingEvidence.push({ ...input.evidence })
      }
      state.report = rebuildReport(state, new Set(), current.revision)
      touchModuleRows(state)
      persist()
      return result(
        false,
        false,
        false,
        `证据版本 ${incomingVersion} 低于原因组「${group.groupName}」已汇总版本 ${currentGroupVersion}，转入组级待汇总，组级合计不变`,
      )
    }
    state.evidence.push({ ...input.evidence })
    state.pendingEvidence = state.pendingEvidence.filter(
      (item) => item.evidenceId !== input.evidence.evidenceId,
    )
    state.report = rebuildReport(state, new Set([group.groupId]), current.revision + 1)
    touchModuleRows(state)
    persist()
    return result(
      true,
      true,
      false,
      `按原因组聚合仲裁：证据版本 ${incomingVersion} 已并入「${group.groupName}」，组级流失合计按指纹去重`,
    )
  }

  // 字段明细保序：按 observedAt 稳定排序，重复 evidenceId 不重复计数；
  // 同 evidenceId 的新版本替换旧版本，组级合计不会把同一字段证据加两次。
  if (existing) {
    if (incomingVersion <= evidenceVersion(existing)) {
      return result(false, false, true, `字段明细保序：保留已有较新版本证据 ${existing.evidenceId}，后到证据不重复计入`)
    }
    const relativeIndex = state.evidence.findIndex(
      (item) => item.evidenceId === input.evidence.evidenceId,
    )
    state.evidence[relativeIndex] = { ...input.evidence }
    state.report = rebuildReport(state, new Set([group.groupId]), current.revision + 1)
    touchModuleRows(state)
    persist()
    return result(
      true,
      true,
      false,
      `字段明细保序：证据 ${input.evidence.evidenceId} 以版本 ${incomingVersion} 替换旧版本，组级合计不重复`,
    )
  }

  const sameFieldSameVersion = sameFieldEvidence.some(
    (item) =>
      item.fingerprint &&
      input.evidence.fingerprint &&
      item.fingerprint === input.evidence.fingerprint &&
      evidenceVersion(item) > incomingVersion,
  )
  if (sameFieldSameVersion) {
    if (!state.pendingEvidence.some((item) => item.evidenceId === input.evidence.evidenceId)) {
      state.pendingEvidence.push({ ...input.evidence })
    }
    state.report = rebuildReport(state, new Set(), current.revision)
    touchModuleRows(state)
    persist()
    return result(
      false,
      false,
      false,
      `字段明细保序：同字段已有更新版本证据，后到证据转入组级待汇总`,
    )
  }

  state.evidence.push({ ...input.evidence })
  state.pendingEvidence = state.pendingEvidence.filter(
    (item) => item.evidenceId !== input.evidence.evidenceId,
  )
  state.report = rebuildReport(state, new Set([group.groupId]), current.revision + 1)
  touchModuleRows(state)
  persist()
  return result(
    true,
    true,
    false,
    `字段明细保序：证据 ${input.evidence.evidenceId} 已插入「${input.fieldKey}」下钻清单，组级合计按指纹去重`,
  )
}

// ---------------------------------------------------------------------------
// 完整重算 / 模块联动
// ---------------------------------------------------------------------------

export function recomputeCompleteReport(formId: string): LossDiagnosisReport {
  const state = formState(formId)
  const allGroups = new Set(state.definition.groups.map((group) => group.groupId))
  state.report = rebuildReport(state, allGroups, state.report.revision + 1, { complete: true })
  touchModuleRows(state)
  persist()
  return getReport(formId)
}

export function syncDiagnosisModules(formId: string): CallChainResult {
  const state = formState(formId)
  touchModuleRows(state)
  persist()
  return getCallChain(formId)
}

export function findGroupOfField(formId: string, fieldKey: string): CauseGroupDefinition {
  return clone(groupOfField(formDefinition(formId), fieldKey))
}

export function getFormStateForTest(formId: string): PersistedFormState {
  return clone(formState(formId))
}

export function moduleRowSnapshot(moduleKey: 'funnel' | 'formfield', recordId: string): EntryRow | null {
  const row = listRows(moduleKey).find((item) =>
    moduleKey === 'funnel'
      ? String(item['报告编号']) === recordId
      : String(item['诊断编号']) === recordId,
  )
  return row ? clone(row) : null
}

/** 供测试/调试：验证当前报告的所有合计关系。 */
export function checkReportInvariants(report: LossDiagnosisReport): string[] {
  const errors: string[] = []
  let groupSum = 0
  for (const group of report.groups) {
    const fields = report.drilldown.filter((row) => row.groupId === group.groupId)
    const counted = fields.reduce((sum, row) => sum + row.countedLoss, 0)
    if (counted !== group.lossCount) {
      errors.push(`原因组 ${group.groupId} 字段计入合计 ${counted} 与组级流失 ${group.lossCount} 不一致`)
    }
    const duplicated = fields.reduce((sum, row) => sum + row.duplicateLoss, 0)
    const total = fields.reduce((sum, row) => sum + row.lossCount, 0)
    if (total - duplicated !== group.lossCount) {
      errors.push(`原因组 ${group.groupId} 去重后合计与下钻总量不一致`)
    }
    groupSum += group.lossCount
  }
  if (groupSum !== report.totalLoss) {
    errors.push(`组级合计 ${groupSum} 与报告流失绝对量 ${report.totalLoss} 不一致`)
  }
  if (report.drilldown.some((row) => row.countedLoss > row.lossCount)) {
    errors.push('存在单字段计入量大于字段流失量的记录')
  }
  if (!Number.isFinite(report.totalLossRatio)) {
    errors.push('流失占比不是有效数字')
  }
  return errors
}
