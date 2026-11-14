// D 模块 · E（规则与版本）适配器
//
// 校验、表决、版本守卫的规则归 E。她的 rules/ 合并进 main 后，
// 这里自动改用真实现；没合并前用同签名的本地兜底，保证 D 能独立跑通。
//
// 契约来源：docs/rules-api.md（E 的 PR #1）

let upstream = null;
try {
  upstream = await import('../../rules/index.mjs');
} catch {
  upstream = null;
}

export const usingUpstreamRules = Boolean(upstream);

// ---------------------------------------------------------------- 兜底实现
// 与 E 的契约同签名、同语义（金额单位：分；totalFen=null 表示缺价）。
export function thresholdOf(eligibleCount) {
  return Math.floor(eligibleCount / 2) + 1;
}

export function knownTotalFen(plan) {
  return (plan?.expenses ?? []).reduce(
    (sum, expense) => sum + (Number.isSafeInteger(expense?.totalFen) ? expense.totalFen : 0),
    0,
  );
}

function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function issue(code, severity, location, message, suggestion, extra = {}) {
  return { code, severity, location, message, suggestion, ...extra };
}

function fallbackValidatePlan(plan, context = {}) {
  const issues = [];
  const days = plan?.days ?? [];
  const expenses = plan?.expenses ?? [];
  const budgetFen = context.budgetFen;
  const mustVisit = (context.mustVisit ?? []).map(item => String(item).trim()).filter(Boolean);
  const dietary = (context.dietaryRestrictions ?? []).map(item => String(item).trim()).filter(Boolean);
  const places = context.evidence?.places ?? {};

  const total = knownTotalFen(plan);
  if (Number.isSafeInteger(budgetFen) && total > budgetFen) {
    issues.push(issue('V-BUDGET', 'blocking', '费用合计',
      `团队已知费用 ${total} 分，超出预算 ${budgetFen} 分（超支 ${total - budgetFen} 分）。`,
      '压缩住宿、交通等可选项，或与成员确认提高预算。'));
  }
  expenses.forEach((expense, index) => {
    if (Number.isSafeInteger(expense?.totalFen)) return;
    const name = expense?.label || expense?.category || `第 ${index + 1} 项`;
    issues.push(issue('V-PRICE-MISSING', 'warning', `费用·${name}`,
      `「${name}」缺少报价，未计入已知费用合计。`,
      '补充报价，或由成员人工确认口径后重新校验。',
      { requiresConfirmation: true }));
  });

  const visited = new Set();
  days.forEach((day, dayIndex) => {
    const activities = day?.activities ?? [];
    const parsed = activities.map(activity => ({
      activity,
      place: activity?.place ?? '',
      start: toMinutes(activity?.start),
      end: toMinutes(activity?.end),
    }));
    parsed.forEach(({ place, start, end }) => {
      if (start === null || end === null) {
        issues.push(issue('V-TIME', 'blocking', `第${dayIndex + 1}天`,
          `「${place}」起止时间无法解析，需为 HH:mm 格式。`, '补全开始与结束时间。'));
      } else if (end <= start) {
        issues.push(issue('V-TIME', 'blocking', `第${dayIndex + 1}天`,
          `「${place}」结束时间不晚于开始时间。`, '调整起止时间，保证结束晚于开始。'));
      }
    });
    const ordered = parsed
      .filter(item => item.start !== null && item.end !== null && item.end > item.start)
      .sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].start < ordered[index - 1].end) {
        issues.push(issue('V-TIME-CONFLICT', 'blocking', `第${dayIndex + 1}天`,
          `「${ordered[index].place}」与「${ordered[index - 1].place}」时间重叠。`,
          '错开相邻活动的开始与结束时间。'));
      }
    }
    parsed.forEach(item => {
      if (item.place) visited.add(item.place);
      const hours = places[item.place];
      if (!hours) return;
      const open = toMinutes(hours.open);
      const close = toMinutes(hours.close);
      if (item.start === null || item.end === null || open === null || close === null) return;
      if (item.start < open || item.end > close) {
        issues.push(issue('V-HOURS', 'blocking', `第${dayIndex + 1}天·${item.place}`,
          `「${item.place}」营业时间为 ${hours.open}–${hours.close}，行程为 ${item.activity.start}–${item.activity.end}。`,
          '将游览时间调整到营业时段内。'));
      }
    });
    parsed.forEach(item => {
      const contains = item.activity?.contains ?? [];
      if (!Array.isArray(contains) || contains.length === 0) return;
      const hits = dietary.filter(restriction => contains.some(dish => String(dish).includes(restriction)));
      if (hits.length > 0) {
        issues.push(issue('V-DIET', 'blocking', `第${dayIndex + 1}天·${item.place || '用餐'}`,
          `「${item.place || '用餐'}」含禁忌食材：${hits.join('、')}。`, '替换菜品。'));
      }
      if (item.activity?.confidence === 'low') {
        issues.push(issue('V-SOURCE', 'warning', `第${dayIndex + 1}天·${item.place || '活动'}`,
          `「${item.place || '活动'}」数据来源可信度低。`, '改用高可信来源，或人工复核。'));
      }
    });
  });

  mustVisit.forEach(place => {
    if (!visited.has(place)) {
      issues.push(issue('V-MUST-VISIT', 'blocking', `必去·${place}`,
        `必去地点「${place}」未出现在行程中。`, '补充该地点，或与成员确认后移除必去要求。'));
    }
  });

  const blocking = issues.filter(item => item.severity === 'blocking');
  const warnings = issues.filter(item => item.severity === 'warning');
  const requiresConfirmation = issues.filter(item => item.requiresConfirmation);
  return {
    issues,
    knownTotalFen: total,
    unknownCount: expenses.length - expenses.filter(item => Number.isSafeInteger(item?.totalFen)).length,
    blocking,
    warnings,
    requiresConfirmation,
    hasBlocking: blocking.length > 0,
    hasUnknownPrice: requiresConfirmation.length > 0,
  };
}

