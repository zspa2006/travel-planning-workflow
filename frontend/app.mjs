import { api, apiBase } from './api.mjs';

const $ = id => document.getElementById(id);
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const money = fen => currency.format(fen / 100);
let user;
let room;
let rooms = [];
let plans = [];
let selectedPlan;
let busy = false;

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}

async function run(action) {
  if (busy) return;
  busy = true;
  $('workspace').inert = $('entry').inert = $('logout').inert = true;
  notice('');
  try {
    await action();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    $('workspace').inert = $('entry').inert = $('logout').inert = false;
  }
}

function onSubmit(id, action) {
  $(id).addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    run(() => action(data, form));
  });
}

function drawRooms() {
  $('rooms').replaceChildren(...rooms.map(item => {
    const button = element('button', item.name, 'room-link');
    if (item.id === room?.id) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => run(() => openRoom(item.id)));
    return button;
  }));
}

const statusName = { candidate: '候选', official: '正式', archived: '历史' };

function drawPlans() {
  const active = plans.find(item => item.id === selectedPlan);
  $('versions').replaceChildren(...plans.map(item => {
    const button = element('button', (statusName[item.status] ?? '未知状态')+' · V'+item.version, 'quiet');
    button.setAttribute('aria-pressed', String(item.id === selectedPlan));
    button.addEventListener('click', () => {
      selectedPlan = item.id;
      drawPlans();
      [...$('versions').children].find(node => node.getAttribute('aria-pressed') === 'true')?.focus();
    });
    return button;
  }));
  const target = $('plan');
  target.replaceChildren();
  if (!active) {
    target.append(element('p', '暂无行程。编排服务生成方案后，可在这里刷新查看。', 'muted'));
    return;
  }
  target.append(element('h3', active.title));
  for (const day of active.days) {
    const card = element('section', undefined, 'day');
    card.append(element('h4', day.date));
    for (const item of day.activities) {
      const row = element('div', undefined, 'activity');
      row.append(element('span', item.start+'–'+item.end, 'time'), element('strong', item.place),
        element('span', item.transport, 'muted'));
      card.append(row);
    }
    target.append(card);
  }
  target.append(element('h3', '费用明细'));
  if (!active.expenses.length) {
    target.append(element('p', '暂无费用明细。', 'muted'));
    return;
  }
  let total = 0;
  let unknown = 0;
  const list = element('ul', undefined, 'expenses');
  for (const item of active.expenses) {
    const row = element('li');
    const scope = item.scope === 'shared' ? '共同' : '个人';
    const known = Number.isSafeInteger(item.totalFen) && item.totalFen >= 0;
    if (known) total += item.totalFen;
    else unknown++;
    row.append(element('span', item.label+' · '+item.category+' / '+scope),
      element('strong', known ? money(item.totalFen) : '待确认'));
    list.append(row);
  }
  target.append(list, element('p', '团队已知费用 '+money(total)
    +(unknown ? ' · '+unknown+' 项待确认' : ''), 'total'));
}

function setPlans(next, preferred) {
  plans = next;
  selectedPlan = [plans.find(item => item.id === preferred), plans.find(item => item.status === 'official'), plans[0]]
    .find(Boolean)?.id;
  drawPlans();
}

async function openRoom(id) {
  const [nextRoom, preference, nextPlans] = await Promise.all([
    api.room(id), api.preference(id), api.plans(id)
  ]);
  room = nextRoom;
  sessionStorage.setItem('travel.room.'+(apiBase ?? 'demo')+'.'+user.id, room.id);
  $('room').hidden = false;
  $('empty').hidden = true;
  $('room-name').textContent = room.name;
  $('room-meta').textContent = room.destination+' · '+room.startDate+' 至 '+room.endDate;
  $('invite').textContent = room.code ? '邀请码 '+room.code : '';
  $('invite').hidden = !room.code;
  $('members').replaceChildren(element('span', '成员 '+room.members.length, 'muted'),
    ...room.members.map(member => element('span', member.name, 'member')));
  const fields = $('preference').elements;
  fields.budget.value = preference ? preference.budgetFen / 100 : '';
  fields.pace.value = preference?.pace ?? 'balanced';
  fields.mustVisit.value = preference?.mustVisit.join('，') ?? '';
  fields.dietaryRestrictions.value = preference?.dietaryRestrictions.join('，') ?? '';
  drawRooms();
  setPlans(nextPlans);
}

async function showSession(nextUser) {
  user = nextUser;
  room = undefined;
  $('identity').textContent = user?.name ?? '';
  $('logout').hidden = !user;
  $('entry').hidden = Boolean(user);
  $('workspace').hidden = !user;
  $('room').hidden = true;
  $('empty').hidden = true;
  $('rooms').replaceChildren();
  $('preference').reset();
  if (!user) return;
  rooms = await api.rooms();
  drawRooms();
  const remembered = sessionStorage.getItem('travel.room.'+(apiBase ?? 'demo')+'.'+user.id);
  const initial = rooms.find(item => item.id === remembered) ?? rooms[0];
  if (initial) await openRoom(initial.id);
  else $('empty').hidden = false;
}

function nonEmpty(value, message) {
  if (!value.trim()) throw new Error(message);
  return value.trim();
}

function splitList(value) {
  return [...new Set(value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean))];
}

$('mode').textContent = apiBase ? '团队后端模式' : '本地演示 · 数据保存在此浏览器';
$('sample-help').hidden = Boolean(apiBase);
if (apiBase) {
  $('entry-title').textContent = '登录工作台';
  $('login-name').textContent = '账号';
  $('password-field').hidden = false;
  $('login').elements.password.disabled = false;
  $('login').elements.password.required = true;
}

onSubmit('login', async ({ name, password }, form) => {
  const next = await api.login(nonEmpty(name, '请输入账号或昵称。'), password);
  form.reset();
  await showSession(next);
});
$('logout').addEventListener('click', () => run(async () => {
  await api.logout();
  await showSession(null);
}));

async function acceptRoom(created, form, message) {
  form.reset();
  rooms = [...rooms.filter(item => item.id !== created.id), created];
  drawRooms();
  await openRoom(created.id);
  notice(message);
}

onSubmit('create', async ({ name, destination, startDate, endDate }, form) => {
  if (endDate < startDate) throw new Error('返程日期须等于或晚于出发日期。');
  const created = await api.create({
    name: nonEmpty(name, '请输入房间名称。'),
    destination: nonEmpty(destination, '请输入目的地。'), startDate, endDate
  });
  await acceptRoom(created, form, '房间已创建。');
});

onSubmit('join', async ({ code }, form) => {
  const joined = await api.join(nonEmpty(code, '请输入邀请码。'));
  await acceptRoom(joined, form, '已加入房间。');
});

onSubmit('preference', async ({ budget, pace, mustVisit, dietaryRestrictions }) => {
  await api.savePreference(room.id, { budgetFen: Math.round(Number(budget)*100), pace,
    mustVisit: splitList(mustVisit), dietaryRestrictions: splitList(dietaryRestrictions) });
  notice('偏好已保存。');
});

$('refresh-plans').addEventListener('click', () => run(async () => {
  setPlans(await api.plans(room.id), selectedPlan);
  notice('方案已刷新。');
}));

run(async () => {
  $('entry').hidden = false;
  await showSession(await api.session());
});
