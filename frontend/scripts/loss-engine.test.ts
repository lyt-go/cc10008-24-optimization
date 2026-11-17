import assert from 'node:assert/strict'

import { listRows, saveRows } from '@/data/local-store'
import {
  checkReportInvariants,
  getCallChain,
  getFormChecklist,
  getFormDefinition,
  getFormStateForTest,
  getReport,
  listFormDefinitions,
  listFormSummaries,
  mergeEvidenceBatch,
  moduleRowSnapshot,
  recomputeCompleteReport,
  resetLossEngine,
  resolveConflict,
  submitFieldEvidence,
  syncDiagnosisModules,
} from '@/data/loss-engine'

function resetAll(): void {
  resetLossEngine()
  // 模块行可能已被上一轮测试改写，写回样例文本，让模块同步断言从干净状态开始。
  const funnel = listRows('funnel')
  const form = listRows('formfield')
  for (const row of funnel) {
    row['流失绝对量'] = String(row.id)
    row['流失占比'] = '0%'
    row['流失原因分类'] = String(row.id)
    row['优化建议'] = String(row.id)
  }
  for (const row of form) {
    row['错误字段'] = String(row.id)
    row['放弃率'] = '0%'
    row['优化方向'] = String(row.id)
  }
  saveRows('funnel', funnel)
  saveRows('formfield', form)
  // 报告由本地状态重建后，把漏斗诊断/表单分析两个模块行同步到最新报告。
  for (const definition of listFormDefinitions()) {
    syncDiagnosisModules(definition.formId)
  }
}

function testBaseline(): void {
  resetAll()
  const report = getReport('FORM-0001')
  assert.equal(report.status, 'complete')
  assert.equal(report.revision, 1)
  // 手机号 120 + 备用手机号 45 + 45（与手机号同指纹，组级只计一次）+ 地址 80 + 城市 30
  // 备用手机号的 EV-F1-003 与手机号 EV-F1-001 同指纹，组级只计一次：120 + 45 = 165
  const g1 = report.groups.find((item) => item.groupId === 'FORM-0001-G1')!
  assert.equal(g1.lossCount, 165)
  assert.equal(g1.evidenceCount, 3)
  assert.equal(g1.dedupedEvidenceCount, 2)
  const g2 = report.groups.find((item) => item.groupId === 'FORM-0001-G2')!
  assert.equal(g2.lossCount, 110)
  assert.equal(report.totalLoss, 275)
  assert.equal(report.totalLossRatio, 0.2292)
  const phone = report.drilldown.find((row) => row.fieldKey === '手机号')!
  const backup = report.drilldown.find((row) => row.fieldKey === '备用手机号')!
  assert.equal(phone.lossCount, 120)
  assert.equal(backup.lossCount, 90)
  // 备用手机号的 45 被指纹去重，但下钻保留
  assert.equal(backup.duplicateLoss, 45)
  assert.equal(
    report.drilldown.filter((row) => row.groupId === 'FORM-0001-G1').reduce((sum, row) => sum + row.countedLoss, 0),
    g1.lossCount,
  )
  assert.deepEqual(checkReportInvariants(report), [])
  assert.equal(report.fieldPriority[0].fieldKey, '手机号')
  const chain = getCallChain('FORM-0001')
  assert.equal(chain.totalsConsistent, true)
  assert.equal(chain.moduleRowsSynced, true)
  assert.equal(moduleRowSnapshot('funnel', 'FUNN-0001')!['流失绝对量'], '275')
  assert.equal(moduleRowSnapshot('formfield', 'FORM-0001')!['放弃率'], '22.92%')
  const checklist = getFormChecklist('FORM-0001')
  assert.equal(checklist.status, 'complete')
  assert.equal(checklist.items.length, 4)
  assert.ok(checklist.items.every((item) => item.status === '已对齐'))
}

