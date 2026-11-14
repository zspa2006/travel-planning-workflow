// D 模块 · 运行状态机
//
// 设计：状态只允许按白名单迁移，非法迁移直接抛 InvalidTransition，
// 避免"某个分支忘了改状态"导致界面显示与真实进度不一致。

export const RUN_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  AWAITING_HUMAN: 'awaiting_human',
  AWAITING_VOTE: 'awaiting_vote',
  PUBLISHED: 'published',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SUPERSEDED: 'superseded',
});

export const TERMINAL_RUN = new Set([
  RUN_STATUS.PUBLISHED,
  RUN_STATUS.BLOCKED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
  RUN_STATUS.SUPERSEDED,
]);

export const NODE_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
});

export const NODE_TERMINAL = new Set([
  NODE_STATUS.SUCCEEDED,
  NODE_STATUS.FAILED,
  NODE_STATUS.BLOCKED,
  NODE_STATUS.SKIPPED,
  NODE_STATUS.CANCELLED,
]);

export const RUN_TRANSITIONS = Object.freeze({
  pending: new Set(['running', 'cancelled']),
  running: new Set(['paused', 'awaiting_human', 'awaiting_vote', 'published', 'blocked', 'failed', 'cancelled', 'superseded']),
  paused: new Set(['running', 'cancelled', 'failed']),
  awaiting_human: new Set(['running', 'blocked', 'failed', 'cancelled']),
  awaiting_vote: new Set(['published', 'blocked', 'failed', 'cancelled', 'superseded']),
  published: new Set(),
  blocked: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  superseded: new Set(),
});

export const NODE_TRANSITIONS = Object.freeze({
  pending: new Set(['ready', 'skipped', 'cancelled']),
  ready: new Set(['running', 'skipped', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'blocked', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(['pending']), // 重试：失败后回到 pending 再就绪
  blocked: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
});

export class InvalidTransition extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidTransition';
  }
}

export function assertRunTransition(from, to) {
  const allowed = RUN_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new InvalidTransition(`运行状态非法迁移：${from} -> ${to}`);
  }
}

export function assertNodeTransition(from, to) {
  const allowed = NODE_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new InvalidTransition(`节点状态非法迁移：${from} -> ${to}`);
  }
}
