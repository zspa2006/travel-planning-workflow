import { AgentError, source } from './contract.mjs';

export const MOCK_REQUIREMENT_TEXT = '我们两人去苏州玩两天，团队预算1200元，想去拙政园和平江路，一位成员吃素。';
const places = [
  ['suzhou-station', '苏州站', 'station'],
  ['suzhou-garden', '拙政园', 'sight'],
  ['suzhou-pingjiang', '平江路', 'sight']
];
const mockSource = source('fixture', '苏州联调模拟数据', 'unverified');

export function createMockProviders({ scenario = 'default' } = {}) {
  if (!['default', 'search-unavailable', 'route-unavailable'].includes(scenario)) {
    throw new RangeError('未知模拟场景');
  }
  return {
    async parseRequirements(text) {
      if (text !== MOCK_REQUIREMENT_TEXT) return { unresolved: ['模拟模式请使用联调样例文本'] };
      return { destination: '苏州', durationDays: 2, travelerCount: 2, budgetFen: 120000,
        mustVisit: ['拙政园', '平江路'], dietaryRestrictions: ['素食'], unresolved: ['确认饮食限制所属成员'] };
    },
    async search(city, { kind, keyword }) {
      if (scenario === 'search-unavailable') throw new AgentError('AMAP_UNAVAILABLE', '模拟高德检索失败', true);
      if (city !== '苏州') return [];
      return places.filter(([, name, type]) => (!kind || kind === type) && (!keyword || name.includes(keyword)))
        .map(([id, name, type]) => ({
          id: 'mock-' + id, name, city, kind: type, location: null, address: null, citycode: null,
          source: mockSource, opening: [], openingSource: source('fixture', '无模拟营业时间', 'missing'), dietary: []
        }));
    },
    async route(from, to, mode) {
      if (scenario === 'route-unavailable') throw new AgentError('AMAP_UNAVAILABLE', '模拟路线查询失败', true);
      if (mode !== 'walking' || ![from, to].every(place => place.city === '苏州' &&
        places.some(([, name]) => name === place.name))) return null;
      return { durationMinutes: 15, distanceMeters: null, source: mockSource, segments: [], basis: '模拟步行时间' };
    }
  };
}
