import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AGENT_SCHEMA_VERSION, createAgent, NODE_DEPS, validateAgentResult } from '../agents/index.mjs';
import { createMockProviders, MOCK_REQUIREMENT_TEXT } from '../agents/mock.mjs';
import { createProviders } from '../agents/providers.mjs';

const example = async name => JSON.parse(await readFile(new URL('../examples/' + name + '.json', import.meta.url)));
const suzhou = await example('f-suzhou-request');

test('five nodes produce a frontend-compatible itinerary with traceable unknowns', async () => {
  const { nodes, result } = await createAgent({ providers: {} }).runWorkflow(suzhou);
  assert.deepEqual(Object.keys(nodes).sort(), ['map', 'parse', 'plan', 'preferences', 'retrieve']);
  assert.equal(result.status, 'ok');
  const { days, expenses, budget, issues } = result.data;
  assert.deepEqual(days.map(day => day.date), ['2026-12-05', '2026-12-06']);
  assert.deepEqual(days.map(day => day.activities.find(activity => activity.role === 'sight').place), ['拙政园', '平江路']);
  const activities = days.flatMap(day => day.activities);
  assert.ok(activities.every(({ start, end, source, timeSource }) =>
    /^\d\d:\d\d$/.test(start) && start < end && source.provider && timeSource.confidence === 'estimated'));
  assert.equal(activities.find(activity => activity.inboundRoute).inboundRoute.durationMinutes, null);
  assert.equal(expenses.find(expense => expense.category === '住宿').totalFen, null);
  assert.equal(expenses.find(expense => expense.category === '门票').totalFen, 16000);
  assert.equal(budget.knownTotalFen, 16000);
  assert.equal(budget.teamBudgetFen, 120000);
  assert.equal(budget.missingCount, 4);
  assert.equal(budget.totalRangeFen, null);
  assert.ok(issues.some(item => item.code === 'ROUTE_UNVERIFIED'));
  assert.ok(issues.some(item => item.code === 'PACE_CONFLICT'));
});

test('bad input, cross-run dependencies and upstream failures have structured errors', async () => {
  const agent = createAgent({ providers: {} });
  const bad = await agent.runWorkflow(await example('f-invalid-request'));
  assert.equal(bad.result.error.code, 'INVALID_INPUT');
  assert.equal(bad.result.error.retryable, false);
  assert.deepEqual(Object.keys(bad.nodes), ['parse']);
  const first = await agent.runNode({ ...suzhou, nodeId: 'parse', attempt: 1 });
  const wrongRun = await agent.runNode({
    runId: 'another-run', nodeId: 'preferences', attempt: 2, dependencies: { parse: first }
  });
  assert.equal(wrongRun.attempt, 2);
  assert.equal(wrongRun.error.code, 'INVALID_INPUT');
  const input = { room: suzhou.input.room };
  const noMap = await agent.runWorkflow({ runId: 'no-map', input });
  assert.equal(noMap.result.error.code, 'MAP_NOT_CONFIGURED');
  const httpFailure = createProviders({
    env: { AMAP_WEB_SERVICE_KEY: 'test-key' }, fetcher: async () => new Response('', { status: 503 })
  });
  const error = await createAgent({ providers: httpFailure }).runWorkflow({ runId: 'unavailable', input });
  assert.deepEqual(error.result.error, { code: 'AMAP_HTTP_ERROR', message: 'AMAP HTTP 503', retryable: true });
});

