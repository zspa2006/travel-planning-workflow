import { AgentError, isMoney, isObject, isText, MODES, NODE_DEPS, parseTrip, requireInput } from './contract.mjs';
import { createProviders } from './providers.mjs';
import { coordinate, importGuides, mapTrip, planTrip, retrieve } from './nodes.mjs';
import { parseRequirements } from './requirements.mjs';
import { AGENT_SCHEMA_VERSION, validateAgentResult, validateNodeData } from './results.mjs';

export { NODE_DEPS, AGENT_SCHEMA_VERSION, validateAgentResult };

function validateRequest(request) {
  requireInput(isObject(request) && isText(request.runId), '请求缺少 runId');
  requireInput(typeof request.nodeId === 'string' && Object.hasOwn(NODE_DEPS, request.nodeId), '节点名称无效');
  requireInput(Number.isSafeInteger(request.attempt) && request.attempt >= 1, 'attempt 应为正整数');
}

function dependency(request, nodeId) {
  const result = request.dependencies?.[nodeId];
  requireInput(isObject(result) && result.runId === request.runId && result.nodeId === nodeId &&
    result.status === 'ok' && validateAgentResult(result), '缺少同一运行的有效节点结果 ' + nodeId);
  if (result.data.state === 'needs_confirmation') throw new AgentError('REQUIREMENTS_UNCONFIRMED', '请确认解析草案后提交结构化输入');
  return result.data;
}

async function executeNode(request, inputs, providers) {
  switch (request.nodeId) {
    case 'parse': {
      const input = request.input;
      const trip = input === undefined ? null : parseTrip(input);
      const draft = request.requirementText === undefined ? null : await parseRequirements(request.requirementText, providers);
      if (draft && !trip) return { state: 'needs_confirmation', requirementDraft: draft };
      return { ...await importGuides(trip ?? parseTrip(input), providers), ...(draft ? { requirementDraft: draft } : {}) };
    }
    case 'retrieve': return retrieve(inputs[0], providers);
    case 'preferences': return coordinate(inputs[0]);
    case 'map': return mapTrip(inputs[0], inputs[1], inputs[2], providers);
    case 'plan': return planTrip(inputs[0], inputs[1], inputs[2], providers);
  }
}

