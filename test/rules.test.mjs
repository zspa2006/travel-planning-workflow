import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlan,
  knownTotalFen,
  decideGate,
  thresholdOf,
  createVote,
  castVote,
  tally,
  proposeCandidate,
  publishCandidate,
  resolveExpense,
} from '../rules/index.mjs';

// 复用 demo 中的苏州样例，便于与 A 的前端数据对齐。
const suzhouPlan = () => ({
  title: '苏州两日 · 古城漫游',
  days: [
    { date: '2026-12-05', activities: [
      { start: '09:30', end: '11:30', place: '拙政园', transport: '步行 15 分钟' },
      { start: '14:00', end: '16:00', place: '苏州博物馆', transport: '步行 5 分钟' },
    ] },
    { date: '2026-12-06', activities: [
      { start: '10:00', end: '12:00', place: '平江路', transport: '地铁＋步行 30 分钟' },
      { start: '15:00', end: '16:30', place: '苏州站返程', transport: '地铁 25 分钟' },
    ] },
  ],
  expenses: [
    { category: '门票', label: '拙政园门票', scope: 'personal', totalFen: 24000 },
    { category: '住宿', label: '一晚住宿', scope: 'shared', totalFen: null },
    { category: '市内交通', label: '市内交通预估', scope: 'personal', totalFen: 9000 },
  ],
});

// ------------------------------------------------------------------ 预算
test('超预算返回阻塞级 V-BUDGET，禁止发布', () => {
  const result = validatePlan(suzhouPlan(), { budgetFen: 20000 });
  assert.ok(result.issues.some(item => item.code === 'V-BUDGET' && item.severity === 'blocking'));
  assert.equal(decideGate(result).action, 'block');
});

test('预算内不产生 V-BUDGET', () => {
  const result = validatePlan(suzhouPlan(), { budgetFen: 100000 });
  assert.ok(!result.issues.some(item => item.code === 'V-BUDGET'));
});

// -------------------------------------------------- 未知报价不按 0 元处理
test('缺价费用不按 0 元计入已知合计，并标记待人工确认', () => {
  const result = validatePlan(suzhouPlan(), { budgetFen: 100000 });
  assert.equal(result.knownTotalFen, 24000 + 9000); // 24000 + 9000，null 不计入
  assert.equal(result.unknownCount, 1);
  const missing = result.issues.find(item => item.code === 'V-PRICE-MISSING');
  assert.equal(missing.requiresConfirmation, true);
  assert.equal(missing.severity, 'warning');
});

test('存在缺价时门控判定为 confirm（人工确认），而非直接发布', () => {
  const result = validatePlan(suzhouPlan(), { budgetFen: 100000 });
  assert.equal(decideGate(result).action, 'confirm');
});

test('无缺价、无阻塞时门控判定为 publish', () => {
  const plan = suzhouPlan();
  plan.expenses = plan.expenses.map(expense =>
    expense.totalFen === null ? { ...expense, totalFen: 48000 } : expense);
  const result = validatePlan(plan, { budgetFen: 100000 });
  assert.equal(decideGate(result).action, 'publish');
});

test('人工确认缺价后该费用计入已知合计', () => {
  const plan = suzhouPlan();
  const resolved = resolveExpense(plan, 1, { totalFen: 48000, confirmedBy: '小林' });
  assert.equal(resolved.expenses[1].totalFen, 48000);
  assert.equal(resolved.expenses[1].confirmedBy, '小林');
  assert.equal(knownTotalFen(resolved), 24000 + 48000 + 9000);
  assert.equal(validatePlan(resolved, { budgetFen: 100000 }).unknownCount, 0);
});

// ------------------------------------------------------------------ 时间
test('结束不晚于开始返回阻塞级 V-TIME', () => {
  const plan = { days: [{ activities: [{ start: '12:00', end: '11:00', place: 'A' }] }], expenses: [] };
  const result = validatePlan(plan);
  assert.ok(result.issues.some(item => item.code === 'V-TIME' && item.severity === 'blocking'));
});

test('同日相邻活动时间重叠返回 V-TIME-CONFLICT', () => {
  const plan = { days: [{ activities: [
    { start: '09:00', end: '12:00', place: 'A' },
    { start: '11:00', end: '13:00', place: 'B' },
  ] }], expenses: [] };
  const result = validatePlan(plan);
  assert.ok(result.issues.some(item => item.code === 'V-TIME-CONFLICT'));
});

// ------------------------------------------------------------------ 营业
test('超出营业时段返回阻塞级 V-HOURS', () => {
  const plan = { days: [{ activities: [{ start: '20:00', end: '22:00', place: '博物馆' }] }], expenses: [] };
  const result = validatePlan(plan, { evidence: { places: { 博物馆: { open: '09:00', close: '17:00' } } } });
  assert.ok(result.issues.some(item => item.code === 'V-HOURS' && item.severity === 'blocking'));
});