test('provider responses preserve transport timing and never turn maps into prices', async () => {
  const queriedAt = '2026-11-13T03:00:00.000Z';
  const calls = [];
  const providers = createProviders({
    env: { AMAP_WEB_SERVICE_KEY: 'test-map', DEEPSEEK_API_KEY: 'test-model' },
    now: () => queriedAt,
    fetcher: async (url, options) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname);
      if (parsed.pathname === '/chat/completions') {
        assert.equal(options.headers.Authorization, 'Bearer test-model');
        return Response.json({ choices: [{ message: { content: '{"minutes":{"amap-sight":45,"invented":120}}' } }] });
      }
      assert.equal(parsed.searchParams.get('key'), 'test-map');
      if (parsed.pathname === '/v5/place/text') {
        assert.equal(parsed.searchParams.get('region'), '苏州');
        assert.equal(parsed.searchParams.get('city_limit'), 'true');
        const type = parsed.searchParams.get('types');
        const poi = (id, name, location) => ({ id, name, location, citycode: '0512' });
        const pois = {
          '110000': [poi('sight', '拙政园', '120.1,31.1')],
          '050000': [poi('food', '餐厅', '120.2,31.2')],
          '150100|150200|150300': [poi('station', '苏州站', '120.3,31.3')]
        };
        return Response.json({ status: '1', pois: pois[type] ?? [] });
      }
      assert.equal(parsed.pathname, '/v5/direction/transit/integrated');
      assert.equal(parsed.searchParams.get('city1'), '0512');
      assert.equal(parsed.searchParams.get('city2'), '0512');
      assert.equal(parsed.searchParams.get('date'), '2026-12-05');
      return Response.json({ status: '1', route: { transits: [{ cost: { duration: '901', transit_fee: '2' } }] } });
    }
  });
  const room = { ...suzhou.input.room, endDate: suzhou.input.room.startDate };
  const { result } = await createAgent({ providers }).runWorkflow({ runId: 'live-shape', input: { room } });
  assert.equal(result.status, 'ok');
  const sight = result.data.days[0].activities.find(activity => activity.role === 'sight');
  assert.equal(sight.durationMinutes, 45);
  assert.equal(sight.source.queriedAt, queriedAt);
  assert.equal(sight.inboundRoute.durationMinutes, 16);
  assert.equal(sight.inboundRoute.source.confidence, 'estimated');
  assert.equal(result.data.expenses.find(expense => expense.category === '市内交通').totalFen, null);
  assert.ok(!JSON.stringify(result).includes('test-map'));
  assert.ok(calls.includes('/chat/completions'));
});

test('provider errors and unavailable facts stay visible in the plan', async () => {
  const input = structuredClone(suzhou.input);
  input.mustVisit = ['不存在的景点'];
  input.budgetFen = 15000;
  input.quotes.push({
    ...input.quotes[0], place: '未安排的景点', label: '不适用费用'
  });
  const providers = {
    route() { throw new Error('route transport failure'); },
    async suggest() { throw new Error('model failure'); }
  };
  const { result } = await createAgent({ providers }).runWorkflow({ runId: 'degraded', input });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.budget.knownTotalFen, 16000);
  const codes = new Set(result.data.issues.map(item => item.code));
  for (const code of ['MUST_VISIT_MISSING', 'QUOTE_NOT_APPLIED', 'KNOWN_COST_OVER_BUDGET', 'MODEL_FALLBACK', 'ROUTE_UNVERIFIED']) {
    assert.ok(codes.has(code), code);
  }
});

test('multi-city workflow links the actual previous day stop and preserves mode', async () => {
  const input = structuredClone(suzhou.input);
  input.room.destination = '苏州、上海';
  input.stops = [{ city: '苏州', days: 1 }, { city: '上海', days: 1 }];
  input.intercityMode = 'driving';
  input.members[1].preference.mustVisit = [];
  input.places.push({ name: '上海站', kind: 'station', city: '上海', source: input.places[2].source });
  const providers = {
    async route(from, to, mode) {
      return { durationMinutes: mode === 'driving' ? 90 : 5, source: from.source };
    }
  };
  const { result } = await createAgent({ providers }).runWorkflow({ runId: 'multi-city', input });
  assert.equal(result.status, 'ok');
  const firstDay = result.data.days[0];
  const secondDay = result.data.days[1];
  const route = secondDay.activities[0].inboundRoute;
  assert.equal(route.mode, 'driving');
  assert.equal(route.fromDate, firstDay.date);
  assert.equal(route.from.id, firstDay.activities.at(-1).placeId);
  assert.equal(route.to.city, '上海');
  assert.equal(secondDay.activities[0].start, '10:30');
});

