// D 模块 · 运行时任务图
//
// 9 个基础节点 + 两类动态节点（人工确认门控、定向返工支线）。
// 节点 = 一次智能体调用或一次程序检查；边 = 数据依赖。
// 动态扩展只增节点与依赖，从不删除已经发生的事实。

export const BASE_NODES = Object.freeze([
  node('parse_intent', '解析需求 · 归一化', {
    agent: 'parse_intent', deps: [], durationMs: 400, timeoutMs: 2000, maxAttempts: 2, stage: 'extracting',
  }),
  node('retrieve_candidates', '内容检索 · 候选与报价', {
    agent: 'retrieve_candidates', deps: ['parse_intent'], durationMs: 900, timeoutMs: 2000, maxAttempts: 3, stage: 'searching',
  }),
  node('coordinate_preferences', '偏好协调 · 约束与冲突', {
    agent: 'coordinate_preferences', deps: ['parse_intent'], durationMs: 700, timeoutMs: 2000, maxAttempts: 2, stage: 'searching',
  }),
  node('map_routes', '地图对接 · 路线与耗时', {
    agent: 'map_routes', deps: ['retrieve_candidates'], durationMs: 800, timeoutMs: 2000, maxAttempts: 2, stage: 'searching',
  }),
  node('plan_itinerary', '总控规划 · 分日行程', {
    agent: 'plan_itinerary', deps: ['map_routes', 'coordinate_preferences'], durationMs: 1200, timeoutMs: 3000, maxAttempts: 2, stage: 'planning',
  }),
  node('validate_plan', '程序校验 · 预算/时间/约束', {
    kind: 'program', id: 'validate_plan', deps: ['plan_itinerary'], durationMs: 120, timeoutMs: 500, maxAttempts: 1, stage: 'checking',
  }),
  node('propose_candidate', '生成候选版本', {
    kind: 'program', deps: ['validate_plan'], durationMs: 80, timeoutMs: 500, maxAttempts: 1, stage: 'saving',
  }),
  node('vote_gate', '成员多数表决', {
    kind: 'program', deps: ['propose_candidate'], durationMs: 200, timeoutMs: 5000, maxAttempts: 1, stage: 'saving',
  }),
  node('publish_version', '发布正式版本', {
    kind: 'program', deps: ['vote_gate'], durationMs: 80, timeoutMs: 500, maxAttempts: 1, stage: 'finished',
  }),
]);

function node(id, title, extra = {}) {
  return Object.freeze({
    id,
    title,
    kind: extra.kind ?? 'agent',
    agent: extra.agent ?? null,
    deps: Object.freeze([...(extra.deps ?? [])]),
    durationMs: extra.durationMs ?? 500,
    timeoutMs: extra.timeoutMs ?? 2000,
    maxAttempts: extra.maxAttempts ?? 2,
    critical: extra.critical ?? true,
    stage: extra.stage ?? 'planning',
    round: extra.round ?? 0,
    note: extra.note ?? '',
  });
}

/** 每次运行取一份可修改的节点定义副本。 */
export function baseNodes() {
  return BASE_NODES.map(spec => ({ ...spec, deps: [...spec.deps] }));
}

/** 人工确认门控：插在最近一次校验之后、生成候选之前。 */
export function humanGateNode(validateId, reason) {
  return node('confirm_unverified', '人工确认 · 未验证费用', {
    kind: 'gate', deps: [validateId], durationMs: 0, timeoutMs: 30000,
    maxAttempts: 1, stage: 'checking', note: reason,
  });
}

/** 定向返工支线：返工节点 → 重排规划 → 复检。 */
export function repairNodes(round, focus, validateId) {
  const agent = focus === 'time' ? 'map_routes' : 'retrieve_candidates';
  const repairTitle = focus === 'time' ? '地图对接 · 重算路线' : '内容检索 · 替代项';
  return [
    node(`repair_${focus}_r${round}`, `${repairTitle}（第 ${round} 轮）`, {
      agent, deps: [validateId], durationMs: 700, timeoutMs: 2000, maxAttempts: 2,
      stage: 'searching', round, note: `focus=${focus}`,
    }),
    node(`replan_r${round}`, `总控规划 · 返工重排（第 ${round} 轮）`, {
      agent: 'plan_itinerary',
      deps: [`repair_${focus}_r${round}`, 'map_routes', 'coordinate_preferences'],
      durationMs: 1200, timeoutMs: 3000, maxAttempts: 2, stage: 'planning', round,
    }),
    node(`validate_r${round}`, `程序校验 · 返工复检（第 ${round} 轮）`, {
      kind: 'program', deps: [`replan_r${round}`], durationMs: 120, timeoutMs: 500,
      maxAttempts: 1, stage: 'checking', round,
    }),
  ];
}