function testTwoFieldsOneGroup(): void {
  resetAll()
  const definition = getFormDefinition('FORM-0001')
  const group = definition.groups[0]
  assert.deepEqual(group.fieldKeys, ['手机号', '备用手机号'])
  const before = getReport('FORM-0001')
  const result = mergeEvidenceBatch({
    batchId: 'B-DUP-FIELDS',
    formId: 'FORM-0001',
    evidence: [
      { evidenceId: 'EV-N-1', fieldKey: '手机号', lossCount: 20, observedAt: '2026-09-10T10:00:00.000Z', fingerprint: 'user-900', version: 1 },
      { evidenceId: 'EV-N-2', fieldKey: '备用手机号', lossCount: 20, observedAt: '2026-09-10T10:01:00.000Z', fingerprint: 'user-900', version: 1 },
    ],
  })
  assert.equal(result.wroteReport, true)
  assert.equal(result.revision, before.revision + 1)
  const report = result.report
  const g1 = report.groups.find((item) => item.groupId === group.groupId)!
  // 同一个流失用户同时体现在两个字段：字段各 20，组级只增加 20。
  assert.equal(g1.lossCount, 165 + 20)
  assert.equal(report.totalLoss, 295)
  const phone = report.drilldown.find((row) => row.fieldKey === '手机号')!
  const backup = report.drilldown.find((row) => row.fieldKey === '备用手机号')!
  assert.equal(phone.lossCount, 140)
  assert.equal(backup.lossCount, 110)
  assert.equal(phone.countedLoss + backup.countedLoss, g1.lossCount)
  assert.deepEqual(checkReportInvariants(report), [])
  // 未受影响的原因组继续读取上一完整报告的绝对量与占比
  const g2 = report.groups.find((item) => item.groupId === 'FORM-0001-G2')!
  assert.equal(g2.source, 'retained')
  assert.equal(g2.lossCount, 110)
  assert.equal(g2.recalculatedInRevision, null)
  assert.equal(g2.retainedFromRevision, before.revision)
  const chain = getCallChain('FORM-0001')
  assert.equal(chain.totalsConsistent, true)
  assert.equal(chain.moduleRowsSynced, true)
}

function testConcurrentBatches(): void {
  resetAll()
  const base = getReport('FORM-0001')
  const first = mergeEvidenceBatch({
    batchId: 'B-001',
    formId: 'FORM-0001',
    expectedRevision: base.revision,
    evidence: [
      { evidenceId: 'EV-C-1', fieldKey: '手机号', lossCount: 10, observedAt: '2026-09-11T10:00:00.000Z', fingerprint: 'user-c1', version: 1 },
    ],
  })
  assert.equal(first.wroteReport, true)
  assert.equal(first.revision, base.revision + 1)
  assert.deepEqual(first.generatedGroupIds, [])

  const second = mergeEvidenceBatch({
    batchId: 'B-002',
    formId: 'FORM-0001',
    // 两个批次同时读到同一版报告
    expectedRevision: base.revision,
    evidence: [
      { evidenceId: 'EV-C-2', fieldKey: '备用手机号', lossCount: 10, observedAt: '2026-09-11T10:00:01.000Z', fingerprint: 'user-c2', version: 1 },
    ],
  })
  assert.equal(second.wroteReport, false)
  assert.equal(second.reused, true)
  assert.equal(second.revision, first.revision)
  assert.equal(second.totalLoss, first.totalLoss)
  assert.deepEqual(second.appliedEvidenceIds, [])
  assert.deepEqual(second.pendingEvidenceIds, ['EV-C-2'])
  assert.deepEqual(second.generatedGroupIds, [])
  const state = getFormStateForTest('FORM-0001')
  assert.equal(state.report.totalLoss, 285) // 275 + 10，后到批次只复用不累加
  assert.equal(state.report.pending.length, 1)

  // 后到批次携带与首个批次相同的证据：复用已汇总字段，不重复增加流失量
  const third = mergeEvidenceBatch({
    batchId: 'B-003',
    formId: 'FORM-0001',
    expectedRevision: base.revision,
    evidence: [
      { evidenceId: 'EV-C-1', fieldKey: '手机号', lossCount: 10, observedAt: '2026-09-11T10:00:00.000Z', fingerprint: 'user-c1', version: 1 },
    ],
  })
  assert.equal(third.wroteReport, false)
  assert.deepEqual(third.duplicateEvidenceIds, ['EV-C-1'])
  assert.equal(third.totalLoss, 285)

  // 重放同一批次号：只返回一份报告快照
  const replay = mergeEvidenceBatch({
    batchId: 'B-001',
    formId: 'FORM-0001',
    evidence: [
      { evidenceId: 'EV-C-1', fieldKey: '手机号', lossCount: 10, observedAt: '2026-09-11T10:00:00.000Z', fingerprint: 'user-c1', version: 1 },
    ],
  })
  assert.equal(replay.wroteReport, false)
  assert.equal(replay.revision, first.revision)
  assert.equal(replay.totalLoss, 285)
  assert.deepEqual(checkReportInvariants(getReport('FORM-0001')), [])

  // 后续批次把待汇总证据汇总进来：只汇一次，不会把 B-002 的 10 重复计入。
  const settlePending = mergeEvidenceBatch({
    batchId: 'B-004',
    formId: 'FORM-0001',
    evidence: [
      { evidenceId: 'EV-C-2', fieldKey: '备用手机号', lossCount: 10, observedAt: '2026-09-11T10:00:01.000Z', fingerprint: 'user-c2', version: 1 },
    ],
  })
  assert.equal(settlePending.wroteReport, true)
  assert.deepEqual(settlePending.appliedEvidenceIds, ['EV-C-2'])
  assert.equal(settlePending.totalLoss, 295) // 275 + 10 + 10，两份证据各计一次
  assert.equal(settlePending.report.pending.length, 0)
  assert.deepEqual(checkReportInvariants(settlePending.report), [])
}

