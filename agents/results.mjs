import { isMoney, isObject, isText, MODES, NODE_DEPS, timeValue } from './contract.mjs';

export const AGENT_SCHEMA_VERSION = 1;

const arrayOf = (value, predicate) => Array.isArray(value) && value.every(predicate);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const records = value => arrayOf(value, isObject);
const texts = value => arrayOf(value, isText);
const day = value => Number.isSafeInteger(value?.day) && value.day > 0 &&
  isText(value.city) && (value.date === null || /^\d{4}-\d{2}-\d{2}$/.test(value.date));
const evidence = value => isObject(value) && isText(value.provider) && isText(value.reference) &&
  ['verified', 'estimated', 'unverified', 'missing'].includes(value.confidence) &&
  (value.queriedAt === null || typeof value.queriedAt === 'string' && Number.isFinite(Date.parse(value.queriedAt)));
const place = value => isObject(value) && nonempty(value.id) && isText(value.name) && isText(value.city) && evidence(value.source);
const issue = value => isObject(value) && isText(value.code) && isText(value.message);
const nullableMoney = value => value === null || isMoney(value);
const expense = value => isObject(value) && isText(value.category) && nonempty(value.label) &&
  ['personal', 'shared'].includes(value.scope) && isText(value.unit) && isMoney(value.quantity) && value.quantity > 0 &&
  nullableMoney(value.unitFen) && nullableMoney(value.totalFen) && evidence(value.source);
const route = value => isObject(value) && MODES.includes(value.mode) && isObject(value.from) && isObject(value.to) &&
  nullableMoney(value.durationMinutes) && (value.distanceMeters === null ||
    (Number.isFinite(value.distanceMeters) && value.distanceMeters >= 0)) && evidence(value.source) && records(value.segments);
const activity = value => isObject(value) && nonempty(value.place) && typeof value.transport === 'string' &&
  nonempty(value.id) && nonempty(value.placeId) && isText(value.placeName) &&
  timeValue(value.start) !== null && timeValue(value.end) !== null && timeValue(value.end) > timeValue(value.start) &&
  evidence(value.source) && evidence(value.timeSource) && evidence(value.openingSource) &&
  arrayOf(value.opening, period => isObject(period) && timeValue(period.start) !== null &&
    timeValue(period.end) !== null && timeValue(period.end) > timeValue(period.start)) &&
  texts(value.dietary) && (value.inboundRoute === null || route(value.inboundRoute));

export function validateNodeData(nodeId, data) {
  if (!isObject(data)) return false;
  switch (nodeId) {
    case 'parse':
      if (data.state === 'needs_confirmation') return isObject(data.requirementDraft) && texts(data.requirementDraft.unresolved);
      return isText(data.roomId) && arrayOf(data.days, day) && data.days.length > 0 && texts(data.cities) &&
        records(data.members) && records(data.stays) && records(data.journeys) && records(data.routePreferences) &&
        arrayOf(data.places, place) && arrayOf(data.quotes, expense) && arrayOf(data.issues, issue);
    case 'retrieve':
      return arrayOf(data.places, place) && arrayOf(data.quotes, expense) && arrayOf(data.issues, issue);
    case 'preferences':
      return isText(data.pace) && texts(data.mustVisit) && texts(data.dietaryRestrictions) &&
        records(data.constraintsByMember) && arrayOf(data.issues, issue);
    case 'map':
      return arrayOf(data.days, item => day(item) && arrayOf(item.stops, stop => isObject(stop) && place(stop.place))) &&
        arrayOf(data.routes, route) && arrayOf(data.quotes, expense) && arrayOf(data.issues, issue);
    case 'plan':
      return isText(data.roomId) && nonempty(data.title) && data.currency === 'CNY' && isObject(data.budget) &&
        isMoney(data.budget.knownTotalFen) && nullableMoney(data.budget.teamBudgetFen) && isMoney(data.budget.missingCount) &&
        isObject(data.preferences) && texts(data.preferences.mustVisit) && texts(data.preferences.dietaryRestrictions) &&
        records(data.stays) && records(data.journeys) &&
        arrayOf(data.days, item => day(item) && arrayOf(item.activities, activity)) &&
        arrayOf(data.expenses, expense) && arrayOf(data.issues, issue);
    default:
      return false;
  }
}

export function validateAgentResult(result) {
  if (!isObject(result) || result.schemaVersion !== AGENT_SCHEMA_VERSION) return false;
  const validNode = typeof result.nodeId === 'string' && Object.hasOwn(NODE_DEPS, result.nodeId);
  const validAttempt = Number.isSafeInteger(result.attempt) && result.attempt > 0;
  if (result.status === 'error') {
    return (result.runId === null || isText(result.runId)) && (result.nodeId === null || validNode) &&
      (result.attempt === null || validAttempt) && isObject(result.error) && isText(result.error.code) && isText(result.error.message) &&
      typeof result.error.retryable === 'boolean';
  }
  return result.status === 'ok' && isText(result.runId) && validNode && validAttempt &&
    validateNodeData(result.nodeId, result.data);
}
