// D 模块 · 对外视图映射
//
// 内部结构用驼峰（便于 JS 读写），对外按 C 的 openapi.json 输出蛇形命名，
// 补齐 TaskDetail 的必填字段。她的路由直接 return toTaskDetail(run.snapshot()) 即可。

const TERMINAL = new Set(['published', 'blocked', 'failed', 'cancelled', 'superseded']);

const ACTION_LABELS = {
  pause: '暂停',
  resume: '继续',
  cancel: '取消',
  gate: '处理人工确认',
  vote: '投票',
  retry: '重试',
};

/** 当前状态下允许的动作（对齐 TaskDetail.available_actions）。 */
export function availableActions(snapshot) {
  const actions = [];
  const push = id => actions.push({ id, label: ACTION_LABELS[id] });
  switch (snapshot.status) {
    case 'running':
      push('pause');
      push('cancel');
      break;
    case 'paused':
      push('resume');
      push('cancel');
      break;
    case 'awaiting_human':
      push('gate');
      push('cancel');
      break;
    case 'awaiting_vote':
      push('vote');
      push('cancel');
      break;
    case 'failed':
      push('retry');
      break;
    default:
      break;
  }
  return actions;
}

function attemptView(node, attempt) {
  return {
    id: `${node.id}#${attempt.attempt}`,
    attempt_number: attempt.attempt,
    state: attempt.state,
    started_at: attempt.startedAt ?? null,
    finished_at: attempt.endedAt ?? null,
    failure: attempt.error ?? null,
  };
}

/**
 * 把内部快照映射成 C 的 TaskDetail（蛇形命名 + 必填字段齐全）。
 * @param {object} snapshot run.snapshot() 的返回值
 * @param {{context?: object, request?: object, requestedBy?: object}} [extra]
 */
export function toTaskDetail(snapshot, { context = null, request = null, requestedBy = null } = {}) {
  const nodes = snapshot.nodes.map(node => ({
    id: node.id,
    title: node.title,
    kind: node.kind,
    status: node.status,
    deps: [...node.deps],
    round: node.round ?? 0,
    max_attempts: node.maxAttempts ?? 1,
    timeout_ms: node.timeoutMs ?? 0,
    attempts: (node.attempts ?? []).map(attempt => attemptView(node, attempt)),
    started_at: node.startedAt ?? null,
    ended_at: node.endedAt ?? null,
    error: node.error ?? null,
  }));

  const attempts = nodes.flatMap(node => node.attempts);
  const attemptLimit = nodes.reduce((max, node) => Math.max(max, node.max_attempts), 1);
  const settled = TERMINAL.has(snapshot.status);

  return {
    context: context ?? { team_id: snapshot.teamId ?? null },
    id: snapshot.taskId,
    revision: snapshot.cursor ?? 0,
    requested_by: requestedBy,
    request,
    execution_state: snapshot.status,
    result_application: snapshot.status === 'published' ? 'applied'
      : (snapshot.status === 'cancelled' ? 'discarded' : 'not_applied'),
    request_snapshot_id: snapshot.requestSnapshotId,
    result_snapshot_id: snapshot.status === 'published' ? `result-${snapshot.taskId}` : null,
    basis_token: snapshot.basisToken,
    progress: {
      stage: snapshot.progress.stage,
      message: snapshot.progress.message,
      completed_units: snapshot.progress.completedUnits,
      total_units: snapshot.progress.totalUnits,
    },
    attempt_count: attempts.length,
    attempt_limit: attemptLimit,
    next_retry_at: null,
    retry_allowed: snapshot.status === 'failed',
    attempts,
    nodes,
    edges: snapshot.edges,
    gate: snapshot.gate ?? null,
    vote: snapshot.vote ?? null,
    counters: snapshot.counters,
    result: snapshot.result,
    created_at: snapshot.createdAt ?? null,
    finished_at: settled ? (snapshot.finishedAtIso ?? null) : null,
    available_actions: availableActions(snapshot),
    event_cursor: snapshot.cursor ?? 0,
  };
}