function fallbackDecideGate(result) {
  if (result?.blocking?.length) {
    return { action: 'block', reason: '存在硬约束冲突，需先处理。', issues: result.blocking };
  }
  if (result?.requiresConfirmation?.length) {
    return { action: 'confirm', reason: '存在未确认报价，需人工确认口径。', issues: result.requiresConfirmation };
  }
  return { action: 'publish', reason: '校验通过，可进入表决与发布。' };
}

function fallbackCreateVote(version, eligible) {
  const members = [...new Set(eligible)];
  return { version, eligible: members, votes: {}, threshold: thresholdOf(members.length) };
}

function fallbackCastVote(vote, memberId, choice) {
  if (!vote.eligible.includes(memberId)) return { ok: false, message: '该成员不在本轮表决资格名单中。' };
  if (!['approve', 'reject', 'abstain'].includes(choice)) return { ok: false, message: '无效的票型。' };
  if (Object.hasOwn(vote.votes, memberId)) return { ok: false, message: '该成员本轮已投过票。' };
  vote.votes[memberId] = choice;
  return { ok: true };
}

function fallbackTally(vote) {
  const choices = Object.values(vote.votes);
  const approve = choices.filter(choice => choice === 'approve').length;
  const reject = choices.filter(choice => choice === 'reject').length;
  const abstain = choices.filter(choice => choice === 'abstain').length;
  const remaining = vote.eligible.length - choices.length;
  let status = 'open';
  if (approve >= vote.threshold) status = 'passed';
  else if (approve + remaining < vote.threshold) status = 'failed';
  return { approve, reject, abstain, threshold: vote.threshold, eligible: vote.eligible.length, remaining, status };
}

function fallbackProposeCandidate(plans, draft) {
  const maxVersion = plans.reduce((max, plan) => Math.max(max, plan?.version || 0), 0);
  const version = maxVersion + 1;
  return { ...draft, id: draft?.id || `v${version}`, version, status: 'candidate' };
}

function fallbackPublishCandidate(plans, candidateId, baseOfficialVersion) {
  const official = plans.find(plan => plan?.status === 'official');
  const currentOfficialVersion = official ? official.version : null;
  if (currentOfficialVersion !== baseOfficialVersion) {
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      message: `正式版本已从 v${baseOfficialVersion ?? '无'} 变更为 v${currentOfficialVersion ?? '无'}，本次发布被拒绝。`,
      currentOfficialVersion,
    };
  }
  const candidate = plans.find(plan => plan?.id === candidateId && plan?.status === 'candidate');
  if (!candidate) return { ok: false, code: 'NOT_FOUND', message: '找不到待发布的候选方案。' };
  const next = plans.map(plan => {
    if (plan.id === candidateId) return { ...plan, status: 'official' };
    if (plan.status === 'official') return { ...plan, status: 'archived' };
    return plan;
  });
  return { ok: true, plans: next, publishedVersion: candidate.version };
}

// ---------------------------------------------------------------- 导出
export const validatePlan = upstream?.validatePlan ?? fallbackValidatePlan;
export const decideGate = upstream?.decideGate ?? fallbackDecideGate;
export const createVote = upstream?.createVote ?? fallbackCreateVote;
export const castVote = upstream?.castVote ?? fallbackCastVote;
export const tally = upstream?.tally ?? fallbackTally;
export const proposeCandidate = upstream?.proposeCandidate ?? fallbackProposeCandidate;
export const publishCandidate = upstream?.publishCandidate ?? fallbackPublishCandidate;
