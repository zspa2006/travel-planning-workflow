const key = 'travel-planning-workflow.demo.v1';

const plan = {
  title: '苏州两日 · 古城漫游',
  days: [
    { date: '2026-12-05', activities: [
      { start: '09:30', end: '11:30', place: '拙政园', transport: '步行 15 分钟' },
      { start: '14:00', end: '16:00', place: '苏州博物馆', transport: '步行 5 分钟' }
    ] },
    { date: '2026-12-06', activities: [
      { start: '10:00', end: '12:00', place: '平江路', transport: '地铁＋步行 30 分钟' },
      { start: '15:00', end: '16:30', place: '苏州站返程', transport: '地铁 25 分钟' }
    ] }
  ],
  expenses: [
    { category: '门票', label: '拙政园门票', scope: 'personal', totalFen: 24000 },
    { category: '住宿', label: '一晚住宿', scope: 'shared', totalFen: null },
    { category: '市内交通', label: '市内交通预估', scope: 'personal', totalFen: 9000 }
  ]
};

function initialState() {
  return { user: null, rooms: [{
    id: 'sample', code: 'SUZHOU', name: '周末苏州之旅', destination: '苏州',
    startDate: '2026-12-05', endDate: '2026-12-06',
    members: [{ id: 'sample-host', name: '小林' }], preferences: {},
    plans: [
      { ...plan, id: 'v2', version: 2, status: 'candidate' },
      { ...plan, id: 'v1', version: 1, status: 'official', expenses: plan.expenses.map(
        expense => expense.totalFen === null ? { ...expense, totalFen: 48000 } : expense
      ) }
    ]
  }] };
}

export function demoApi(storage) {
  const read = () => JSON.parse(storage.getItem(key)) ?? initialState();
  const write = state => storage.setItem(key, JSON.stringify(state));
  const identity = name => name.trim().normalize('NFKC').toLowerCase();
  function memberRoom(state, id) {
    const room = state.rooms.find(item => item.id === id);
    if (!state.user || !room?.members.some(member => member.id === state.user.id)) {
      throw new Error('房间不存在或你尚未加入。');
    }
    return room;
  }
  return {
    async session() { return read().user; },
    async login(name) {
      const state = read();
      state.user = { id: identity(name), name: name.trim() };
      write(state);
      return state.user;
    },
    async logout() {
      const state = read();
      state.user = null;
      write(state);
    },
    async rooms() {
      const { user, rooms } = read();
      return user ? rooms.filter(room => room.members.some(member => member.id === user.id)) : [];
    },
    async create(input) {
      const state = read();
      if (!state.user) throw new Error('请先进入工作台。');
      const id = crypto.randomUUID();
      const room = { ...input, id, code: id.replaceAll('-', '').toUpperCase(),
        members: [state.user], preferences: {}, plans: [] };
      state.rooms.push(room);
      write(state);
      return room;
    },
    async join(code) {
      const state = read();
      const room = state.rooms.find(item => item.code === code.trim().toUpperCase());
      if (!room || !state.user) throw new Error('找不到该邀请码对应的房间。');
      if (!room.members.some(member => member.id === state.user.id)) {
        room.members.push(state.user);
        write(state);
      }
      return room;
    },
    async room(id) { return memberRoom(read(), id); },
    async preference(id) {
      const state = read();
      const room = memberRoom(state, id);
      return Object.hasOwn(room.preferences, state.user.id) ? room.preferences[state.user.id] : null;
    },
    async savePreference(id, input) {
      const state = read();
      const room = memberRoom(state, id);
      Object.defineProperty(room.preferences, state.user.id, { value: input, enumerable: true,
        configurable: true, writable: true });
      write(state);
      return input;
    },
    async plans(id) { return memberRoom(read(), id).plans; }
  };
}
