// D 模块 · 执行事件日志
//
// 事件是运行过程的唯一事实来源：前端（B）按事件名渲染，断线用 cursor 补齐，
// 报告与审计只读这一份。seq 单调递增，不允许跳号。

export const EVENT_TYPES = Object.freeze(new Set([
  // 运行级
  'task.started', 'task.paused', 'task.resumed', 'task.cancel_requested', 'task.finished',
  'task.budget_exceeded',
  // 节点级
  'task.node_ready', 'task.node_started', 'task.node_succeeded', 'task.node_failed',
  'task.node_retrying', 'task.node_blocked', 'task.node_skipped', 'task.node_cancelled',
  'task.node_added',
  // 校验与返工
  'task.validation_completed', 'task.repair_planned', 'task.repair_blocked',
  // 人工门控
  'task.human_requested', 'task.human_resolved',
  // 候选与表决
  'task.candidate_proposed', 'task.vote_opened', 'task.vote_cast', 'task.vote_closed',
  // 发布
  'task.published', 'task.version_conflict',
]));

export class EventLog {
  constructor(taskId) {
    this.taskId = taskId;
    this.list = [];
    this.seq = 0;
    /** @type {Array<{cursor:number, handler:Function}>} */
    this.listeners = [];
  }

  /**
   * 追加一条事件。
   * 未登记的类型不打断运行，但降级为 warning 并打标记——前端不会静默丢弃。
   */
  emit(type, message, { level = 'info', nodeId = null, at = 0, data = {} } = {}) {
    this.seq += 1;
    let finalLevel = level;
    let payload = data;
    if (!EVENT_TYPES.has(type)) {
      finalLevel = 'warning';
      payload = { ...data, unknownEventType: true };
    }
    const record = {
      seq: this.seq,
      taskId: this.taskId,
      at,
      type,
      level: finalLevel,
      nodeId,
      message,
      data: payload,
    };
    this.list.push(record);
    for (const listener of this.listeners) {
      try {
        listener.handler(record);
      } catch {
        // 订阅端异常不得影响主流程
      }
    }
    return record;
  }

  /** 断线补齐：返回 cursor 之后的所有事件。 */
  since(cursor = 0) {
    if (!cursor) return [...this.list];
    return this.list.filter(event => event.seq > cursor);
  }

  all() {
    return [...this.list];
  }

  get cursor() {
    return this.seq;
  }

  subscribe(cursor, handler) {
    const entry = { cursor, handler };
    this.listeners.push(entry);
    return () => {
      const index = this.listeners.indexOf(entry);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  types() {
    return [...new Set(this.list.map(event => event.type))];
  }
}