function testConcurrentOperationRequests(): void {
  resetAll()
  const base = getReport('FORM-0001')
  const first = submitFieldEvidence({
    requestId: 'REQ-A',
    formId: 'FORM-0001',
    expectedRevision: base.revision,
    evidence: {
      evidenceId: 'EV-R-1',
      fieldKey: '手机号',
      lossCount: 15,
      observedAt: '2026-09-12T10:00:00.000Z',
      fingerprint: 'user-r1',
    },
  })
  assert.equal(first.ok, true)
  assert.equal(first.wroteReport, true)
  assert.equal(first.revisionAfter, base.revision + 1)

  const second = submitFieldEvidence({
    requestId: 'REQ-B',
    formId: 'FORM-0001',
    expectedRevision: base.revision,
    evidence: {
      evidenceId: 'EV-R-2',
      fieldKey: '备用手机号',
      lossCount: 15,
      observedAt: '2026-09-12T10:00:01.000Z',
      fingerprint: 'user-r2',
    },
  })
  assert.equal(second.ok, false)
  assert.equal(second.blocked, true)
  assert.equal(second.blockedReason, 'STALE_REVISION')
  assert.equal(second.wroteReport, false)
  assert.equal(second.report.revision, first.revisionAfter)
  assert.equal(second.report.totalLoss, first.report.totalLoss)

  const duplicateRequest = submitFieldEvidence({
    requestId: 'REQ-A',
    formId: 'FORM-0001',
    evidence: {
      evidenceId: 'EV-R-1',
      fieldKey: '手机号',
      lossCount: 15,
      observedAt: '2026-09-12T10:00:00.000Z',
      fingerprint: 'user-r1',
    },
  })
  assert.equal(duplicateRequest.blocked, true)
  assert.equal(duplicateRequest.blockedReason, 'DUPLICATE_REQUEST')

  const state = getFormStateForTest('FORM-0001')
  assert.equal(state.report.revision, first.revisionAfter)
  assert.equal(state.evidence.filter((item) => item.evidenceId === 'EV-R-2').length, 0)
  assert.equal(state.report.totalLoss, 290)
}

function testConflictGroupStrategy(): void {
  resetAll()
  const report = getReport('FORM-0001')
  const group = report.groups.find((item) => item.groupId === 'FORM-0001-G1')!
  const before = group.lossCount
  const resolution = resolveConflict({
    formId: 'FORM-0001',
    fieldKey: '手机号',
    evidence: {
      evidenceId: 'EV-X-1',
      fieldKey: '手机号',
      lossCount: 30,
      observedAt: '2026-09-13T10:00:00.000Z',
      fingerprint: 'user-x1',
      version: 2,
    },
    strategy: 'group',
    expectedRevision: report.revision,
  })
  assert.equal(resolution.strategy, 'group')
  assert.equal(resolution.applied, true)
  assert.equal(resolution.wroteReport, true)
  assert.equal(resolution.groupSummary.lossCount, before + 30)
  assert.equal(resolution.report.totalLoss, report.totalLoss + 30)
  assert.deepEqual(checkReportInvariants(resolution.report), [])

  // 旧版本证据同时到达：进入组级待汇总，组级合计不再增加
  const stale = resolveConflict({
    formId: 'FORM-0001',
    fieldKey: '手机号',
    evidence: {
      evidenceId: 'EV-X-2',
      fieldKey: '手机号',
      lossCount: 30,
      observedAt: '2026-09-13T09:00:00.000Z',
      fingerprint: 'user-x2',
      version: 1,
    },
    strategy: 'group',
    expectedRevision: resolution.report.revision,
  })
  assert.equal(stale.applied, false)
  assert.equal(stale.wroteReport, false)
  assert.equal(stale.groupSummary.lossCount, before + 30)
  assert.equal(stale.report.totalLoss, report.totalLoss + 30)
  assert.equal(stale.pending.length, 1)
  assert.deepEqual(stale.pending[0].pendingEvidenceIds, ['EV-X-2'])
}

