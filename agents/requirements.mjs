import { AgentError, isMoney, isObject, isText, MODES, PACE_LIMIT, requireInput, source } from './contract.mjs';

const fields = ['origin', 'destination', 'startDate', 'endDate', 'durationDays', 'travelerCount', 'budgetFen',
  'pace', 'transportMode', 'mustVisit', 'dietaryRestrictions', 'interests', 'lodgingRequirements', 'unresolved'];

export async function parseRequirements(text, providers) {
  requireInput(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000, '多人需求正文应为 1 至 4000 字符');
  if (!providers.parseRequirements) throw new AgentError('MODEL_NOT_CONFIGURED', '自然语言解析需要模型或模拟适配器');
  const draft = await providers.parseRequirements(text.trim());
  const textFields = ['origin', 'destination'];
  const dateFields = ['startDate', 'endDate'];
  const listFields = ['mustVisit', 'dietaryRestrictions', 'interests', 'lodgingRequirements', 'unresolved'];
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const validList = value => Array.isArray(value) && value.length <= 24 && value.every(isText);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  if (!isObject(draft) || Object.keys(draft).some(key => !fields.includes(key)) ||
    !textFields.every(key => draft[key] == null || isText(draft[key])) ||
    !dateFields.every(key => draft[key] == null || validDate(draft[key])) ||
    !listFields.every(key => draft[key] == null || validList(draft[key])) ||
    !['durationDays', 'travelerCount'].every(key => draft[key] == null || positive(draft[key])) ||
    (draft.budgetFen != null && !isMoney(draft.budgetFen)) ||
    (draft.pace != null && !Object.hasOwn(PACE_LIMIT, draft.pace)) ||
    (draft.transportMode != null && !MODES.includes(draft.transportMode))) {
    throw new AgentError('MODEL_INVALID_OUTPUT', '自然语言解析结果与约定字段或类型不符', true);
  }
  const unresolved = new Set(draft.unresolved ?? []);
  if (!draft.destination) unresolved.add('目的地');
  if (!draft.durationDays && !(draft.startDate && draft.endDate)) unresolved.add('旅行日期或时长');
  if (draft.startDate && draft.endDate) {
    const days = (Date.parse(draft.endDate) - Date.parse(draft.startDate)) / 86400000 + 1;
    if (days <= 0 || (draft.durationDays && days !== draft.durationDays)) unresolved.add('旅行日期与时长冲突');
  }
  return {
    ...draft, unresolved: [...unresolved],
    source: source('requirement-parser', '显式提交的多人需求文本', 'unverified')
  };
}
