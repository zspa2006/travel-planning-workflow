// D 模块 · F（智能体与地图）适配器
//
// 真实实现由 F 提供 AgentRequest/AgentResult。合并前用同结构的本地模拟，
// 保证 D 能独立跑通整条链；替换时只改本文件，runner 不动。

/** 各节点产出（结构对齐 F 的约定：ok / payload / error.retryable）。 */
export function createAgents({ faults = {} } = {}) {
  const fail = (nodeId, attempt) => {
    const plan = faults[nodeId];
    if (!plan) return null;
    const kind = plan[attempt];
    if (!kind) return null;
    if (kind === 'timeout') {
      return { ok: false, retryable: true, error: { kind: 'timeout', message: '工具在时限内未返回' } };
    }
    return { ok: false, retryable: true, error: { kind, message: '报价工具返回 503，本轮候选集不完整' } };
  };

  return {
    parse_intent({ context, attempt, nodeId }) {
      const fault = fail(nodeId, attempt);
      if (fault) return fault;
      return {
        ok: true,
        payload: {
          destination: context.destination,
          startDate: context.startDate,
          endDate: context.endDate,
          days: countDays(context.startDate, context.endDate),
          budgetFen: context.budgetFen,
          mustVisit: [...context.mustVisit],
          dietaryRestrictions: [...context.dietaryRestrictions],
          pace: context.pace,
          travelers: context.members.length,
        },
      };
    },

    retrieve_candidates({ context, attempt, nodeId }) {
      const fault = fail(nodeId, attempt);
      if (fault) return fault;
      return {
        ok: true,
        payload: {
          candidates: context.mustVisit.map((place, index) => ({
            id: `c${index + 1}`,
            place,
            source: 'demo-catalog',
            confidence: 'high',
          })),
          delta: { firstQuery: attempt === 1 },
        },
      };
    },

    coordinate_preferences({ context, attempt, nodeId }) {
      const fault = fail(nodeId, attempt);
      if (fault) return fault;
      return {
        ok: true,
        payload: {
          decisions: [{ rule: 'hard-constraints', items: context.mustVisit }],
          conflicts: [],
          pace: context.pace,
        },
      };
    },

    map_routes({ context, attempt, nodeId }) {
      const fault = fail(nodeId, attempt);
      if (fault) return fault;
      return {
        ok: true,
        payload: {
          routes: { 'R-01': '地铁 25 分钟', 'R-02': '步行 15 分钟' },
          unverified: [],
        },
      };
    },

    plan_itinerary({ context, variant, attempt, nodeId }) {
      const fault = fail(nodeId, attempt);
      if (fault) return fault;
      return { ok: true, payload: buildPlan(context, variant) };
    },
  };
}

function countDays(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

const PRESETS = {
  balanced: {
    label: '舒适版',
    expenses: [
      ['门票', '景点门票合计', 'personal', 138000],
      ['餐饮', '三餐合计（3 人）', 'shared', 216000],
      ['市内交通', '地铁与打车', 'personal', 62000],
      ['住宿', '一晚住宿', 'shared', 480000],
      ['城际交通', '往返高铁', 'personal', 228300],
    ],
  },
  economy: {
    label: '经济版',
    expenses: [
      ['门票', '景点门票合计', 'personal', 138000],
      ['餐饮', '三餐合计（3 人）', 'shared', 168000],
      ['市内交通', '地铁与公交', 'personal', 42000],
      ['住宿', '一晚住宿', 'shared', 360000],
      ['城际交通', '往返高铁二等座', 'personal', 213500],
    ],
  },
};

/**
 * 生成一份可校验的行程。
 * 结构对齐 docs/frontend-api.md 的 Plan：days[].activities[] + expenses[].totalFen（分）。
 */
export function buildPlan(context, variant = 'balanced') {
  const preset = PRESETS[variant] ?? PRESETS.balanced;
  const [firstPlace, secondPlace] = pickPlaces(context.mustVisit);
  const startDate = context.startDate;
  const secondDate = addDays(startDate, 1);

  const days = [
    {
      date: startDate,
      activities: [
        { start: '09:00', end: '11:00', place: firstPlace, transport: '地铁 25 分钟', kind: 'attraction', confidence: 'high', source: 'demo-catalog' },
        { start: '12:00', end: '13:00', place: '楼外楼', transport: '步行 10 分钟', kind: 'meal', contains: ['东坡肉', '西湖醋鱼'], confidence: 'high', source: 'demo-catalog' },
        { start: '14:00', end: '16:00', place: secondPlace, transport: '打车 20 分钟', kind: 'attraction', confidence: 'high', source: 'demo-catalog' },
      ],
    },
    {
      date: secondDate,
      activities: [
        { start: '09:00', end: '11:00', place: '龙井村', transport: '公交 30 分钟', kind: 'attraction', confidence: 'high', source: 'demo-catalog' },
        { start: '12:00', end: '13:00', place: '知味观', transport: '步行 8 分钟', kind: 'meal', contains: ['小笼包', '片儿川'], confidence: 'high', source: 'demo-catalog' },
        { start: '15:00', end: '16:30', place: '杭州站', transport: '地铁 20 分钟', kind: 'transit', confidence: 'high', source: 'demo-catalog' },
      ],
    },
  ];

  const expenses = preset.expenses.map(([category, label, scope, totalFen]) => ({
    category,
    label,
    scope,
    totalFen: context.degradedPrice && category === '住宿' ? null : totalFen,
  }));

  return {
    id: `draft-${variant}`,
    version: 0,
    status: 'draft',
    title: `${context.destination} ${days.length} 日 · ${preset.label}`,
    variant,
    days,
    expenses,
    totalFen: expenses.reduce((sum, item) => sum + (Number.isSafeInteger(item.totalFen) ? item.totalFen : 0), 0),
  };
}

function pickPlaces(mustVisit = []) {
  const places = mustVisit.length >= 2 ? mustVisit : [...mustVisit, '西湖', '灵隐寺'];
  return [places[0], places[1]];
}

function addDays(dateStr, offset) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
