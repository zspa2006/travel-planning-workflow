// D 模块 · 编排器（调度循环）
//
// 单写者：所有状态迁移都发生在这一条循环里，调用方只发起动作、读快照。
// 有界：节点重试、返工轮次、步数、成本、时长都有上限。
// 可观察：每个动作先写事件再更新状态，事件是唯一事实来源。

import { EventLog } from './events.mjs';
import { baseNodes, humanGateNode, repairNodes } from './graph.mjs';
import { BudgetGuard, decideRepair, retryDelayMs, versionConflict } from './guards.mjs';
import { NODE_STATUS, RUN_STATUS, TERMINAL_RUN, assertNodeTransition } from './states.mjs';
import { createAgents } from './adapters/agents.mjs';
import * as rules from './adapters/rules.mjs';

const COST_PER_NODE_FEN = 2000;

export class Orchestrator {
  /**
   * @param {object} options
   * @param {object} options.input 房间输入快照（C 的 input-snapshot 子集）
   * @param {string} [options.taskId]
   * @param {number} [options.maxParallel]
   * @param {boolean} [options.autoConfirm] 门控自动确认（测试/演示用）
   * @param {boolean} [options.autoVote] 表决自动投票（测试/演示用）
   * @param {object} [options.votePlan] memberId -> approve|reject|abstain
   * @param {object} [options.faults] nodeId -> {attempt: kind}
   * @param {object} [options.latencyOverrides] nodeId -> ms（用于超时用例）
   * @param {object} [options.guard] BudgetGuard 参数
   */
  constructor({
    input,
    taskId = `task-${Math.random().toString(16).slice(2, 10)}`,
    maxParallel = 3,
    autoConfirm = false,
    autoVote = false,
    votePlan = {},
    faults = {},
    latencyOverrides = {},
    guard = {},
  } = {}) {
    if (!input) throw new Error('缺少房间输入快照（input）');
    this.taskId = taskId;
    this.input = input;
    this.context = toContext(input);
    this.maxParallel = maxParallel;
    this.autoConfirm = autoConfirm;
    this.autoVote = autoVote;
    this.votePlan = votePlan;
    this.latencyOverrides = latencyOverrides;

    this.agents = createAgents({ faults });
    this.log = new EventLog(taskId);
    this.guard = new BudgetGuard(guard);

    this.nodes = new Map();
    for (const spec of baseNodes()) this.nodes.set(spec.id, newNode(spec));

    this.status = RUN_STATUS.PENDING;
    this.sim = 0;
    this.createdAt = new Date().toISOString();
    this.steps = 0;
    this.costFen = 0;
    this.repairRounds = 0;
    this.lastCodes = [];
    this.peakParallel = 0;
    this.startedAtWall = null;
    this.finishedAt = null;
    this.result = null;

    this.artifacts = {};
    // C 的存储里已有正式版本时，运行从这份基线开始（版本守卫要靠它比对）
    const baseVersion = input.officialVersion ?? 1;
    this.plans = Number.isSafeInteger(baseVersion) && baseVersion > 0
      ? [{
        id: `v${baseVersion}`,
        version: baseVersion,
        status: 'official',
        title: '现行正式方案',
        days: [],
        expenses: [],
      }]
      : [];
    this.candidate = null;
    this.vote = null;
    this.gate = null;
    this.humanNotes = [];
    this.cancelReason = null;
    this.paused = false;
    this.cancelled = false;
    this.halted = false;

    this.requestSnapshotId = input.snapshot_id ?? `snap-${taskId}`;
    this.basisToken = input.basis_token ?? `basis-${input.officialVersion ?? 1}`;
    this.baseOfficialVersion = input.officialVersion ?? 1;

    this.#readyWaiters = [];
    this.#gateWaiter = null;
    this.#voteWaiter = null;
    this.#started = false;
  }

  #readyWaiters;
  #gateWaiter;
  #voteWaiter;
  #started;

  // ------------------------------------------------------------ 对外动作
  /** 启动执行，直到终态才 resolve（门控/表决人工模式会一直等）。 */
  async start() {
    if (this.#started) throw new Error('同一实例只能启动一次');
    this.#started = true;
    this.startedAtWall = Date.now();
    this.#setRun(RUN_STATUS.RUNNING);
    this.#emit('task.started', `开始执行：${this.context.destination}`, {
      data: {
        taskId: this.taskId,
        snapshotId: this.requestSnapshotId,
        basisToken: this.basisToken,
        budgetFen: this.context.budgetFen,
        parallelLimit: this.maxParallel,
      },
    });

