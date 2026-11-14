// D 模块 · 对外入口
//
// C 的 POST /teams/{id}/tasks 处理函数只需要这几行：
//   const run = createTask({ input: snapshot, autoConfirm: false });
//   const taskId = run.taskId;
//   const done = run.start();          // 不 await，立刻返回 202
// 之后任务进度读 run.snapshot()，增量事件读 run.eventsSince(cursor)。

export { Orchestrator, Orchestrator as createTask } from './runner.mjs';
export { toTaskDetail, availableActions } from './task-view.mjs';
export { EventLog, EVENT_TYPES } from './events.mjs';
export { NODE_STATUS, RUN_STATUS, TERMINAL_RUN, InvalidTransition } from './states.mjs';
export { baseNodes } from './graph.mjs';
export * as guards from './guards.mjs';
export { validatePlan, decideGate, createVote, castVote, tally, usingUpstreamRules } from './adapters/rules.mjs';