test('duration-only drafts retain all days and avoid date-specific quotes', async () => {
  const input = structuredClone(suzhou.input);
  delete input.room.startDate;
  delete input.room.endDate;
  input.durationDays = 35;
  input.stays = [{ id: 'stay', city: '苏州', checkInDay: 1, checkOutDay: 3, rooms: 2 }];
  const agent = createAgent({ providers: { quote: async () => assert.fail('undated quote lookup') } });
  const { result } = await agent.runWorkflow({ runId: 'duration', input });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.dateStatus, 'duration_only');
  assert.equal(result.data.days.length, 35);
  assert.ok(result.data.days.every(day => day.date === null));
  assert.equal(result.data.expenses.find(item => item.serviceId === 'stay').quantity, 4);
  assert.ok(result.data.issues.some(item => item.code === 'TRAVEL_DATES_MISSING'));
  const bad = await agent.runWorkflow({ runId: 'inconsistent', input: { ...suzhou.input, durationDays: 3 } });
  assert.equal(bad.result.error.code, 'INVALID_INPUT');
});

test('overnight arrival, room-night quotes, custom duplicate charges and price ranges are retained', async () => {
  const input = structuredClone(suzhou.input);
  input.room.endDate = '2026-12-07';
  input.origin = '南京';
  input.budgetFen = 80000;
  input.stays = [{ id: 'hotel', city: '苏州', rooms: 2, checkInDay: 2, checkOutDay: 3 }];
  input.journeys = [
    { id: 'go', kind: 'outbound', mode: 'rail', fromCity: '南京', toCity: '苏州', fromPlace: '南京站', toPlace: '苏州站',
      departDay: 1, arriveDay: 2, departTime: '23:30', arriveTime: '07:00', bufferMinutes: 20 },
    { id: 'back', kind: 'return', mode: 'rail', fromCity: '苏州', toCity: '南京', fromPlace: '苏州站', toPlace: '南京站',
      departDay: 3, arriveDay: 3, departTime: '17:00', arriveTime: '18:00', bufferMinutes: 30 }
  ];
  const source = { provider: '课程样例', reference: '报价', confidence: 'estimated' };
  const go = { serviceId: 'go', chargeId: 'rail-go', category: '往返交通', label: '去程车票', unit: 'person',
    scope: 'personal', unitFen: 10000, quantity: 2, source };
  input.quotes.push(go, { ...go, category: '自定义交通' },
    { ...go, serviceId: 'back', chargeId: 'rail-back', unitFen: null, unitFenRange: [10000, 25000] });
  const providers = {
    quote: async request => {
      assert.equal(request.id, 'hotel');
      assert.equal(request.checkInDate, '2026-12-06');
      return { label: '酒店估算', scope: 'shared', unit: 'roomNight', unitFen: 12000,
        quantity: 2, travelers: 2, taxIncluded: true, source };
    }
  };
  const { result } = await createAgent({ providers }).runWorkflow({ runId: 'stays', input });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data.days[0].activities, []);
  assert.equal(result.data.days[1].activities[0].start, '07:00');
  assert.equal(result.data.days[1].activities[0].end, '07:20');
  assert.equal(result.data.days[2].activities.at(-1).start, '16:30');
  assert.equal(result.data.journeys[0].durationMinutes, 450);
  assert.equal(result.data.stays[0].nights, 1);
  assert.equal(result.data.expenses.filter(item => item.chargeId === 'rail-go').length, 1);
  assert.deepEqual(result.data.budget.quotedRangeFen, [80000, 110000]);
  assert.ok(result.data.issues.some(item => item.code === 'PRICE_RANGE_BUDGET_RISK'));
});