    try {
      await this.#loop();
    } catch (error) {
      this.#finish(RUN_STATUS.FAILED, `编排器异常：${error.message}`, { reasonCode: 'orchestrator_error' });
    }
    return this.snapshot();
  }

  pause() {
    if (this.status !== RUN_STATUS.RUNNING) return { ok: false, message: '当前状态不可暂停' };
    this.paused = true;
    this.#setRun(RUN_STATUS.PAUSED);
    this.#emit('task.paused', '已暂停：不再启动新节点');
    return { ok: true };
  }

  resume() {
    if (this.status !== RUN_STATUS.PAUSED) return { ok: false, message: '当前状态不可继续' };
    this.paused = false;
    this.#setRun(RUN_STATUS.RUNNING);
    this.#emit('task.resumed', '继续调度');
    return { ok: true };
  }

  /** 取消幂等：重复调用不再产生第二条取消事件。 */
  cancel(reason = '用户取消') {
    if (TERMINAL_RUN.has(this.status) || this.cancelled) return { ok: true, alreadyCancelled: true };
    this.cancelReason = reason;
    this.cancelled = true;
    this.#emit('task.cancel_requested', reason, { level: 'warning' });
    this.#releaseWaiters();
    return { ok: true };
  }

  /** 人工门控决议。 */
  resolveGate(choice = 'accept', note = '') {
    if (!this.gate || this.gate.state !== 'open') return { ok: false, message: '当前没有待确认的门控' };
    this.gate.state = 'resolved';
    this.gate.decision = choice;
    this.humanNotes.push({ choice, note, at: this.sim });
    const waiter = this.#gateWaiter;
    this.#gateWaiter = null;
    if (waiter) waiter(choice);
    return { ok: true, choice };
  }

  /** 本人投票或改票；已投过返回 ok=false。 */
  castVote(memberId, choice) {
    if (!this.vote || this.vote.status !== 'open') return { ok: false, message: '当前没有开放的表决' };
    const result = rules.castVote(this.vote, memberId, choice);
    if (!result.ok) return result;
    this.#emit('task.vote_cast', `${memberId} 投出 ${label(choice)}`, {
      nodeId: 'vote_gate',
      data: { memberId, choice, approve: countVotes(this.vote).approve, threshold: this.vote.threshold },
    });
    const counts = countVotes(this.vote);
    if (counts.status !== 'open' && this.#voteWaiter) {
      const waiter = this.#voteWaiter;
      this.#voteWaiter = null;
      waiter();
    }
    return { ok: true };
  }

  /** 任务级重试：只对已失败的任务有效。 */
  retryTask() {
    if (this.status !== RUN_STATUS.FAILED) return { ok: false, message: '只有失败的任务可以重试' };
    return { ok: false, message: '本实现按节点级重试；任务级重试请重新发起 POST /tasks' };
  }

  // ------------------------------------------------------------ 读取
  snapshot() {
    const nodes = [...this.nodes.values()].map(runtime => ({
      id: runtime.spec.id,
      title: runtime.spec.title,
      kind: runtime.spec.kind,
      status: runtime.status,
      deps: [...runtime.spec.deps],
      round: runtime.spec.round,
      maxAttempts: runtime.spec.maxAttempts,
      timeoutMs: runtime.spec.timeoutMs,
      attempts: runtime.attempts.map(attempt => ({ ...attempt })),
      startedAt: runtime.startedAt,
      endedAt: runtime.endedAt,
      error: runtime.error,
    }));
    const counts = this.#counts();
    return {
      taskId: this.taskId,
      teamId: this.input.team_id ?? null,
      createdAt: this.createdAt,
      finishedAtIso: this.finishedAtIso ?? null,
      status: this.status,
      progress: {
        stage: this.#stage(),
        message: this.result?.message ?? '',
        completedUnits: counts.succeeded,
        totalUnits: nodes.length,
      },
      nodes,
      edges: nodes.flatMap(node => node.deps.map(dep => [dep, node.id])),
      events: this.log.all(),
      cursor: this.log.cursor,
      counters: {
        steps: this.steps,
        repairRounds: this.repairRounds,
        peakParallel: this.peakParallel,
        parallelLimit: this.maxParallel,
        costFen: this.costFen,
        elapsedMs: this.sim,
      },
      candidate: this.candidate ? { ...this.candidate, plan: undefined } : null,
      vote: this.vote ? { ...this.vote, votes: { ...this.vote.votes } } : null,
      gate: this.gate,
      humanNotes: [...this.humanNotes],
      requestSnapshotId: this.requestSnapshotId,
      basisToken: this.basisToken,
      baseOfficialVersion: this.baseOfficialVersion,
      result: this.result,
    };
  }

  /** 断线补齐：B 用 cursor 拉增量。 */
  eventsSince(cursor = 0) {
    return this.log.since(cursor);
  }

  // ------------------------------------------------------------ 主循环
  async #loop() {
    for (;;) {
      if (TERMINAL_RUN.has(this.status)) break;

      if (this.cancelled) {
        this.#markRemainingCancelled();
        this.#finish(RUN_STATUS.CANCELLED, `已取消：${this.cancelReason}`, {
          reasonCode: 'cancelled',
          keptOfficialVersion: this.baseOfficialVersion,
        });
        break;
      }

      if (this.paused) {
        await sleep(2);
        continue;
      }

      const exceeded = this.guard.exceeded({
        steps: this.steps,
        costFen: this.costFen,
        wallMs: Date.now() - this.startedAtWall,
      });
      if (exceeded) {
        this.#emit('task.budget_exceeded', exceeded, { level: 'error' });
        this.#finish(RUN_STATUS.FAILED, `资源上限触发：${exceeded}`, { reasonCode: 'budget_exceeded' });
        break;
      }

      const batch = this.#takeReadyBatch();
      if (batch.length === 0) {
        if (this.#advanceToNextRetry()) continue;
        if (this.#blockUnrunnable()) continue;
        if (this.#allTerminal()) {
          this.#finish(RUN_STATUS.FAILED, '任务图执行完毕但没有产出正式版本', {
            reasonCode: 'no_publish',
          });
          break;
        }
        await sleep(2);
        continue;
      }
      await this.#runBatch(batch);
    }
  }

  #takeReadyBatch() {
    const ready = [];
    for (const runtime of this.nodes.values()) {
      if (ready.length >= this.maxParallel) break;
      if (runtime.status !== NODE_STATUS.PENDING) continue;
      if ((runtime.retryAt ?? 0) > this.sim) continue;
      if (!this.#depsOk(runtime)) continue;
      ready.push(runtime);
    }
    // 先就绪再开始：pending -> ready -> running，两段迁移都能被契约测试看见
    for (const runtime of ready) {
      assertNodeTransition(runtime.status, NODE_STATUS.READY);
      runtime.status = NODE_STATUS.READY;
      this.#emit('task.node_ready', `${runtime.spec.title} 就绪`, {
        nodeId: runtime.spec.id,
        data: { deps: [...runtime.spec.deps], stage: runtime.spec.stage },
      });
    }
    for (const runtime of ready) {
      const attempt = runtime.attempts.length + 1;
      assertNodeTransition(runtime.status, NODE_STATUS.RUNNING);
      runtime.status = NODE_STATUS.RUNNING;
      runtime.startedAt = this.sim;
      runtime.attempts.push({ attempt, state: 'running', startedAt: this.sim, endedAt: null, error: null });
      this.steps += 1;
      this.costFen += COST_PER_NODE_FEN;
      const running = [...this.nodes.values()].filter(item => item.status === NODE_STATUS.RUNNING).length;
      this.peakParallel = Math.max(this.peakParallel, running);
      this.#emit('task.node_started', `${runtime.spec.title} 开始（第 ${attempt} 次）`, {
        nodeId: runtime.spec.id,
        data: { attempt, timeoutMs: runtime.spec.timeoutMs, maxAttempts: runtime.spec.maxAttempts },
      });
    }
    return ready;
  }

  async #runBatch(batch) {
    const startSim = this.sim;
    const outcomes = await Promise.all(batch.map(runtime => this.#exec(runtime)));
    const maxDuration = outcomes.reduce((max, item) => Math.max(max, item.durationMs), 0);
    this.sim = startSim + maxDuration;
    for (let index = 0; index < batch.length; index += 1) {
      this.#settle(batch[index], outcomes[index]);
    }
  }

  async #exec(runtime) {
    const spec = runtime.spec;
    if (spec.kind === 'gate') {
      return this.#execGate(runtime);
    }
    if (spec.kind === 'program') {
      return this.#execProgram(runtime);
    }

    const durationMs = this.latencyOverrides[spec.id] ?? spec.durationMs;
    const attempt = runtime.attempts.length;
    const agent = this.agents[spec.agent];
    if (!agent) {
      return { durationMs, ok: false, error: { kind: 'no_agent', message: `缺少智能体 ${spec.agent}`, retryable: false } };
    }
    const output = agent({
      context: this.context,
      variant: this.#variantFor(runtime),
      attempt,
      nodeId: spec.id,
      artifacts: this.artifacts,
    });
    if (!output.ok) {
      return { durationMs, ok: false, error: output.error ?? { kind: 'agent_error', message: '智能体失败', retryable: true } };
    }
    if (durationMs > spec.timeoutMs) {
      return {
        durationMs,
        ok: false,
        error: {
          kind: 'timeout',
          message: `节点用时 ${durationMs}ms 超过时限 ${spec.timeoutMs}ms`,
          retryable: true,
        },
      };
    }
    return { durationMs, ok: true, payload: output.payload };
  }

  async #execProgram(runtime) {
    const id = runtime.spec.id;
    const durationMs = runtime.spec.durationMs;
    if (this.cancelled) {
      return { durationMs, ok: false, error: { kind: 'cancelled', message: '已取消', retryable: false } };
    }
    if (id.startsWith('validate')) {
      const plan = this.artifacts.plan;
      if (!plan) {
        return { durationMs, ok: false, error: { kind: 'missing_artifact', message: '缺少行程产物', retryable: false } };
      }
      const validation = rules.validatePlan(plan, {
        budgetFen: this.context.budgetFen,
        mustVisit: this.context.mustVisit,
        dietaryRestrictions: this.context.dietaryRestrictions,
      });
      this.artifacts.validation = validation;
      this.#emit('task.validation_completed', summaryOf(validation), {
        nodeId: id,
        level: validation.blocking.length ? 'warning' : 'info',
        data: { blocking: validation.blocking.length, warnings: validation.warnings.length, focus: focusOf(validation) },
      });
      this.#handleGateDecision(id, validation);
      return { durationMs, ok: true };
    }

    if (id === 'propose_candidate') {
      if (this.cancelled) {
        return { durationMs, ok: false, error: { kind: 'cancelled', message: '发布前已取消', retryable: false } };
      }
      const plan = this.artifacts.plan;
      const draft = { ...plan, id: undefined, version: undefined, status: undefined };
      const candidate = rules.proposeCandidate(this.plans, draft);
      this.plans.push(candidate);
      this.candidate = candidate;
      this.#emit('task.candidate_proposed', `候选版本 v${candidate.version} 生成`, {
        nodeId: id,
        data: { version: candidate.version, totalFen: candidate.totalFen ?? 0, repairRounds: this.repairRounds },
      });
      return { durationMs, ok: true };
    }

    if (id === 'vote_gate') {
      return this.#execVote(runtime);
    }

    if (id === 'publish_version') {
      if (this.cancelled) {
        return { durationMs, ok: false, error: { kind: 'cancelled', message: '取消先于发布生效', retryable: false } };
      }
      const currentOfficial = this.plans.find(plan => plan.status === 'official');
      const currentVersion = currentOfficial ? currentOfficial.version : null;
      const conflict = versionConflict(currentVersion, this.baseOfficialVersion);
      if (conflict) {
        this.#emit('task.version_conflict', conflict, { nodeId: id, level: 'error' });
        this.#finish(RUN_STATUS.SUPERSEDED, conflict, { reasonCode: 'version_conflict' });
        this.halted = true;
        return { durationMs, ok: false, error: { kind: 'version_conflict', message: conflict, retryable: false } };
      }
      if (!this.candidate) {
        return { durationMs, ok: false, error: { kind: 'missing_candidate', message: '没有候选版本', retryable: false } };
      }
      const published = rules.publishCandidate(this.plans, this.candidate.id, this.baseOfficialVersion);
      if (!published.ok) {
        this.#emit('task.version_conflict', published.message, { nodeId: id, level: 'error' });
        this.#finish(RUN_STATUS.SUPERSEDED, published.message, { reasonCode: 'version_conflict' });
        this.halted = true;
        return { durationMs, ok: false, error: { kind: 'version_conflict', message: published.message, retryable: false } };
      }
      this.plans = published.plans;
      const official = this.plans.find(plan => plan.status === 'official');
      this.baseOfficialVersion = official ? official.version : this.baseOfficialVersion;
      this.#emit('task.published', `v${published.publishedVersion} 已发布为正式行程`, {
        nodeId: id,
        data: { version: published.publishedVersion, approve: countVotes(this.vote).approve },
      });
      this.#finish(RUN_STATUS.PUBLISHED, `v${published.publishedVersion} 已通过表决并发布`, {
        reasonCode: 'published',
        version: published.publishedVersion,
      });
      this.halted = true;
      return { durationMs, ok: true };
    }

    return { durationMs, ok: true };
  }

  #handleGateDecision(validateId, validation) {
    const decision = rules.decideGate(validation);
    if (decision.action === 'publish') {
      this.#rewire('propose_candidate', validateId);
      return;
    }
    if (decision.action === 'confirm') {
      if (this.nodes.has('confirm_unverified')) return;
      const gateSpec = humanGateNode(validateId, decision.reason);
      this.nodes.set(gateSpec.id, newNode(gateSpec));
      this.#rewire('propose_candidate', gateSpec.id);
      this.#emit('task.node_added', '插入人工确认门控：未验证费用', {
        nodeId: gateSpec.id,
        data: { kind: 'gate', deps: [...gateSpec.deps] },
      });
      return;
    }

    const codes = validation.blocking.map(item => item.code);
    const repair = decideRepair({ codes, round: this.repairRounds, previousCodes: this.lastCodes });
    this.lastCodes = [...repair.codes];

    if (repair.kind === 'repair') {
      this.repairRounds += 1;
      const round = this.repairRounds;
      const specs = repairNodes(round, repair.focus, validateId);
      for (const spec of specs) {
        this.nodes.set(spec.id, newNode(spec));
        this.#emit('task.node_added', `返工节点：${spec.title}`, {
          nodeId: spec.id,
          data: { deps: [...spec.deps], round, focus: repair.focus },
        });
      }
      this.#rewire('propose_candidate', specs[specs.length - 1].id);
      this.#emit('task.repair_planned', `第 ${round} 轮定向返工（${repair.focus}）：${repair.reason}`, {
        nodeId: validateId,
        level: 'warning',
        data: { round, focus: repair.focus, codes: repair.codes, nodes: specs.map(spec => spec.id) },
      });
      return;
    }

    this.#emit('task.repair_blocked', repair.reason, {
      nodeId: validateId,
      level: 'error',
      data: { codes: repair.codes, repairRounds: this.repairRounds },
    });
    this.#finish(RUN_STATUS.BLOCKED, repair.reason, {
      reasonCode: 'repair_blocked',
      blockingCodes: repair.codes,
      keptOfficialVersion: this.baseOfficialVersion,
    });
    this.halted = true;
  }

  async #execGate(runtime) {
    const id = runtime.spec.id;
    this.gate = {
      nodeId: id,
      title: runtime.spec.title,
      reason: runtime.spec.note,
      state: 'open',
      requestedAt: this.sim,
      options: [
        { id: 'accept', label: '确认按估算区间处理' },
        { id: 'cancel', label: '取消本次运行' },
      ],
    };
    this.#setRun(RUN_STATUS.AWAITING_HUMAN);
    this.#emit('task.human_requested', `等待人工确认：${runtime.spec.note}`, { nodeId: id, data: { ...this.gate } });

    let choice = 'accept';
    if (this.autoConfirm) {
      this.sim += 240;
    } else {
      choice = await new Promise(resolve => {
        this.#gateWaiter = resolve;
      });
      this.sim += 240;
    }

    this.gate.state = 'resolved';
    this.gate.decision = choice;
    this.#setIfRunning();
    if (choice === 'accept') {
      this.humanNotes.push({ choice, note: '按估算区间处理', at: this.sim });
      if (this.artifacts.validation) {
        for (const item of this.artifacts.validation.issues) {
          if (item.requiresConfirmation) item.resolved = true;
        }
      }
      this.#emit('task.human_resolved', '成员确认：未验证费用按估算区间保留', { nodeId: id, data: { decision: choice } });
      return { durationMs: 240, ok: true };
    }
    this.#emit('task.human_resolved', '成员取消：不生成候选版本', { nodeId: id, level: 'warning', data: { decision: choice } });
    this.#finish(RUN_STATUS.CANCELLED, '人工门控取消，本轮不生成候选版本', { reasonCode: 'human_cancelled' });
    this.halted = true;
    return { durationMs: 240, ok: false, error: { kind: 'human_cancelled', message: '人工取消', retryable: false } };
  }

  async #execVote(runtime) {
    const id = runtime.spec.id;
    const candidate = this.candidate;
    if (!candidate) {
      return { durationMs: 0, ok: false, error: { kind: 'missing_candidate', message: '没有候选版本可表决', retryable: false } };
    }
    const eligible = this.context.members.map(member => member.member_id);
    const vote = rules.createVote(candidate.version, eligible);
    this.vote = vote;
    this.#setRun(RUN_STATUS.AWAITING_VOTE);
    this.#emit('task.vote_opened', `开始对 v${candidate.version} 表决：${eligible.length} 人，门槛 ${vote.threshold} 票`, {
      nodeId: id,
      data: { version: candidate.version, eligible, threshold: vote.threshold },
    });

    if (this.autoVote) {
      for (const member of eligible) {
        const choice = this.votePlan[member] ?? 'abstain';
        rules.castVote(vote, member, choice);
        this.#emit('task.vote_cast', `${member} 投出 ${label(choice)}`, {
          nodeId: id,
          data: { memberId: member, choice, approve: countVotes(vote).approve, threshold: vote.threshold },
        });
        if (countVotes(vote).status !== 'open') break;
        this.sim += 120;
      }
    } else {
      await new Promise(resolve => {
        this.#voteWaiter = resolve;
      });
    }

    const counts = countVotes(vote);
    vote.status = counts.status === 'open' ? 'failed' : counts.status;
    this.#setIfRunning();
    this.#emit('task.vote_closed', `表决结束：赞成 ${counts.approve} / 门槛 ${counts.threshold}，${vote.status === 'passed' ? '通过' : '未通过'}`, {
      nodeId: id,
      level: vote.status === 'passed' ? 'info' : 'warning',
      data: counts,
    });

    if (vote.status !== 'passed') {
      this.#finish(RUN_STATUS.BLOCKED, '表决未通过：保留现行正式版本', {
        reasonCode: 'vote_not_passed',
        approve: counts.approve,
        threshold: counts.threshold,
        keptOfficialVersion: this.baseOfficialVersion,
      });
      this.halted = true;
    }
    return { durationMs: 200, ok: true };
  }

  // ------------------------------------------------------------ 结果收敛
  #settle(runtime, outcome) {
    const attempt = runtime.attempts[runtime.attempts.length - 1];
    attempt.endedAt = this.sim;
    attempt.durationMs = outcome.durationMs;

    if (outcome.ok) {
      attempt.state = 'succeeded';
      runtime.status = NODE_STATUS.SUCCEEDED;
      runtime.endedAt = this.sim;
      if (outcome.payload) this.#store(runtime, outcome.payload);
      this.#emit('task.node_succeeded', `${runtime.spec.title} 完成`, {
        nodeId: runtime.spec.id,
        data: { attempt: attempt.attempt, durationMs: outcome.durationMs },
      });
      return;
    }

    attempt.state = 'failed';
    attempt.error = outcome.error ?? null;
    runtime.error = outcome.error ?? null;
    if (this.halted) {
      runtime.status = runtime.status === NODE_STATUS.FAILED ? NODE_STATUS.SKIPPED : NODE_STATUS.SKIPPED;
      this.#emit('task.node_skipped', `${runtime.spec.title} 终止`, { nodeId: runtime.spec.id, level: 'warning' });
      return;
    }
    this.#emit('task.node_failed', `${runtime.spec.title} 失败：${outcome.error?.message ?? ''}`, {
      nodeId: runtime.spec.id,
      level: 'error',
      data: { attempt: attempt.attempt, error: outcome.error },
    });

    const retryable = Boolean(outcome.error?.retryable);
    if (retryable && attempt.attempt < runtime.spec.maxAttempts) {
      const delay = retryDelayMs(attempt.attempt);
      runtime.status = NODE_STATUS.PENDING;
      runtime.retryAt = this.sim + delay;
      this.#emit('task.node_retrying', `${runtime.spec.title} 将在 ${delay}ms 后重试`, {
        nodeId: runtime.spec.id,
        level: 'warning',
        data: { delayMs: delay, nextAttempt: attempt.attempt + 1 },
      });
      return;
    }

    runtime.status = NODE_STATUS.FAILED;
    runtime.endedAt = this.sim;
    if (runtime.spec.critical) {
      this.#finish(RUN_STATUS.FAILED, `${runtime.spec.title} 失败且不可重试：${outcome.error?.message ?? ''}`, {
        reasonCode: outcome.error?.kind ?? 'node_failed',
        failedNode: runtime.spec.id,
      });
      this.halted = true;
    }
  }

  #store(runtime, payload) {
    const key = { parse_intent: 'brief', retrieve_candidates: 'candidates', map_routes: 'routes',
      coordinate_preferences: 'preferences', plan_itinerary: 'plan' }[runtime.spec.agent] ?? runtime.spec.id;
    this.artifacts[key] = payload;
  }

  #finish(status, message, extra = {}) {
    if (TERMINAL_RUN.has(this.status)) return;
    this.status = status;
    this.finishedAt = this.sim;
    this.finishedAtIso = new Date().toISOString();
    this.result = {
      status,
      message,
      repairRounds: this.repairRounds,
      steps: this.steps,
      costFen: this.costFen,
      elapsedMs: this.sim,
      peakParallel: this.peakParallel,
      officialVersion: this.plans.find(plan => plan.status === 'official')?.version
        ?? this.baseOfficialVersion,
      candidateVersion: this.candidate?.version ?? null,
      ...extra,
    };
    this.#emit('task.finished', message, {
      level: status === RUN_STATUS.PUBLISHED ? 'info' : 'warning',
      data: this.result,
    });
    this.#releaseWaiters();
  }

  #markRemainingCancelled() {
    for (const runtime of this.nodes.values()) {
      if (![NODE_STATUS.PENDING, NODE_STATUS.READY, NODE_STATUS.RUNNING].includes(runtime.status)) continue;
      if (runtime.status === NODE_STATUS.RUNNING) {
        const attempt = runtime.attempts[runtime.attempts.length - 1];
        if (attempt && attempt.state === 'running') {
          attempt.state = 'cancelled';
          attempt.endedAt = this.sim;
        }
      }
      runtime.status = NODE_STATUS.CANCELLED;
      this.#emit('task.node_cancelled', `${runtime.spec.title} 已取消`, {
        nodeId: runtime.spec.id,
        level: 'warning',
      });
    }
  }

  #blockUnrunnable() {
    let changed = false;
    for (const runtime of this.nodes.values()) {
      if (runtime.status !== NODE_STATUS.PENDING) continue;
      for (const dep of runtime.spec.deps) {
        const upstream = this.nodes.get(dep);
        if (!upstream) continue;
        if ([NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.CANCELLED, NODE_STATUS.SKIPPED]
          .includes(upstream.status)) {
          runtime.status = NODE_STATUS.BLOCKED;
          this.#emit('task.node_blocked', `${runtime.spec.title} 因依赖 ${dep} 未成功而阻塞`, {
            nodeId: runtime.spec.id,
            level: 'warning',
            data: { dep, depStatus: upstream.status },
          });
          changed = true;
          break;
        }
      }
    }
    return changed;
  }

  #advanceToNextRetry() {
    let next = null;
    for (const runtime of this.nodes.values()) {
      if (runtime.status !== NODE_STATUS.PENDING) continue;
      if (runtime.retryAt === undefined || runtime.retryAt === null) continue;
      if (!this.#depsOk(runtime)) continue;
      if (next === null || runtime.retryAt < next) next = runtime.retryAt;
    }
    if (next === null) return false;
    this.sim = Math.max(this.sim, next);
    return true;
  }

  #depsOk(runtime) {
    return runtime.spec.deps.every(dep => {
      const upstream = this.nodes.get(dep);
      return Boolean(upstream) && upstream.status === NODE_STATUS.SUCCEEDED;
    });
  }

  #allTerminal() {
    return [...this.nodes.values()].every(runtime =>
      [NODE_STATUS.SUCCEEDED, NODE_STATUS.SKIPPED, NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.CANCELLED]
        .includes(runtime.status));
  }

  #rewire(nodeId, dep) {
    const runtime = this.nodes.get(nodeId);
    if (!runtime) return;
    runtime.spec = { ...runtime.spec, deps: [dep] };
  }

  #variantFor(runtime) {
    if (this.repairRounds > 0) return 'economy';
    return this.context.pace === 'relaxed' ? 'balanced' : 'balanced';
  }

  #setRun(status) {
    this.status = status;
  }

  #setIfRunning() {
    if (this.status === RUN_STATUS.AWAITING_HUMAN || this.status === RUN_STATUS.AWAITING_VOTE) {
      this.status = RUN_STATUS.RUNNING;
    }
  }

  #emit(type, message, options = {}) {
    this.log.emit(type, message, { at: this.sim, ...options });
  }

  #releaseWaiters() {
    if (this.#gateWaiter) {
      const waiter = this.#gateWaiter;
      this.#gateWaiter = null;
      waiter('cancel');
    }
    if (this.#voteWaiter) {
      const waiter = this.#voteWaiter;
      this.#voteWaiter = null;
      waiter();
    }
  }

  #counts() {
    const tallyCounts = { succeeded: 0, failed: 0, other: 0 };
    for (const runtime of this.nodes.values()) {
      if (runtime.status === NODE_STATUS.SUCCEEDED) tallyCounts.succeeded += 1;
      else if (runtime.status === NODE_STATUS.FAILED) tallyCounts.failed += 1;
      else tallyCounts.other += 1;
    }
    return tallyCounts;
  }

  #stage() {
    if (this.status === RUN_STATUS.PUBLISHED) return 'finished';
    const order = ['accepted', 'extracting', 'searching', 'planning', 'checking', 'saving', 'finished'];
    let index = 0;
    for (const runtime of this.nodes.values()) {
      if (runtime.status === NODE_STATUS.PENDING) continue;
      const position = order.indexOf(runtime.spec.stage);
      if (position > index) index = position;
    }
    return order[Math.min(index, order.length - 1)];
  }
}

