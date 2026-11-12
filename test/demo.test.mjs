import test from 'node:test';
import assert from 'node:assert/strict';
import { demoApi } from '../frontend/demo.mjs';

test('rooms and preferences survive reload and remain scoped to each member', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const api = demoApi(storage);
  await api.login('甲');
  const created = await api.create({ name: '周末', destination: '苏州', startDate: '2026-12-05', endDate: '2026-12-06' });
  const preference = { budgetFen: 10000, pace: 'balanced', mustVisit: ['平江路'], dietaryRestrictions: [] };
  await api.savePreference(created.id, preference);
  const reloaded = demoApi(storage);
  assert.deepEqual(await reloaded.preference(created.id), preference);
  await reloaded.login('乙');
  await assert.rejects(reloaded.room(created.id), /尚未加入/);
  await reloaded.join(created.code);
  await reloaded.join(created.code);
  assert.equal((await reloaded.room(created.id)).members.length, 2);
  assert.equal(await reloaded.preference(created.id), null);
  await reloaded.join('suzhou');
  const plans = await reloaded.plans('sample');
  assert.equal(plans.find(plan => plan.status === 'candidate').expenses[1].totalFen, null);
  assert.equal(plans.find(plan => plan.status === 'official').expenses[1].totalFen, 48000);
});