test('mixed routes require evidence of the requested mode and retain geometry', async () => {
  const providers = createProviders({
    env: { AMAP_WEB_SERVICE_KEY: 'test-key' },
    fetcher: async () => Response.json({ status: '1', route: { transits: [{
      cost: { duration: '900' }, segments: [{ walking: { distance: '200', steps: [{ polyline: '120.1,31.2;120.2,31.3' }] },
        bus: { buslines: [{ type: '地铁线路', name: '1号线', distance: '2000', departure_stop: { name: '甲站' } }] } }]
    }] } })
  });
  const from = { location: [120.1, 31.2], citycode: '0512' };
  const to = { location: [120.2, 31.3], citycode: '0512' };
  const route = await providers.route(from, to, 'subway', '2026-12-05');
  assert.deepEqual(route.segments.map(item => item.mode), ['walking', 'subway']);
  assert.equal(route.segments[1].from, '甲站');
  assert.equal(route.segments[0].geometry.length, 2);
  assert.equal(await providers.route(from, to, 'ferry', '2026-12-05'), null);
  assert.equal(await providers.route(from, to, 'subway', '2026-12-05', ['walking']), null);
  const input = structuredClone(suzhou.input);
  input.routePreferences = [{ day: 1, from: '苏州站', to: '拙政园', mode: 'taxi', vehicles: 1, seatsPerVehicle: 1 }];
  const { result } = await createAgent({ providers: {} }).runWorkflow({ runId: 'mixed', input });
  assert.equal(result.data.days[0].activities[1].inboundRoute.mode, 'taxi');
  assert.ok(result.data.issues.some(item => item.code === 'VEHICLE_CAPACITY_UNCONFIRMED'));
});

test('guide screenshot failure preserves available text and keeps unconfirmed constraints out', async () => {
  const input = { ...suzhou.input, places: [], guides: [
    { city: '苏州', text: '建议游览拙政园', url: 'https://example.com/note', screenshotRef: 'upload-1' },
    { city: '苏州', screenshotRef: 'upload-2' }
  ] };
  const providers = {
    recognizeGuide: async () => { throw new Error('unreadable image'); },
    extractGuide: async () => [
      { name: '拙政园', city: '苏州', kind: 'sight', durationMinutes: 55, mustVisit: true },
      { name: '虚构景点', city: '苏州', kind: 'sight' }
    ]
  };
  const { result, nodes } = await createAgent({ providers }).runWorkflow({ runId: 'guide', input });
  assert.equal(result.status, 'ok');
  assert.deepEqual(nodes.parse.data.places.map(item => item.name), ['拙政园']);
  assert.equal(nodes.parse.data.places[0].source.reference, 'https://example.com/note');
  assert.deepEqual(nodes.parse.data.mustVisit, []);
  assert.equal(result.data.days[0].activities[0].durationMinutes, 55);
  assert.ok(result.data.issues.some(item => item.code === 'GUIDE_SCREENSHOT_UNREADABLE'));
  assert.ok(result.data.issues.some(item => item.code === 'GUIDE_SOURCE_MISSING'));
});

test('text revision replans routes and expires prices for the changed default mode', async () => {
  const input = structuredClone(suzhou.input);
  input.quotes.push({ ...input.quotes[0], category: '市内交通', label: '原交通费用', place: null });
  const agent = createAgent({ providers: { revise: async () => ({ transportMode: 'bus', budgetFen: 100000 }) } });
  const { result: first } = await agent.runWorkflow({ runId: 'first', input });
  const { result } = await agent.reviseWorkflow({ runId: 'next', input, previousPlan: first.data, instruction: '改乘公交，预算降至一千元' });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.days[0].activities[1].inboundRoute.mode, 'bus');
  assert.equal(result.data.expenses.find(item => item.category === '市内交通').totalFen, null);
  assert.equal(result.data.revision.knownTotalChangeFen, -16000);
  assert.equal(first.data.expenses.find(item => item.category === '市内交通').totalFen, 16000);
});

test('explicit natural language produces a validated draft and waits for confirmed structured input', async () => {
  const agent = createAgent({ providers: createMockProviders() });
  const { result, nodes } = await agent.runWorkflow({ runId: 'text', requirementText: MOCK_REQUIREMENT_TEXT });
  assert.equal(result.schemaVersion, AGENT_SCHEMA_VERSION);
  assert.ok(validateAgentResult(result));
  assert.deepEqual(Object.keys(nodes), ['parse']);
  assert.equal(result.data.state, 'needs_confirmation');
  assert.equal(result.data.requirementDraft.budgetFen, 120000);
  assert.deepEqual(result.data.requirementDraft.dietaryRestrictions, ['素食']);
  const downstream = await agent.runNode({ runId: 'text', nodeId: 'retrieve', attempt: 1, dependencies: nodes });
  assert.equal(downstream.error.code, 'REQUIREMENTS_UNCONFIRMED');
  const confirmed = await agent.runWorkflow({ ...suzhou, requirementText: MOCK_REQUIREMENT_TEXT });
  assert.equal(confirmed.result.nodeId, 'plan');
  assert.deepEqual(confirmed.nodes.parse.data.mustVisit, []);
  const malformed = createAgent({ providers: { parseRequirements: async () => ({ budgetFen: '120000' }) } });
  const invalid = await malformed.runWorkflow({ runId: 'text', requirementText: MOCK_REQUIREMENT_TEXT });
  assert.equal(invalid.result.error.code, 'MODEL_INVALID_OUTPUT');
  assert.equal(invalid.result.error.retryable, true);
});