export function createAgent({ providers, providerFactory = createProviders, timeoutMs = 60000 } = {}) {
  async function runNode(request, { signal } = {}) {
    const identity = {
      schemaVersion: AGENT_SCHEMA_VERSION,
      runId: isText(request?.runId) ? request.runId : null,
      nodeId: typeof request?.nodeId === 'string' && Object.hasOwn(NODE_DEPS, request.nodeId) ? request.nodeId : null,
      attempt: Number.isSafeInteger(request?.attempt) && request.attempt >= 1 ? request.attempt : null
    };
    let timer;
    let stopListening;
    try {
      validateRequest(request);
      const deadline = request.timeoutMs ?? timeoutMs;
      requireInput(Number.isSafeInteger(deadline) && deadline >= 1 && deadline <= 2147483647, 'timeoutMs 应为有效的正整数');
      if (signal?.aborted) throw new AgentError('AGENT_CANCELLED', '节点已取消');
      const inputs = NODE_DEPS[identity.nodeId].map(nodeId => dependency(request, nodeId));
      const controller = new AbortController();
      const interrupted = new Promise((_, reject) => {
        function stop(error) {
          reject(error);
          controller.abort(error);
        }
        const cancel = () => stop(new AgentError('AGENT_CANCELLED', '节点已取消'));
        signal?.addEventListener('abort', cancel, { once: true });
        stopListening = () => signal?.removeEventListener('abort', cancel);
        timer = setTimeout(() => stop(new AgentError('AGENT_TIMEOUT', '节点超过执行时限', true)), deadline);
      });
      const services = providers ?? providerFactory({ signal: controller.signal });
      const data = await Promise.race([executeNode(request, inputs, services), interrupted]);
      if (!validateNodeData(identity.nodeId, data)) throw new AgentError('INVALID_AGENT_OUTPUT', '节点产物未通过结构校验', true);
      return { ...identity, status: 'ok', data };
    } catch (error) {
      const failure = error instanceof AgentError ? error : new AgentError('AGENT_FAILURE', '节点执行失败');
      return { ...identity, status: 'error', error: {
        code: failure.code, message: failure.message, retryable: failure.retryable
      } };
    } finally {
      clearTimeout(timer);
      stopListening?.();
    }
  }

  async function runWorkflow({ runId, input, requirementText, timeoutMs } = {}, options) {
    const nodes = {};
    async function run(nodeId) {
      const result = await runNode({ runId, nodeId, attempt: 1, input, requirementText, timeoutMs, dependencies: nodes }, options);
      nodes[nodeId] = result;
      return result;
    }
    const parsed = await run('parse');
    if (parsed.status === 'error' || parsed.data.state === 'needs_confirmation') return { result: parsed, nodes };
    const [retrieved, preferences] = await Promise.all([run('retrieve'), run('preferences')]);
    if (retrieved.status === 'error') return { result: retrieved, nodes };
    if (preferences.status === 'error') return { result: preferences, nodes };
    const mapped = await run('map');
    if (mapped.status === 'error') return { result: mapped, nodes };
    return { result: await run('plan'), nodes };
  }

  async function reviseWorkflow({ runId, input, previousPlan, instruction } = {}) {
    const revisionProvider = providers ?? providerFactory();
    const invalid = (code, message) => ({ result: { schemaVersion: AGENT_SCHEMA_VERSION, runId: isText(runId) ? runId : null, nodeId: 'plan',
      attempt: 1, status: 'error', error: { code, message, retryable: false } }, nodes: {} });
    if (!isText(runId) || !isObject(input) || !isObject(previousPlan?.budget) || !isMoney(previousPlan.budget.knownTotalFen) || !isText(instruction)) {
      return invalid('INVALID_REVISION', '文字修改需要原任务输入、原行程和修改说明');
    }
    try { parseTrip(input); } catch (error) { return invalid('INVALID_REVISION', error.message); }
    if (!revisionProvider.revise) return invalid('REVISION_UNAVAILABLE', '文字修改需要模型适配器');
    let proposal;
    try {
      proposal = await revisionProvider.revise({
        instruction, transportMode: input.transportMode ?? 'transit', budgetFen: input.budgetFen ?? null,
        candidates: (Array.isArray(input.places) ? input.places : []).slice(0, 90).map(({ name, city }) => ({ name, city }))
      });
    } catch (error) {
      return invalid(error?.code ?? 'REVISION_UNAVAILABLE', '无法解析文字修改，请改用结构化输入');
    }
    if (!isObject(proposal) || (proposal.transportMode !== undefined && !MODES.includes(proposal.transportMode)) ||
      (proposal.budgetFen !== undefined && !isMoney(proposal.budgetFen)) ||
      (proposal.addMustVisit !== undefined && (!Array.isArray(proposal.addMustVisit) || !proposal.addMustVisit.every(name =>
        isText(name) && input.places?.some(place => place.name === name))))) {
      return invalid('INVALID_REVISION', '修改建议含不可用的交通、预算或地点');
    }
    if (proposal.transportMode === undefined && proposal.budgetFen === undefined && !proposal.addMustVisit?.length) {
      return invalid('REVISION_NOT_SUPPORTED', '请指定市内默认交通方式、预算上限或保留已导入的地点');
    }
    if (proposal.budgetFen !== undefined && isMoney(input.budgetFen) && proposal.budgetFen > input.budgetFen) {
      return invalid('REVISION_BUDGET_CONFIRMATION_REQUIRED', '提高团队预算需由成员确认后更新结构化输入');
    }
    const next = {
      ...input, transportMode: proposal.transportMode ?? input.transportMode, budgetFen: proposal.budgetFen ?? input.budgetFen,
      mustVisit: [...new Set([...(input.mustVisit ?? []), ...(proposal.addMustVisit ?? [])])]
    };
    const changedTransport = proposal.transportMode !== undefined && proposal.transportMode !== (input.transportMode ?? 'transit');
    if (changedTransport) {
      next.intercityMode = input.intercityMode ?? input.transportMode ?? 'transit';
      next.quotes = (input.quotes ?? []).filter(entry =>
        entry.category !== '市内交通' || input.routePreferences?.some(route => route.id && route.id === entry.serviceId));
    }
    const output = await runWorkflow({ runId, input: next });
    if (output.result.status === 'ok') {
      output.result.data.revision = {
        instruction, transportMode: proposal.transportMode ?? null, budgetFen: proposal.budgetFen ?? null,
        addedMustVisit: proposal.addMustVisit ?? [], removedQuoteCount: (input.quotes?.length ?? 0) - (next.quotes?.length ?? 0),
        knownTotalChangeFen: output.result.data.budget.knownTotalFen - previousPlan.budget.knownTotalFen
      };
    }
    return output;
  }

  return { runNode, runWorkflow, reviseWorkflow };
}