// ------------------------------------------------------------------ 必去
test('漏掉必去地点返回阻塞级 V-MUST-VISIT', () => {
  const plan = { days: [{ activities: [{ start: '09:00', end: '11:00', place: '拙政园' }] }], expenses: [] };
  const result = validatePlan(plan, { mustVisit: ['苏州博物馆'] });
  assert.ok(result.issues.some(item => item.code === 'V-MUST-VISIT' && item.severity === 'blocking'));
});

// ------------------------------------------------------------------ 饮食
test('菜品含禁忌食材返回阻塞级 V-DIET', () => {
  const plan = { days: [{ activities: [
    { start: '12:00', end: '13:00', place: '苏帮菜馆', contains: ['花生酱拌面', '清炒虾仁'] },
  ] }], expenses: [] };
  const result = validatePlan(plan, { dietaryRestrictions: ['花生'] });
  assert.ok(result.issues.some(item => item.code === 'V-DIET' && item.severity === 'blocking'));
});

// ------------------------------------------------------------ 数据可信度
test('低可信来源返回警告级 V-SOURCE', () => {
  const plan = { days: [{ activities: [
    { start: '09:00', end: '11:00', place: '拙政园', confidence: 'low', source: '口口相传' },
  ] }], expenses: [] };
  const result = validatePlan(plan);
  assert.ok(result.issues.some(item => item.code === 'V-SOURCE' && item.severity === 'warning'));
});

// ------------------------------------------------------------------ 投票
test('5 人门槛为 floor(5/2)+1 = 3', () => {
  assert.equal(thresholdOf(5), 3);
});

test('5 人中 3 人赞成即通过', () => {
  const vote = createVote(2, ['甲', '乙', '丙', '丁', '戊']);
  for (const member of ['甲', '乙', '丙']) castVote(vote, member, 'approve');
  assert.equal(tally(vote).status, 'passed');
});

test('5 人中仅 2 人赞成不通过', () => {
  const vote = createVote(2, ['甲', '乙', '丙', '丁', '戊']);
  for (const member of ['甲', '乙']) castVote(vote, member, 'approve');
  for (const member of ['丙', '丁', '戊']) castVote(vote, member, 'reject');
  assert.equal(tally(vote).status, 'failed');
});

test('一人一票：重复投票被拒绝', () => {
  const vote = createVote(2, ['甲', '乙', '丙', '丁', '戊']);
  assert.equal(castVote(vote, '甲', 'approve').ok, true);
  assert.equal(castVote(vote, '甲', 'approve').ok, false);
  assert.equal(tally(vote).approve, 1);
});

test('资格名单外成员投票被拒绝', () => {
  const vote = createVote(2, ['甲', '乙', '丙']);
  assert.equal(castVote(vote, '路人', 'approve').ok, false);
});

test('弃权不计赞成也不降低门槛', () => {
  const vote = createVote(2, ['甲', '乙', '丙', '丁', '戊']);
  for (const member of ['甲', '乙']) castVote(vote, member, 'abstain');
  const result = tally(vote);
  assert.equal(result.abstain, 2);
  assert.equal(result.approve, 0);
  assert.equal(result.threshold, 3); // 弃权不影响门槛
});

// ------------------------------------------------------------ 版本发布守卫
test('发布守卫：正式版本未变时发布成功，原正式版本归档', () => {
  const plans = [
    { id: 'v1', version: 1, status: 'official' },
    { id: 'v2', version: 2, status: 'candidate' },
  ];
  const result = publishCandidate(plans, 'v2', 1);
  assert.equal(result.ok, true);
  assert.equal(result.plans.find(plan => plan.id === 'v2').status, 'official');
  assert.equal(result.plans.find(plan => plan.id === 'v1').status, 'archived');
});

test('发布守卫：旧任务不能覆盖新正式版本', () => {
  const plans = [
    { id: 'v1', version: 1, status: 'archived' },
    { id: 'v2', version: 2, status: 'official' }, // 已被更新的正式版本
    { id: 'v3', version: 3, status: 'candidate' },
  ];
  const result = publishCandidate(plans, 'v3', 1); // 发起时还以为是 v1
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERSION_CONFLICT');
  assert.equal(result.currentOfficialVersion, 2);
});

test('proposeCandidate 生成自增版本号与候选状态', () => {
  const draft = { title: '苏州两日', days: [], expenses: [] };
  const candidate = proposeCandidate([{ id: 'v1', version: 1, status: 'official' }], draft);
  assert.equal(candidate.version, 2);
  assert.equal(candidate.status, 'candidate');
});
