// E 模块 · 规则与版本（二）投票
//
// 规则：每名有资格成员一人一票；赞成门槛 floor(N/2)+1；
//       弃权不减少门槛、也不计入赞成；重复投票与资格名单外成员均被拒绝。
//
// 本文件为纯函数，投票状态由调用方（C 的存储）持有，E 只负责规则与结果判定。

const CHOICES = new Set(['approve', 'reject', 'abstain']);

/** 赞成门槛：floor(eligibleCount / 2) + 1。 */
export function thresholdOf(eligibleCount) {
  return Math.floor(eligibleCount / 2) + 1;
}

/** 创建一个投票回合：资格名单快照 + 门槛。 */
export function createVote(version, eligible) {
  const members = [...new Set(eligible)];
  return {
    version,
    eligible: members,
    votes: {}, // memberId -> "approve" | "reject" | "abstain"
    threshold: thresholdOf(members.length),
  };
}

/**
 * 投出一票（一人一票）。
 * @returns {{ ok: boolean, message?: string }}
 */
export function castVote(vote, memberId, choice) {
  if (!vote.eligible.includes(memberId)) {
    return { ok: false, message: '该成员不在本轮投票资格名单中。' };
  }
  if (!CHOICES.has(choice)) {
    return { ok: false, message: '无效的投票选择，仅支持 approve / reject / abstain。' };
  }
  if (Object.hasOwn(vote.votes, memberId)) {
    return { ok: false, message: '该成员本轮已投过票，不能重复投票。' };
  }
  vote.votes[memberId] = choice;
  return { ok: true };
}

/**
 * 计票：返回票数分布与当前状态。
 * passed  = 赞成达到门槛；
 * failed  = 即使剩余成员全部赞成也无法达标（可提前结束）；
 * open    = 仍在收集。
 */
export function tally(vote) {
  const choices = Object.values(vote.votes);
  const approve = choices.filter(choice => choice === 'approve').length;
  const reject = choices.filter(choice => choice === 'reject').length;
  const abstain = choices.filter(choice => choice === 'abstain').length;
  const remaining = vote.eligible.length - choices.length;

  let status = 'open';
  if (approve >= vote.threshold) status = 'passed';
  else if (approve + remaining < vote.threshold) status = 'failed';

  return {
    approve,
    reject,
    abstain,
    threshold: vote.threshold,
    eligible: vote.eligible.length,
    remaining,
    status,
  };
}
