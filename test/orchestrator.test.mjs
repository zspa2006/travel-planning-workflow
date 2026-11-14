import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Orchestrator, toTaskDetail } from '../orchestrator/index.mjs';
import { EVENT_TYPES } from '../orchestrator/events.mjs';
import { decideRepair, retryDelayMs, versionConflict } from '../orchestrator/guards.mjs';
import { assertNodeTransition, NODE_STATUS, InvalidTransition } from '../orchestrator/states.mjs';

const fixture = JSON.parse(readFileSync(new URL('../orchestrator/fixtures/hangzhou.json', import.meta.url), 'utf8'));
const VOTE_PLAN = { m1: 'approve', m2: 'approve', m3: 'approve' };

function makeRun({ input = fixture, ...rest } = {}) {
  return new Orchestrator({ input, autoConfirm: true, autoVote: true, votePlan: VOTE_PLAN, ...rest });
}

function budget(fen) {
  return JSON.parse(JSON.stringify({ ...fixture, common_conditions: {
    ...fixture.common_conditions,
    current_version: { ...fixture.common_conditions.current_version, budget_fen: fen },
  } }));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

// ---------------------------------------------------------------- 1. 完整闭环
test('一次运行从 accepted 走到 published，产出正式版本 v2', async () => {
  const run = makeRun();
  const snap = await run.start();

  assert.equal(snap.status, 'published');
  assert.equal(snap.nodes.length, 9, '9 个基础节点全部入图');
  assert.equal(snap.result.version, 2);
  assert.equal(snap.result.repairRounds, 0);
  assert.equal(snap.progress.stage, 'finished');
  assert.ok(snap.events.some(event => event.type === 'task.published'));
  assert.ok(snap.nodes.every(node => node.status !== 'running'));
});

// ---------------------------------------------------------------- 2. 并行
test('内容检索与偏好协调并行，时间区间重叠', async () => {
  const run = makeRun();
  const snap = await run.start();
  const retrieve = snap.nodes.find(node => node.id === 'retrieve_candidates');
  const preferences = snap.nodes.find(node => node.id === 'coordinate_preferences');

  assert.ok(retrieve.endedAt > retrieve.startedAt);
  const overlapStart = Math.max(retrieve.startedAt, preferences.startedAt);
  const overlapEnd = Math.min(retrieve.endedAt, preferences.endedAt);
  assert.ok(overlapStart < overlapEnd, '两节点必须并行执行');
  assert.equal(snap.counters.parallelLimit, 3);
});

// ---------------------------------------------------------------- 3. 定向返工
test('预算超支触发 1 轮定向返工后通过', async () => {
  const run = makeRun({ input: budget(1060000) });
  const snap = await run.start();

  assert.equal(snap.status, 'published');
  assert.equal(snap.result.repairRounds, 1);
  assert.ok(snap.nodes.some(node => node.id === 'repair_budget_r1' && node.status === 'succeeded'));
  const planned = snap.events.find(event => event.type === 'task.repair_planned');
  assert.equal(planned.data.focus, 'budget');
  assert.equal(planned.data.round, 1);
});

// ---------------------------------------------------------------- 4. 不收敛
test('同一组阻塞码连续两轮时立即停止，不再空转', async () => {
  const run = makeRun({ input: budget(800000) });
  const snap = await run.start();

  assert.equal(snap.status, 'blocked');
  assert.equal(snap.result.repairRounds, 1, '只做了 1 轮就判定不收敛');
  assert.match(snap.result.message, /连续两轮/);
  assert.ok(!snap.events.some(event => event.type === 'task.published'));
  assert.ok(!snap.events.some(event => event.type === 'task.vote_opened'));
});

// ---------------------------------------------------------------- 5. 超时
test('节点超时按可重试失败处理，且受 maxAttempts 封顶', async () => {
  const run = makeRun({ latencyOverrides: { plan_itinerary: 99999 } });
  const snap = await run.start();
  const plan = snap.nodes.find(node => node.id === 'plan_itinerary');

  assert.equal(snap.status, 'failed');
  assert.equal(plan.attempts.length, 2, '重试次数必须封顶');
  assert.equal(plan.error.kind, 'timeout');
  assert.equal(snap.events.filter(event => event.type === 'task.finished').length, 1);
});

// ---------------------------------------------------------------- 6. 取消
test('取消后不残留 running 节点，也不发布', async () => {
  const run = makeRun();
  const done = run.start();
  run.cancel('测试取消');
  const snap = await done;

  assert.equal(snap.status, 'cancelled');
  assert.ok(!snap.nodes.some(node => ['running', 'ready'].includes(node.status)));
  assert.ok(!snap.events.some(event => event.type === 'task.published'));
  assert.equal(snap.events.filter(event => event.type === 'task.cancel_requested').length, 1);
});

test('重复取消是幂等的', () => {
  const run = makeRun();
  run.cancel('第一次');
  run.cancel('第二次');
  const snapshot = run.snapshot();
  assert.equal(snapshot.events.filter(event => event.type === 'task.cancel_requested').length, 1);
});

// ---------------------------------------------------------------- 7. 人工门控
test('未验证费用触发人工门控，确认后继续发布', async () => {
  const input = { ...JSON.parse(JSON.stringify(fixture)), degradedPrice: true };
  const run = new Orchestrator({ input, autoConfirm: false, autoVote: true, votePlan: VOTE_PLAN });
  const done = run.start();

  await waitFor(() => run.gate && run.gate.state === 'open');
  assert.equal(run.gate.options[0].id, 'accept');
  const resolved = run.resolveGate('accept', '按估算区间处理');
  assert.equal(resolved.ok, true);
  assert.equal(run.resolveGate('accept').ok, false, '重复确认必须被拒绝');

  const snap = await done;
  assert.equal(snap.status, 'published');
  assert.ok(snap.events.some(event => event.type === 'task.human_requested'));
  assert.ok(snap.events.some(event => event.type === 'task.human_resolved'));
});

// ---------------------------------------------------------------- 8. 事件契约
test('事件序号连续且全部登记在白名单内', async () => {
  const run = makeRun({ input: budget(1060000) });
  const snap = await run.start();

  let expected = 0;
  for (const event of snap.events) {
    expected += 1;
    assert.equal(event.seq, expected, '事件 seq 必须连续');
    assert.ok(EVENT_TYPES.has(event.type), `未登记的事件类型：${event.type}`);
  }
  assert.equal(snap.cursor, snap.events.length);
  assert.equal(run.eventsSince(snap.cursor).length, 0);
  assert.ok(run.eventsSince(0).length === snap.events.length);
});

// ---------------------------------------------------------------- 9. 守卫单元
test('返工决策：同码收敛、未知问题码不瞎猜', () => {
  assert.equal(decideRepair({ codes: [], round: 0 }).kind, 'stop');
  assert.equal(decideRepair({ codes: ['V-BUDGET'], round: 0 }).focus, 'budget');
  assert.equal(decideRepair({ codes: ['V-TIME-CONFLICT'], round: 0 }).focus, 'time');
  assert.equal(decideRepair({ codes: ['V-BUDGET'], round: 1, previousCodes: ['V-BUDGET'] }).kind, 'block');
  assert.equal(decideRepair({ codes: ['V-MUST-VISIT'], round: 0 }).kind, 'block');
  const unknown = decideRepair({ codes: ['V-NEW-CODE'], round: 0 });
  assert.equal(unknown.kind, 'block');
  assert.match(unknown.reason, /不认识/);
});

test('退避递增且有上限，版本守卫能识别冲突', () => {
  assert.equal(retryDelayMs(1), 140);
  assert.equal(retryDelayMs(2), 280);
  assert.equal(retryDelayMs(9), 600);
  assert.equal(versionConflict(1, 1), null);
  assert.match(versionConflict(3, 1), /v3/);
  assert.throws(() => assertNodeTransition(NODE_STATUS.SUCCEEDED, NODE_STATUS.RUNNING), InvalidTransition);
});

// ---------------------------------------------------------------- 10. 对外视图
test('toTaskDetail 输出蛇形命名并补齐 TaskDetail 必填字段', async () => {
  const run = makeRun({ input: budget(1060000) });
  const snap = await run.start();
  const detail = toTaskDetail(snap, { context: { team_id: 'team-sz-01' } });

  const required = ['id', 'execution_state', 'request_snapshot_id', 'result_snapshot_id', 'basis_token',
    'progress', 'attempt_count', 'attempt_limit', 'retry_allowed', 'next_retry_at',
    'available_actions', 'created_at', 'finished_at', 'nodes', 'edges'];
  for (const key of required) {
    assert.ok(Object.hasOwn(detail, key), `缺少必填字段 ${key}`);
  }

  assert.equal(detail.execution_state, 'published');
  assert.equal(detail.progress.stage, 'finished');
  assert.equal(detail.progress.total_units, 12, '9 基础节点 + 3 个返工节点');
  assert.ok(detail.progress.completed_units >= 9);
  assert.equal(detail.nodes[0].id, 'parse_intent');
  assert.ok(Object.hasOwn(detail.nodes[0], 'started_at'), '节点时间必须是蛇形');
  assert.ok(Object.hasOwn(detail.attempts[0], 'attempt_number'), '重试记录必须是蛇形');
  assert.equal(detail.result_application, 'applied');
  assert.notEqual(detail.finished_at, null);
  assert.deepEqual(detail.available_actions, [], '终态不再提供动作');
});

test('失败任务给出 retry 动作，事件类型共 26 种', async () => {
  const run = makeRun({ latencyOverrides: { plan_itinerary: 99999 } });
  const snap = await run.start();
  const detail = toTaskDetail(snap);

  assert.equal(detail.retry_allowed, true);
  assert.deepEqual(detail.available_actions.map(action => action.id), ['retry']);
  assert.equal(EVENT_TYPES.size, 26);
});
