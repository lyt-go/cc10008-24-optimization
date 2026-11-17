/**
 * 漏斗诊断 → 表单诊断之间的「流失诊断报告」领域类型。
 *
 * 设计口径：
 * - 错误证据（FieldErrorEvidence）以 evidenceId 作为幂等键，同一字段的同一份证据
 *   无论被多少个归并批次/操作请求读到，都只能计入一次。
 * - 原因组（CauseGroupDefinition）把多个错误字段归并到一个流失原因下；组级流失
 *   合计按去重后的证据汇总，字段下钻仍保留每份证据，二者可以互相复算。
 * - 增量报告只重算受影响原因组/字段，未受影响部分沿用上一完整报告的流失绝对量
 *   与流失占比（source = retained / baseline）。
 */

export type ArbitrationStrategy = 'group' | 'field'

export type FieldErrorEvidence = {
  /** 幂等键：同一表单内唯一，重复提交会被判为 duplicate。 */
  evidenceId: string
  /** 字段名，必须登记在所属原因组里。 */
  fieldKey: string
  /** 该证据观察到的流失用户数。 */
  lossCount: number
  /** 观察时间，用于字段明细保序时的稳定排序。 */
  observedAt: string
  /**
   * 可选的流失指纹：同一个用户流失可能同时体现在两个字段上，
   * 组级汇总按指纹去重，字段下钻仍保留两条明细。
   */
  fingerprint?: string
  /** 证据版本，版本冲突仲裁时用于比较新旧。 */
  version?: number
}

export type CauseGroupDefinition = {
  groupId: string
  groupName: string
  /** 同一原因组下的错误字段；两个错误字段可以属于同一组。 */
  fieldKeys: string[]
  /** 对应漏斗步骤，便于从漏斗诊断下钻。 */
  funnelStep: string
}

export type FormDefinition = {
  formId: string
  formName: string
  /** 对应 funnel 模块里的报告编号。 */
  funnelId: string
  /** 流失占比的分母：进入该表单/漏斗步骤的用户量。 */
  enteredCount: number
  groups: CauseGroupDefinition[]
}

export type LossSource = 'baseline' | 'incremental' | 'retained'

export type GroupLossSummary = {
  groupId: string
  groupName: string
  fieldKeys: string[]
  funnelStep: string
  /** 组级去重后的流失绝对量。 */
  lossCount: number
  lossRatio: number
  /** 组内证据版本的最大值，用于和同一字段的新证据做版本仲裁。 */
  version: number
  /** 该组收到的证据条数（含重复指纹）。 */
  evidenceCount: number
  /** 实际计入组级合计的证据条数。 */
  dedupedEvidenceCount: number
  source: LossSource
  recalculatedInRevision: number | null
  /** 未重算时，值来自哪一版报告。 */
  retainedFromRevision?: number
  updatedAt: string
}

export type FieldDrilldownRow = {
  fieldKey: string
  groupId: string
  groupName: string
  /** 该字段全部证据的流失量，用于单字段下钻。 */
  lossCount: number
  /** 计入组级合计的流失量（按 evidenceId / fingerprint 去重后）。 */
  countedLoss: number
  /** 因与组内其他证据同指纹而未重复计入组级合计的流失量。 */
  duplicateLoss: number
  /** 尚未计入组级合计、等待汇总的流失量。 */
  pendingLoss: number
  evidenceCount: number
  evidenceIds: string[]
  pendingEvidenceIds: string[]
  latestObservedAt: string
  version: number
  priorityRank: number
  source: LossSource
  recalculatedInRevision: number | null
  retainedFromRevision?: number
}

export type FieldPriorityRow = {
  fieldKey: string
  groupId: string
  groupName: string
  /** 字段全部流失量（含待汇总证据）。 */
  lossCount: number
  /** 计入组级合计的流失量。 */
  countedLoss: number
  pendingLoss: number
  latestObservedAt: string
  version: number
  rank: number
  source: LossSource
  recalculatedInRevision: number | null
  retainedFromRevision?: number
}

export type GroupPendingAggregation = {
  groupId: string
  groupName: string
  fieldKeys: string[]
  pendingEvidenceIds: string[]
  pendingLoss: number
  reason: string
  sinceRevision: number
}

export type ReportFieldLoss = {
  fieldKey: string
  groupId: string
  lossCount: number
  lossRatio: number
  countedLoss: number
}

export type ReportSnapshot = {
  revision: number
  totalLoss: number
  totalLossRatio: number
  groups: GroupLossSummary[]
  fieldLoss: ReportFieldLoss[]
  updatedAt: string
}

export type PriorCompleteReport = {
  revision: number
  totalLoss: number
  totalLossRatio: number
  groups: GroupLossSummary[]
  fieldLoss: ReportFieldLoss[]
}