function testConflictFieldStrategy(): void {
  resetAll()
  const report = getReport('FORM-0001')
  const before = report.groups.find((item) => item.groupId === 'FORM-0001-G1')!.lossCount
  const resolution = resolveConflict({
    formId: 'FORM-0001',
    fieldKey: '备用手机号',
    evidence: {
      evidenceId: 'EV-Y-1',
      fieldKey: '备用手机号',
      lossCount: 25,
      observedAt: '2026-09-14T10:00:00.000Z',
      fingerprint: 'user-y1',
      version: 2,
    },
    strategy: 'field',
    expectedRevision: report.revision,
  })
  assert.equal(resolution.applied, true)
  assert.equal(resolution.groupSummary.lossCount, before + 25)
  const drilldown = resolution.drilldown
  assert.equal(drilldown.reduce((sum, row) => sum + row.countedLoss, 0), resolution.groupSummary.lossCount)
  assert.equal(resolution.fieldPriority[0].fieldKey, '手机号')

  // 已存在同一 evidenceId 的较新版本：保序不替换，不重复计数
  const duplicate = resolveConflict({
    formId: 'FORM-0001',
    fieldKey: '备用手机号',
    evidence: {
      evidenceId: 'EV-Y-1',
      fieldKey: '备用手机号',
      lossCount: 25,
      observedAt: '2026-09-14T10:00:00.000Z',
      fingerprint: 'user-y1',
      version: 2,
    },
    strategy: 'field',
    expectedRevision: resolution.report.revision,
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.applied, false)
  assert.equal(duplicate.groupSummary.lossCount, before + 25)
  assert.equal(duplicate.report.totalLoss, resolution.report.totalLoss)

  // 旧版本同 evidenceId：同样被保序挡住
  const older = resolveConflict({
    formId: 'FORM-0001',
    fieldKey: '备用手机号',
    evidence: {
      evidenceId: 'EV-Y-1',
      fieldKey: '备用手机号',
      lossCount: 25,
      observedAt: '2026-09-13T10:00:00.000Z',
      fingerprint: 'user-y1',
      version: 1,
    },
    strategy: 'field',
    expectedRevision: resolution.report.revision,
  })
  assert.equal(older.duplicate, true)
  assert.equal(older.groupSummary.lossCount, before + 25)

  // 新版本同 evidenceId 替换旧版本，组级合计保持单向增长而不是叠加两次
  const upgraded = resolveConflict({
    formId: 'FORM-0001',
    fieldKey: '备用手机号',
    evidence: {
      evidenceId: 'EV-Y-1',
      fieldKey: '备用手机号',
      lossCount: 30,
      observedAt: '2026-09-14T11:00:00.000Z',
      fingerprint: 'user-y1',
      version: 3,
    },
    strategy: 'field',
    expectedRevision: resolution.report.revision,
  })
  assert.equal(upgraded.applied, true)
  assert.equal(upgraded.groupSummary.lossCount, before + 30)
  assert.deepEqual(checkReportInvariants(upgraded.report), [])
}

function testChecklistIncremental(): void {
  resetAll()
  const baseline = getReport('FORM-0002')
  assert.equal(baseline.totalLoss, 150) // 证件号 90（与证件有效期同指纹）+ 邮箱 60
  const merge = mergeEvidenceBatch({
    batchId: 'B-F2-1',
    formId: 'FORM-0002',
    evidence: [
      { evidenceId: 'EV-F2-N1', fieldKey: '证件号', lossCount: 35, observedAt: '2026-09-15T10:00:00.000Z', fingerprint: 'user-n1', version: 1 },
    ],
  })
  assert.equal(merge.wroteReport, true)
  const checklist = getFormChecklist('FORM-0002')
  assert.equal(checklist.status, 'incremental')
  assert.deepEqual(checklist.affectedFieldKeys, ['证件号', '证件有效期'])
  assert.equal(checklist.baselineRevision, baseline.revision)
  assert.equal(checklist.baselineLoss, baseline.totalLoss)
  const changed = checklist.items.filter((item) => item.changedSinceComplete)
  assert.deepEqual(changed.map((item) => item.fieldKey), ['证件号'])
  // 同组另一个字段被重算但没有变化，复核清单里仍然是「已对齐」
  const unchangedInGroup = checklist.items.find((item) => item.fieldKey === '证件有效期')!
  assert.equal(unchangedInGroup.status, '已对齐')
  assert.equal(unchangedInGroup.source, 'incremental')
  assert.equal(unchangedInGroup.updatedInRevision, merge.revision)
  const untouched = checklist.items.find((item) => item.fieldKey === '邮箱')!
  assert.equal(untouched.status, '已对齐')
  assert.equal(untouched.lossCount, 60)
  assert.equal(untouched.reportRevision, merge.revision)

  // 完整重算后复核清单回到全部对齐
  const complete = recomputeCompleteReport('FORM-0002')
  assert.equal(complete.status, 'complete')
  const after = getFormChecklist('FORM-0002')
  assert.ok(after.items.every((item) => item.status === '已对齐'))
  assert.equal(after.baselineRevision, complete.revision)
  const summary = listFormSummaries().find((item) => item.formId === 'FORM-0002')!
  assert.equal(summary.revision, complete.revision)
  assert.equal(summary.totalLoss, complete.totalLoss)
}

function testCallChainAcrossModules(): void {
  resetAll()
  mergeEvidenceBatch({
    batchId: 'B-F3-1',
    formId: 'FORM-0003',
    evidence: [
      { evidenceId: 'EV-F3-N1', fieldKey: '短信验证码', lossCount: 12, observedAt: '2026-09-16T10:00:00.000Z', fingerprint: 'user-z1', version: 1 },
    ],
  })
  const chain = getCallChain('FORM-0003')
  assert.equal(chain.steps.length, 3)
  assert.deepEqual(chain.steps.map((step) => step.key), ['funnel', 'loss-report', 'form'])
  assert.equal(chain.totalsConsistent, true)
  assert.equal(chain.moduleRowsSynced, true)
  assert.equal(chain.steps[0].recordId, 'FUNN-0003')
  assert.equal(chain.steps[2].fields['错误字段'], '短信验证码')
  assert.equal(moduleRowSnapshot('funnel', 'FUNN-0003')!['流失绝对量'], '67')
  assert.equal(moduleRowSnapshot('formfield', 'FORM-0003')!['放弃率'], '11.17%')
}

function testInvalidAndDuplicateEvidence(): void {
  resetAll()
  const result = mergeEvidenceBatch({
    batchId: 'B-BAD',
    formId: 'FORM-0003',
    evidence: [
      { evidenceId: 'EV-BAD-1', fieldKey: '不存在的字段', lossCount: 5, observedAt: '2026-09-17T10:00:00.000Z' },
      { evidenceId: 'EV-DUP-1', fieldKey: '短信验证码', lossCount: 5, observedAt: '2026-09-17T10:01:00.000Z' },
      { evidenceId: 'EV-DUP-1', fieldKey: '短信验证码', lossCount: 5, observedAt: '2026-09-17T10:01:00.000Z' },
    ],
  })
  assert.deepEqual(result.rejectedEvidenceIds, ['EV-BAD-1'])
  assert.deepEqual(result.duplicateEvidenceIds, ['EV-DUP-1'])
  assert.deepEqual(result.appliedEvidenceIds, ['EV-DUP-1'])
  assert.equal(result.report.totalLoss, 60)
  assert.deepEqual(checkReportInvariants(result.report), [])
}

const tests: [string, () => void][] = [
  ['baseline totals + call chain', testBaseline],
  ['two error fields in one cause group', testTwoFieldsOneGroup],
  ['two merge batches refresh one form once', testConcurrentBatches],
  ['concurrent operation requests blocked', testConcurrentOperationRequests],
  ['conflict arbitration: group aggregation', testConflictGroupStrategy],
  ['conflict arbitration: field detail ordering', testConflictFieldStrategy],
  ['incremental checklist across modules', testChecklistIncremental],
  ['call chain funnel → report → form', testCallChainAcrossModules],
  ['invalid and duplicate evidence', testInvalidAndDuplicateEvidence],
]

for (const [name, run] of tests) {
  resetAll()
  run()
  console.log(`ok - ${name}`)
}
console.log(`\n${tests.length} scenarios passed`)