// ---------------------------------------------------------------- 辅助
function newNode(spec) {
  return {
    spec,
    status: NODE_STATUS.PENDING,
    attempts: [],
    startedAt: null,
    endedAt: null,
    retryAt: null,
    error: null,
  };
}

function toContext(input) {
  const conditions = input.common_conditions?.current_version ?? {};
  const travel = input.travel ?? {};
  return {
    destination: travel.destination ?? conditions.destination ?? '未知目的地',
    startDate: travel.start_date ?? conditions.start_date ?? '2026-12-05',
    endDate: travel.end_date ?? conditions.end_date ?? '2026-12-06',
    budgetFen: conditions.budget_fen ?? input.budgetFen ?? 0,
    mustVisit: conditions.must_visit ?? input.mustVisit ?? [],
    dietaryRestrictions: conditions.dietary_restrictions ?? input.dietaryRestrictions ?? [],
    pace: conditions.pace ?? 'balanced',
    members: input.members ?? [],
    degradedPrice: Boolean(input.degradedPrice ?? input.degraded_price),
  };
}

function countVotes(vote) {
  return rules.tally(vote);
}

function label(choice) {
  return { approve: '赞成', reject: '反对', abstain: '弃权' }[choice] ?? choice;
}

function summaryOf(validation) {
  return `校验完成：${validation.blocking.length} 项阻塞、${validation.warnings.length} 项警告；已知费用 ${validation.knownTotalFen} 分`;
}

function focusOf(validation) {
  const codes = validation.blocking.map(item => item.code);
  if (codes.includes('V-BUDGET')) return 'budget';
  if (codes.some(code => code.startsWith('V-TIME') || code === 'V-HOURS')) return 'time';
  if (codes.includes('V-DIET')) return 'diet';
  if (codes.includes('V-MUST-VISIT')) return 'must';
  return '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
