// E 模块 · 规则与版本（三）候选/正式版本管理与发布守卫
//
// 规则：
// - 候选版本：基于当前最大版本号 +1 生成，status = "candidate"。
// - 发布守卫：只有当“当前正式版本”仍等于任务发起时记录的 baseOfficialVersion
//   才允许发布，防止旧任务覆盖新正式版本（乐观并发 / 版本冲突）。
// - 发布成功：候选 → official，原正式版本 → archived。
// - 人工确认未知报价：把缺价项补成明确金额，保留提交者与时间，供重新校验。

/**
 * 生成候选版本。
 * @param {Array} plans 现有方案列表。
 * @param {object} draft 候选内容（不含 id/version/status）。
 */
export function proposeCandidate(plans, draft) {
  const maxVersion = plans.reduce((max, plan) => Math.max(max, plan?.version || 0), 0);
  const version = maxVersion + 1;
  return { ...draft, id: draft?.id || `v${version}`, version, status: 'candidate' };
}

/**
 * 发布候选为正式版本（带版本守卫）。
 * @param {Array} plans 现有方案列表（会被复制，不修改入参）。
 * @param {string} candidateId 待发布候选的 id。
 * @param {number|null} baseOfficialVersion 任务发起时的正式版本号（null 表示当时无正式版本）。
 * @returns {{ ok: boolean, plans?, publishedVersion?, code?, message?, currentOfficialVersion? }}
 */
export function publishCandidate(plans, candidateId, baseOfficialVersion) {
  const official = plans.find(plan => plan?.status === 'official');
  const currentOfficialVersion = official ? official.version : null;

  if (currentOfficialVersion !== baseOfficialVersion) {
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      message: `正式版本已从 v${baseOfficialVersion ?? '无'} 变更为 v${currentOfficialVersion ?? '无'}，`
        + '本次发布被拒绝（旧任务不能覆盖新正式版本）。',
      currentOfficialVersion,
    };
  }

  const candidate = plans.find(plan => plan?.id === candidateId && plan?.status === 'candidate');
  if (!candidate) {
    return { ok: false, code: 'NOT_FOUND', message: '找不到待发布的候选方案。' };
  }

  const next = plans.map(plan => {
    if (plan.id === candidateId) return { ...plan, status: 'official' };
    if (plan.status === 'official') return { ...plan, status: 'archived' };
    return plan;
  });

  return { ok: true, plans: next, publishedVersion: candidate.version };
}

/**
 * 人工确认未知报价：把第 expenseIndex 项缺价补成明确金额（不按 0 元处理），
 * 保留提交者与时间，返回新方案供重新校验。
 */
export function resolveExpense(plan, expenseIndex, { totalFen, confirmedBy, at }) {
  if (!Number.isSafeInteger(totalFen) || totalFen < 0) {
    throw new Error('确认金额必须是非负整数（分）。');
  }
  const expenses = (plan.expenses ?? []).map((expense, index) =>
    index === expenseIndex
      ? { ...expense, totalFen, confirmedBy, confirmedAt: at ?? new Date().toISOString() }
      : expense);
  return { ...plan, expenses };
}
