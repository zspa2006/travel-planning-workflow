// E 模块 · 规则与版本（公开入口）
//
// 供 D（调度）调用校验、供 C（存储）调用版本与投票、供 B（执行工作台）读取结果。
// 只依赖纯函数，无第三方依赖、无 IO。

export * from './validate.mjs';
export * from './vote.mjs';
export * from './publish.mjs';

/**
 * 门控判定：把校验结果映射为下一步动作。
 * - block   ：存在硬约束冲突（阻塞级问题），不能发布，需先处理/返工。
 * - confirm ：无阻塞，但存在缺价等需人工确认口径的问题。
 * - publish ：校验通过，可进入投票与发布。
 */
export function decideGate(result) {
  if (result?.blocking?.length) {
    return { action: 'block', reason: '存在硬约束冲突，需先处理。', issues: result.blocking };
  }
  if (result?.requiresConfirmation?.length) {
    return {
      action: 'confirm',
      reason: '存在未确认报价，需人工确认口径。',
      issues: result.requiresConfirmation,
    };
  }
  return { action: 'publish', reason: '校验通过，可进入投票与发布。' };
}