test('D can call nodes independently with validated dependencies and retry a timed-out attempt', async () => {
  const seen = [];
  let fail = true;
  const agent = createAgent({ providerFactory: ({ signal }) => ({
    search(city, options) {
      seen.push(signal);
      if (!fail) return createMockProviders().search(city, options);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  }) });
  const request = { ...suzhou, runId: 'scheduler' };
  const parse = await agent.runNode({ ...request, nodeId: 'parse', attempt: 1 });
  const retrieveRequest = { runId: request.runId, nodeId: 'retrieve', attempt: 1, dependencies: { parse } };
  const timeout = await agent.runNode({ ...retrieveRequest, timeoutMs: 10 });
  assert.equal(timeout.error.code, 'AGENT_TIMEOUT');
  assert.equal(timeout.error.retryable, true);
  assert.ok(seen.length && seen.every(signal => signal.aborted));
  fail = false;
  const retrieve = await agent.runNode({ ...retrieveRequest, attempt: 2 });
  assert.equal(retrieve.attempt, 2);
  assert.ok(validateAgentResult(retrieve));
  assert.ok(NODE_DEPS.map.includes('preferences'));
  const map = await agent.runNode({ ...request, nodeId: 'map', attempt: 1, dependencies: { parse, retrieve } });
  assert.equal(map.error.code, 'INVALID_INPUT');
  const corruptParse = { ...parse, data: { roomId: 'looks-like-a-room' } };
  const corrupt = await agent.runNode({ ...retrieveRequest, dependencies: { parse: corruptParse } });
  assert.equal(corrupt.error.code, 'INVALID_INPUT');
  const controller = new AbortController();
  fail = true;
  const pending = agent.runNode({ ...retrieveRequest, attempt: 3 }, { signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.error.code, 'AGENT_CANCELLED');
  assert.equal(cancelled.error.retryable, false);
});

test('handoff fixtures expose six classes of evidence and round-trip through JSON for C', async () => {
  const handoff = await example('f-handoff-request');
  const { result } = await createAgent({ providers: {} }).runWorkflow(handoff);
  assert.ok(validateAgentResult(result));
  assert.equal(result.data.roomId, handoff.input.room.id);
  const codes = new Set(result.data.issues.map(item => item.code));
  for (const code of ['KNOWN_COST_OVER_BUDGET', 'JOURNEY_TIME_CONFLICT', 'OPENING_CONFLICT',
    'MUST_VISIT_MISSING', 'DIET_UNVERIFIED', 'ROUTE_UNVERIFIED', 'PRICE_MISSING']) assert.ok(codes.has(code), code);
  const restored = JSON.parse(JSON.stringify(result));
  assert.deepEqual(restored, result);
  assert.ok(restored.data.expenses.some(item => item.totalFen === null && item.source.confidence === 'missing'));
  assert.equal(validateAgentResult({ ...restored, data: { ...restored.data, expenses: [{}] } }), false);
  const unavailable = createAgent({ providers: createMockProviders({ scenario: 'search-unavailable' }) });
  const failed = await unavailable.runWorkflow(await example('f-provider-failure-request'));
  assert.ok(validateAgentResult(failed.result));
  assert.equal(failed.result.nodeId, 'retrieve');
  assert.equal(failed.result.error.code, 'AMAP_UNAVAILABLE');
  assert.equal(failed.result.error.retryable, true);
  assert.equal(failed.nodes.plan, undefined);
});