export type LossDiagnosisReport = {
  reportId: string
  formId: string
  formName: string
  funnelId: string
  revision: number
  status: 'complete' | 'incremental'
  updatedAt: string
  enteredCount: number
  /** 当前报告口径的流失绝对量（不含待汇总证据）。 */
  totalLoss: number
  /** 当前报告口径的流失占比。 */
  totalLossRatio: number
  groups: GroupLossSummary[]
  drilldown: FieldDrilldownRow[]
  fieldPriority: FieldPriorityRow[]
  pending: GroupPendingAggregation[]
  affectedGroupIds: string[]
  affectedFieldKeys: string[]
  appliedEvidenceIds: string[]
  sourceBatchIds: string[]
  /** 上一份完整报告的流失绝对量 / 占比，未受影响的报告继续读取这里。 */
  lastComplete: ReportSnapshot
}

export type MergeBatchInput = {
  batchId: string
  formId: string
  evidence: FieldErrorEvidence[]
  requestedAt?: string
  /** 提交方读到的报告修订号；低于当前修订说明是并发后到批次。 */
  expectedRevision?: number
}

export type MergeBatchResult = {
  ok: true
  batchId: string
  formId: string
  reportId: string
  revision: number
  /** 只有第一个真正写入报告的批次为 true。 */
  wroteReport: boolean
  /** 后到批次是否复用了已汇总字段。 */
  reused: boolean
  /** 本批次首次生成快照的原因组。 */
  generatedGroupIds: string[]
  /** 复用了已有快照的原因组。 */
  reusedGroupIds: string[]
  appliedEvidenceIds: string[]
  duplicateEvidenceIds: string[]
  rejectedEvidenceIds: string[]
  /** 因并发/版本冲突转入组级待汇总的证据。 */
  pendingEvidenceIds: string[]
  affectedGroupIds: string[]
  affectedFieldKeys: string[]
  totalLoss: number
  totalLossRatio: number
  report: LossDiagnosisReport
  message: string
}

export type EvidenceSubmitRequest = {
  requestId?: string
  formId: string
  evidence: FieldErrorEvidence
  /** 缺省时使用调用发生瞬间读到的报告修订号。 */
  expectedRevision?: number
  strategy?: ArbitrationStrategy
  groupId?: string
}

export type EvidenceSubmitResult = {
  ok: boolean
  blocked: boolean
  blockedReason?: 'STALE_REVISION' | 'INVALID_FORM' | 'INVALID_FIELD' | 'DUPLICATE_REQUEST'
  wroteReport: boolean
  reused: boolean
  revisionBefore: number
  revisionAfter: number
  report: LossDiagnosisReport
  conflict?: ConflictResolution
  message: string
}

export type ConflictResolutionInput = {
  formId: string
  fieldKey: string
  evidence: FieldErrorEvidence
  strategy: ArbitrationStrategy
  groupId?: string
  expectedRevision?: number
}

export type ConflictResolution = {
  strategy: ArbitrationStrategy
  applied: boolean
  wroteReport: boolean
  duplicate: boolean
  revision: number
  groupSummary: GroupLossSummary
  drilldown: FieldDrilldownRow[]
  fieldPriority: FieldPriorityRow[]
  pending: GroupPendingAggregation[]
  report: LossDiagnosisReport
  message: string
}

export type FormSummary = {
  formId: string
  formName: string
  funnelId: string
  enteredCount: number
  groupCount: number
  revision: number
  totalLoss: number
  totalLossRatio: number
  pendingGroupCount: number
  updatedAt: string
}

export type DiagnosisOverview = {
  definition: FormDefinition
  report: LossDiagnosisReport
  topFields: FieldPriorityRow[]
  pendingGroupCount: number
  groupCount: number
}

export type ChecklistItemStatus = '待复核' | '已对齐'

export type FormReviewChecklistItem = {
  key: string
  formId: string
  formName: string
  funnelId: string
  groupId: string
  groupName: string
  fieldKey: string
  /** 计入组级合计的流失量。 */
  lossCount: number
  lossRatio: number
  baselineLoss: number
  baselineLossRatio: number
  priorityRank: number
  source: LossSource
  updatedInRevision: number | null
  reportRevision: number
  lastCompleteRevision: number
  changedSinceComplete: boolean
  optimizationDirection: string
  status: ChecklistItemStatus
}

export type FormReviewChecklist = {
  formId: string
  formName: string
  funnelId: string
  reportId: string
  revision: number
  status: 'complete' | 'incremental'
  updatedAt: string
  totalLoss: number
  totalLossRatio: number
  baselineLoss: number
  baselineLossRatio: number
  baselineRevision: number
  affectedFieldKeys: string[]
  pendingCount: number
  items: FormReviewChecklistItem[]
  note: string
}

export type CallChainStep = {
  key: 'funnel' | 'loss-report' | 'form'
  module: string
  entity: string
  recordId: string
  fields: Record<string, string | number>
  synced: boolean
}

export type CallChainResult = {
  formId: string
  steps: CallChainStep[]
  totalsConsistent: boolean
  moduleRowsSynced: boolean
}

export type PersistedFormState = {
  definition: FormDefinition
  evidence: FieldErrorEvidence[]
  pendingEvidence: FieldErrorEvidence[]
  appliedBatchIds: string[]
  appliedRequestIds: string[]
  generatedGroupIds: string[]
  report: LossDiagnosisReport
}

export type LossEngineSnapshot = {
  version: 1
  forms: Record<string, PersistedFormState>
}
