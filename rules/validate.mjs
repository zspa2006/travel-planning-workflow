// E 模块 · 规则与版本（一）六类确定性校验
//
// 输入：待校验方案（D 产出候选）+ 上下文（C 的输入快照 / F 的证据）
// 输出：结构化问题码 + 阻塞/警告级别 + 已知费用合计。
//
// 六类校验：预算、时间、营业、必去、饮食、数据可信度。
// 关键语义：未知报价（totalFen === null）不按 0 元计入已知合计，
//           而是标记为“待人工确认”（requiresConfirmation）。
//
// 本文件为纯函数：同一输入永远得到同一结果，便于 D 调用、B 展示与自动化测试。

const SEVERITY = { BLOCKING: 'blocking', WARNING: 'warning' };

/** 构造一条结构化问题。extra 可携带 requiresConfirmation 等标记。 */
function issue(code, severity, location, message, suggestion, extra = {}) {
  return { code, severity, location, message, suggestion, ...extra };
}

/** "HH:mm" → 当日分钟数；无法解析或越界返回 null。 */
export function toMinutes(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 已知报价是否有效（整数且非负）。 */
function isKnownFen(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 已知费用合计：未知报价（null/缺失）不计入。 */
export function knownTotalFen(plan) {
  return (plan?.expenses ?? []).reduce(
    (sum, expense) => sum + (isKnownFen(expense?.totalFen) ? expense.totalFen : 0),
    0,
  );
}

/**
 * 校验方案。
 * @param {object} plan 待校验方案 { days: Day[], expenses: Expense[] }。
 * @param {object} [context] 上下文：
 *   - budgetFen: 团队预算上限（分）
 *   - mustVisit: 必去地点（字符串数组）
 *   - dietaryRestrictions: 饮食禁忌（字符串数组）
 *   - evidence.places: { [地点]: { open:"HH:mm", close:"HH:mm" } }（可选）
 * 活动可选字段（F 提供）：kind、contains（菜品/食材）、source、confidence("low" 表示低可信)。
 */
export function validatePlan(plan, context = {}) {
  const issues = [];
  const expenses = plan?.expenses ?? [];
  const days = plan?.days ?? [];
  const mustVisit = (context.mustVisit ?? []).map(v => String(v ?? '').trim()).filter(Boolean);
  const dietary = (context.dietaryRestrictions ?? []).map(v => String(v ?? '').trim()).filter(Boolean);
  const budgetFen = context.budgetFen;
  const places = context.evidence?.places ?? {};

  // ---------------------------------------------------------------- 1. 预算
  const total = knownTotalFen(plan);
  if (budgetFen !== undefined && budgetFen !== null && total > budgetFen) {
    issues.push(issue('V-BUDGET', SEVERITY.BLOCKING, '费用合计',
      `团队已知费用 ${total} 分，超出预算 ${budgetFen} 分（超支 ${total - budgetFen} 分）。`,
      '压缩住宿、交通等可选项，或与成员确认提高预算。'));
  }
  const unknown = expenses.filter(expense => !isKnownFen(expense?.totalFen));
  unknown.forEach((expense, index) => {
    const name = expense?.label || expense?.category || `第 ${index + 1} 项`;
    issues.push(issue('V-PRICE-MISSING', SEVERITY.WARNING, `费用·${name}`,
      `「${name}」缺少报价，未计入已知费用合计。`,
      '补充报价，或由成员人工确认口径后重新校验。',
      { requiresConfirmation: true }));
  });

  // ---------------------------------------------------------------- 2. 时间
  days.forEach((day, dayIndex) => {
    const activities = day?.activities ?? [];
    const dayLabel = `第${dayIndex + 1}天`;
    const parsed = activities.map((activity, index) => {
      const place = activity?.place || `活动${index + 1}`;
      const start = toMinutes(activity?.start);
      const end = toMinutes(activity?.end);
      return { activity, place, start, end };
    });
    parsed.forEach(({ place, start, end }) => {
      if (start === null || end === null) {
        issues.push(issue('V-TIME', SEVERITY.BLOCKING, dayLabel,
          `「${place}」起止时间无法解析，需为 HH:mm 格式。`,
          '补全开始与结束时间。'));
      } else if (end <= start) {
        issues.push(issue('V-TIME', SEVERITY.BLOCKING, dayLabel,
          `「${place}」结束时间不晚于开始时间。`,
          '调整起止时间，保证结束晚于开始。'));
      }
    });
    const valid = parsed
      .filter(item => item.start !== null && item.end !== null && item.end > item.start)
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < valid.length; i += 1) {
      if (valid[i].start < valid[i - 1].end) {
        issues.push(issue('V-TIME-CONFLICT', SEVERITY.BLOCKING, dayLabel,
          `「${valid[i].place}」与「${valid[i - 1].place}」时间重叠。`,
          '错开相邻活动的开始与结束时间。'));
      }
    }
  });

  // ---------------------------------------------------------------- 3. 营业时间
  days.forEach((day, dayIndex) => {
    (day?.activities ?? []).forEach(activity => {
      const hours = places[activity?.place];
      if (!hours) return; // 无营业时间证据：不臆断，交由“数据可信度”兜底
      const start = toMinutes(activity?.start);
      const end = toMinutes(activity?.end);
      const open = toMinutes(hours.open);
      const close = toMinutes(hours.close);
      if (start === null || end === null || open === null || close === null) return;
      if (start < open || end > close) {
        issues.push(issue('V-HOURS', SEVERITY.BLOCKING, `第${dayIndex + 1}天·${activity.place}`,
          `「${activity.place}」营业时间为 ${hours.open}–${hours.close}，行程安排为 ${activity.start}–${activity.end}。`,
          '将游览时间调整到营业时段内。'));
      }
    });
  });

  // ---------------------------------------------------------------- 4. 必去地点
  const visited = new Set();
  days.forEach(day => (day?.activities ?? []).forEach(activity => {
    visited.add(String(activity?.place ?? '').trim());
  }));
  mustVisit.forEach(place => {
    if (!visited.has(place)) {
      issues.push(issue('V-MUST-VISIT', SEVERITY.BLOCKING, `必去·${place}`,
        `必去地点「${place}」未出现在行程中。`,
        '补充该地点的活动安排，或与成员确认后移除必去要求。'));
    }
  });

  // ---------------------------------------------------------------- 5. 饮食禁忌
  days.forEach((day, dayIndex) => {
    (day?.activities ?? []).forEach(activity => {
      const contains = activity?.contains ?? activity?.dietary ?? [];
      if (!Array.isArray(contains) || contains.length === 0) return;
      const hits = dietary.filter(restriction =>
        contains.some(item => String(item).includes(restriction)));
      if (hits.length > 0) {
        issues.push(issue('V-DIET', SEVERITY.BLOCKING, `第${dayIndex + 1}天·${activity.place || '用餐'}`,
          `「${activity.place || '用餐'}」含禁忌食材：${hits.join('、')}。`,
          '替换菜品，或改用不含禁忌食材的用餐安排。'));
      }
    });
  });

  // ---------------------------------------------------------------- 6. 数据可信度
  days.forEach((day, dayIndex) => {
    (day?.activities ?? []).forEach(activity => {
      if (activity?.confidence === 'low') {
        issues.push(issue('V-SOURCE', SEVERITY.WARNING, `第${dayIndex + 1}天·${activity.place || '活动'}`,
          `「${activity.place || '活动'}」数据来源可信度低（${activity.source || '未知来源'}）。`,
          '改用高可信来源，或由成员人工复核。'));
      }
    });
  });

  const blocking = issues.filter(item => item.severity === SEVERITY.BLOCKING);
  const warnings = issues.filter(item => item.severity === SEVERITY.WARNING);
  const requiresConfirmation = issues.filter(item => item.requiresConfirmation);

  return {
    issues,
    knownTotalFen: total,
    unknownCount: unknown.length,
    blocking,
    warnings,
    requiresConfirmation,
    hasBlocking: blocking.length > 0,
    hasUnknownPrice: unknown.length > 0,
  };
}

export { SEVERITY };
