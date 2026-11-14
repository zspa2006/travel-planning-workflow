// D 模块 · 守卫与策略（纯函数，不依赖 IO）
//
// 校验规则与表决结算归 E；这里只放 D 自己的东西：
// 重试退避、运行级资源上限、问题码到返工分支的映射、版本基线比对。

/** 指数退避：140ms 起，600ms 封顶。 */
export function retryDelayMs(attempt, { base = 140, max = 600 } = {}) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

/** 运行级资源上限。任一触发即停止调度并保留已完成产物。 */
export class BudgetGuard {
  constructor({ maxSteps = 40, maxCostFen = 200000, maxWallMs = 90000 } = {}) {
    this.maxSteps = maxSteps;
    this.maxCostFen = maxCostFen;
    this.maxWallMs = maxWallMs;
  }

  exceeded({ steps = 0, costFen = 0, wallMs = 0 } = {}) {
    if (steps > this.maxSteps) return `节点步数 ${steps} 超过上限 ${this.maxSteps}`;
    if (costFen > this.maxCostFen) return `调用成本 ${costFen} 分超过上限 ${this.maxCostFen} 分`;
    if (wallMs > this.maxWallMs) return `运行时长 ${wallMs}ms 超过上限 ${this.maxWallMs}ms`;
    return null;
  }
}

/**
 * 问题码 → 返工分支。
 * 未登记的码必须落到 null：宁可停下来问人，也不要猜成某类返工。
 */
export const CODE_FOCUS = Object.freeze({
  'V-BUDGET': 'budget',
  'V-TIME': 'time',
  'V-TIME-CONFLICT': 'time',
  'V-HOURS': 'time',
  'V-DIET': 'diet',
  'V-MUST-VISIT': 'must',
  'V-PRICE-MISSING': 'confirm',
  'V-SOURCE': null,
});

const FOCUS_PRIORITY = ['budget', 'time', 'diet'];

export function focusForCodes(codes = []) {
  const focuses = new Set(codes.map(code => CODE_FOCUS[code] ?? undefined));
  if (focuses.has(undefined)) return null; // 出现未登记的问题码
  for (const focus of FOCUS_PRIORITY) {
    if (focuses.has(focus)) return focus;
  }
  return null;
}

/**
 * 返工决策。
 * @param {object} input
 * @param {string[]} input.codes 本轮阻塞级问题码
 * @param {number} input.round 已完成返工轮次
 * @param {string[]} [input.previousCodes] 上一轮阻塞码，用于同码收敛判定
 * @param {number} [input.maxRounds]
 * @returns {{kind:'stop'|'repair'|'block', focus?:string|null, reason:string, codes:string[]}}
 */
export function decideRepair({ codes = [], round = 0, previousCodes = [], maxRounds = 2 } = {}) {
  const unique = [...new Set(codes)];
  if (unique.length === 0) {
    return { kind: 'stop', focus: null, reason: '无阻塞问题', codes: [] };
  }
  if (unique.includes('V-MUST-VISIT')) {
    return { kind: 'block', focus: 'must', reason: '必去清单与预算/时间冲突，需成员调整条件', codes: unique };
  }
  if (previousCodes.length > 0 && sameSet(previousCodes, unique)) {
    return { kind: 'block', focus: null, reason: '同一组阻塞问题连续两轮未改善，转人工取舍', codes: unique };
  }
  if (round >= maxRounds) {
    return { kind: 'block', focus: null, reason: `已完成 ${round} 轮返工仍不收敛`, codes: unique };
  }
  const focus = focusForCodes(unique);
  if (!focus) {
    return { kind: 'block', focus: null, reason: `编排器不认识的问题码：${unique.join(', ')}`, codes: unique };
  }
  return { kind: 'repair', focus, reason: `检测到 ${unique.join(', ')}，定向返工`, codes: unique };
}

function sameSet(a, b) {
  if (a.length !== b.length) {
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size !== setB.size) return false;
    for (const item of setA) if (!setB.has(item)) return false;
    return true;
  }
  return a.every((item, index) => item === b[index]) || sameUnordered(a, b);
}

function sameUnordered(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) if (!setB.has(item)) return false;
  return true;
}

/** 发布前版本守卫：当前正式版本必须仍等于任务发起时记录的基线。 */
export function versionConflict(currentOfficialVersion, baseVersion) {
  if (currentOfficialVersion === baseVersion) return null;
  return `正式版本已从 v${baseVersion ?? '无'} 变更为 v${currentOfficialVersion ?? '无'}，`
    + '本次发布被拒绝（旧任务不能覆盖新正式版本）';
}

/** 并发上限内还能再开几个节点。 */
export function slotsLeft(runningCount, maxParallel) {
  return Math.max(0, maxParallel - runningCount);
}
