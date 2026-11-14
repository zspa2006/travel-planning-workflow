export const NODE_DEPS = Object.freeze({
  parse: Object.freeze([]),
  retrieve: Object.freeze(['parse']),
  preferences: Object.freeze(['parse']),
  map: Object.freeze(['parse', 'retrieve', 'preferences']),
  plan: Object.freeze(['parse', 'preferences', 'map'])
});

export class AgentError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export function requireInput(condition, message) {
  if (!condition) throw new AgentError('INVALID_INPUT', message);
}

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
export const isMoney = value => Number.isSafeInteger(value) && value >= 0;
export const MODES = ['walking', 'transit', 'driving', 'taxi', 'subway', 'bus', 'ferry', 'rail', 'flight'];
export const KINDS = ['sight', 'food', 'hotel', 'station'];
export const PACE_LIMIT = { relaxed: 1, balanced: 2, packed: 3 };
export const modeNames = { walking: '步行', transit: '公共交通', driving: '自驾', taxi: '打车',
  subway: '地铁', bus: '公交', ferry: '轮渡', rail: '火车', flight: '飞机' };

export function source(provider, reference, confidence, queriedAt = null) {
  return { provider, reference, queriedAt, confidence };
}

export function issue(code, message, details = {}) {
  return { code, message, ...details };
}

export function timeValue(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function validLocation(location) {
  return Array.isArray(location) && location.length === 2 && location.every(Number.isFinite) &&
    Math.abs(location[0]) <= 180 && Math.abs(location[1]) <= 90;
}

export function dateValue(value) {
  requireInput(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '日期应为 YYYY-MM-DD');
  const date = new Date(value + 'T00:00:00Z');
  requireInput(Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value, '日期无效');
  return date.valueOf();
}

function strings(values, label) {
  requireInput(Array.isArray(values) && values.length <= 24 && values.every(isText), label + '应为最多 24 项的文本数组');
  return [...new Set(values.map(value => value.trim()))];
}

export function importedSource(value) {
  requireInput(isObject(value) && isText(value.provider) && isText(value.reference), '导入资料应提供来源名称和引用');
  requireInput(value.queriedAt == null || timestamp(value.queriedAt), '查询时间应为 ISO 日期时间');
  return source(value.provider.trim(), value.reference.trim(),
    value.confidence === 'estimated' ? 'estimated' : 'unverified', value.queriedAt ?? null);
}

export function quote(value) {
  requireInput(isObject(value) && isText(value.category) && isText(value.label), '报价缺少类别或名称');
  requireInput(['personal', 'shared'].includes(value.scope) && isText(value.unit), '报价缺少作用域或计价单位');
  requireInput(value.unitFen === null || isMoney(value.unitFen), '单价应为人民币整数分或 null');
  requireInput(Number.isSafeInteger(value.quantity) && value.quantity > 0, '计价数量应为正整数');
  requireInput(value.unitFen === null || isMoney(value.unitFen * value.quantity), '费用超出可计算范围');
  requireInput(value.conditions == null || isText(value.conditions), '报价条件应为文本');
  requireInput(value.travelers == null || (Number.isSafeInteger(value.travelers) && value.travelers > 0), '报价覆盖人数应为正整数');
  requireInput(value.place == null || isText(value.place), '报价适用地点应为文本');
  requireInput(value.serviceId == null || isText(value.serviceId), '报价服务标识应为文本');
  requireInput(value.chargeId == null || isText(value.chargeId), '费用明细标识应为文本');
  requireInput(value.taxIncluded == null || typeof value.taxIncluded === 'boolean', '税费标识应为布尔值');
  if (value.date != null) dateValue(value.date);
  requireInput(value.unitFenRange == null || (Array.isArray(value.unitFenRange) && value.unitFenRange.length === 2 &&
    value.unitFenRange.every(isMoney) && value.unitFenRange[0] <= value.unitFenRange[1] &&
    isMoney(value.unitFenRange[1] * value.quantity) && value.unitFen === null), '区间报价应为升序整数分，单价应为空');
  return {
    category: value.category.trim(), label: value.label.trim(), scope: value.scope, unit: value.unit.trim(),
    quantity: value.quantity, unitFen: value.unitFen, unitFenRange: value.unitFenRange ?? null,
    totalFen: value.unitFen === null ? null : value.unitFen * value.quantity,
    conditions: value.conditions ?? null, travelers: value.travelers ?? null,
    place: value.place?.trim() ?? null, date: value.date ?? null,
    serviceId: value.serviceId?.trim() ?? null, chargeId: value.chargeId?.trim() ?? null,
    taxIncluded: value.taxIncluded ?? null, source: importedSource(value.source)
  };
}

export function importedPlace(value, cities, index) {
  requireInput(isObject(value) && isText(value.name) && isText(value.city) && KINDS.includes(value.kind), '候选地点缺少名称、城市或类别');
  const city = value.city.trim();
  requireInput(cities.includes(city), '候选地点应属于行程城市');
  requireInput(value.location == null || validLocation(value.location), '高德坐标应为 [经度, 纬度]');
  requireInput(value.address == null || isText(value.address), '地点地址应为文本');
  requireInput(value.citycode == null || /^\d{3,4}$/.test(value.citycode), '高德 citycode 无效');
  requireInput(value.durationMinutes == null || (Number.isInteger(value.durationMinutes) &&
    value.durationMinutes > 0 && value.durationMinutes < 1440), '建议停留时长无效');
  requireInput(value.notes == null || isText(value.notes), '推荐理由或注意事项应为文本');
  const opening = value.opening ?? [];
  requireInput(Array.isArray(opening) && opening.length <= 30, '营业时段应为数组');
  const placeSource = importedSource(value.source);
  for (const period of opening) {
    requireInput(isObject(period) && (period.date == null || dateValue(period.date) !== null) &&
      timeValue(period.start) !== null && timeValue(period.end) !== null &&
      timeValue(period.end) > timeValue(period.start), '营业时段无效');
  }
  return {
    id: 'import-' + (index + 1), name: value.name.trim(), city, kind: value.kind,
    location: value.location ?? null, address: value.address ?? null, citycode: value.citycode ?? null,
    opening, openingSource: opening.length ? placeSource : source('none', '营业时间', 'missing'),
    dietary: strings(value.dietary ?? [], '饮食标签'), durationMinutes: value.durationMinutes ?? null,
    notes: value.notes ?? null, source: placeSource
  };
}

const DAY_MS = 86400000;
const positive = value => Number.isSafeInteger(value) && value > 0;

function dayNumber(date, start, count, label) {
  requireInput(start !== null, label + '使用日期时需提供出发日期');
  const day = (dateValue(date) - start) / DAY_MS + 1;
  requireInput(day >= 1 && day <= count, label + '超出旅行日期');
  return day;
}

function travelServices(input, start, days, origin) {
  const { stays = [], journeys = [], routePreferences = [] } = input;
  requireInput(Array.isArray(stays) && Array.isArray(journeys) && Array.isArray(routePreferences), '住宿和路段应为数组');
  const resolveDay = (value, field) => {
    const date = value[field ? field + 'Date' : 'date'];
    const specifiedDay = value[field ? field + 'Day' : 'day'];
    const day = date == null ? specifiedDay : dayNumber(date, start, days.length, field);
    requireInput(positive(day) && day <= days.length && (specifiedDay == null || day === specifiedDay), field + '日期或日序无效');
    return day;
  };
  const lodging = stays.map(value => {
    requireInput(isObject(value) && isText(value.id) && isText(value.city) && positive(value.rooms) &&
      (value.place == null || isText(value.place)), '住宿应提供 id、城市和房间数');
    const checkInDay = resolveDay(value, 'checkIn');
    const checkOutDay = resolveDay(value, 'checkOut');
    const nights = checkOutDay - checkInDay;
    requireInput(nights > 0 && Number.isSafeInteger(value.rooms * nights) &&
      days.slice(checkInDay - 1, checkOutDay - 1).every(day => day.city === value.city.trim()),
      '住宿晚数或入住城市与行程不符');
    return { id: value.id.trim(), city: value.city.trim(), place: value.place?.trim() ?? null, rooms: value.rooms, nights,
      checkInDay, checkOutDay, checkInDate: days[checkInDay - 1].date, checkOutDate: days[checkOutDay - 1].date };
  });
  const transfers = journeys.map(value => {
    requireInput(isObject(value) && ['outbound', 'return', 'intercity'].includes(value.kind) && MODES.includes(value.mode) &&
      ['id', 'fromCity', 'toCity', 'fromPlace', 'toPlace'].every(key => isText(value[key])), '往返或跨城交通字段无效');
    const departDay = resolveDay(value, 'depart');
    const arriveDay = resolveDay(value, 'arrive');
    const fromCity = value.fromCity.trim();
    const toCity = value.toCity.trim();
    const departTime = timeValue(value.departTime);
    const arriveTime = timeValue(value.arriveTime);
    const bufferMinutes = value.bufferMinutes ?? 0;
    requireInput(arriveDay >= departDay && (value.departTime == null || departTime !== null) &&
      (value.arriveTime == null || arriveTime !== null) &&
      (arriveDay > departDay || departTime === null || arriveTime === null || arriveTime > departTime) &&
      Number.isInteger(bufferMinutes) && bufferMinutes >= 0 && bufferMinutes < 1440, '交通时刻或缓冲无效');
    requireInput(
      value.kind === 'outbound' ? departDay === 1 && toCity === days[arriveDay - 1].city && (!origin || origin === fromCity)
        : value.kind === 'return' ? arriveDay === days.length && fromCity === days[departDay - 1].city && (!origin || origin === toCity)
        : fromCity !== toCity && days[departDay - 1].city === fromCity && days[arriveDay - 1].city === toCity,
      '交通起止城市或日序与行程不符');
    return { id: value.id.trim(), kind: value.kind, mode: value.mode, fromCity, toCity,
      fromPlace: value.fromPlace.trim(), toPlace: value.toPlace.trim(), departDay, arriveDay,
      departDate: days[departDay - 1].date, arriveDate: days[arriveDay - 1].date,
      departTime: value.departTime ?? null, arriveTime: value.arriveTime ?? null, bufferMinutes,
      durationMinutes: departTime === null || arriveTime === null ? null : (arriveDay - departDay) * 1440 + arriveTime - departTime,
      source: value.source == null ? source('user', '用户提供的交通约束', 'unverified') : importedSource(value.source) };
  });
  requireInput(new Set([...lodging, ...transfers].map(item => item.id)).size === lodging.length + transfers.length, '住宿及交通 id 重复');
  requireInput(transfers.filter(item => item.kind === 'outbound').length <= 1 &&
    transfers.filter(item => item.kind === 'return').length <= 1, '往返方向各允许一条行程记录');
  const departures = transfers.filter(item => item.kind !== 'outbound').map(item => item.departDay);
  const arrivals = transfers.filter(item => item.kind !== 'return').map(item => item.arriveDay);
  requireInput(new Set(departures).size === departures.length && new Set(arrivals).size === arrivals.length,
    '每个日序只支持一条离城和一条到城约束，请将连续换乘合为一条城际行程');
  const routes = routePreferences.map(value => {
    requireInput(isObject(value) && isText(value.from) && isText(value.to) && MODES.includes(value.mode) &&
      (value.id == null || isText(value.id)) &&
      (value.vehicles == null || positive(value.vehicles)) && (value.seatsPerVehicle == null || positive(value.seatsPerVehicle)), '路段偏好无效');
    return { day: resolveDay(value, ''), from: value.from.trim(), to: value.to.trim(), mode: value.mode,
      id: value.id?.trim() ?? null, vehicles: value.vehicles ?? null, seatsPerVehicle: value.seatsPerVehicle ?? null };
  });
  const serviceIds = [...lodging, ...transfers, ...routes].map(item => item.id).filter(Boolean);
  requireInput(new Set(serviceIds).size === serviceIds.length, '住宿、交通和指定路段的 id 不可重复');
  requireInput(new Set(routes.map(item => JSON.stringify([item.day, item.from, item.to]))).size === routes.length, '路段偏好重复');
  return { stays: lodging, journeys: transfers, routePreferences: routes };
}

export function parseTrip(input) {
  requireInput(isObject(input), '规划输入应为对象');
  const { room, members = [], quotes = [], places = [], interests = [], mustVisit = [] } = input;
  requireInput(isObject(room) && isText(room.id) && isText(room.destination), '房间缺少 id 或 destination');
  const start = room.startDate == null ? null : dateValue(room.startDate);
  const end = room.endDate == null ? null : dateValue(room.endDate);
  const datedCount = start !== null && end !== null ? (end - start) / DAY_MS + 1 : null;
  const count = input.durationDays ?? datedCount;
  requireInput(positive(count) && count <= 3660 && (datedCount === null || count === datedCount) &&
    (end === null || start !== null) && (start === null || start + (count - 1) * DAY_MS <= dateValue('9999-12-31')),
    '请提供有效旅行时长（单次任务最多 3660 天），且与出发及返程日期一致');
  const origin = input.origin ?? room.origin ?? null;
  requireInput(origin === null || isText(origin), '出发地应为文本');
  const stops = input.stops ?? [{ city: room.destination, days: count }];
  requireInput(Array.isArray(stops) && stops.length >= 1 && stops.length <= count &&
    stops.every(stop => isObject(stop) && isText(stop.city) && Number.isInteger(stop.days) && stop.days >= 1 && stop.days <= count) &&
    stops.reduce((sum, stop) => sum + stop.days, 0) === count, '城市天数之和应与行程日期一致');
  let offset = 0;
  const days = stops.flatMap(({ city, days }) => Array.from({ length: days }, () => {
    const day = ++offset;
    return { day, city: city.trim(), date: start === null ? null : new Date(start + (day - 1) * DAY_MS).toISOString().slice(0, 10) };
  }));
  const cities = [...new Set(days.map(day => day.city))];
  const mode = input.transportMode ?? 'transit';
  const intercityMode = input.intercityMode ?? mode;
  requireInput(MODES.includes(mode) && MODES.includes(intercityMode), '交通方式无效');
  requireInput(Array.isArray(members), '成员应为数组');
  const travelerCount = input.travelerCount ?? (members.length || null);
  requireInput(travelerCount === null || (positive(travelerCount) && travelerCount >= members.length), '团队人数应覆盖已知成员');
  const people = members.map(member => {
    requireInput(isObject(member) && isText(member.id), '成员缺少 id');
    const preference = member.preference ?? {};
    requireInput(isObject(preference), '成员偏好应为对象');
    const { budgetFen = null, pace = 'balanced', mustVisit = [], dietaryRestrictions = [], transportMode = null, interests = [] } = preference;
    requireInput((budgetFen === null || isMoney(budgetFen)) && Object.hasOwn(PACE_LIMIT, pace), '成员预算或节奏无效');
    requireInput(transportMode === null || MODES.includes(transportMode), '成员交通偏好无效');
    return { id: member.id.trim(), budgetFen, pace, transportMode, mustVisit: strings(mustVisit, '必去地点'),
      interests: strings(interests, '兴趣'), dietaryRestrictions: strings(dietaryRestrictions, '饮食限制') };
  });
  requireInput(new Set(people.map(member => member.id)).size === people.length, '成员 id 重复');
  requireInput(input.budgetFen == null || isMoney(input.budgetFen), '团队预算应为人民币整数分');
  requireInput(Array.isArray(places) && places.length <= 90, '导入候选应为最多 90 项的数组');
  requireInput(Array.isArray(quotes) && quotes.length <= 120, '导入报价应为最多 120 项的数组');
  const guides = input.guides ?? [];
  requireInput(Array.isArray(guides) && guides.length <= 24 && guides.every(guide => isObject(guide) &&
    (guide.text == null || (typeof guide.text === 'string' && guide.text.length <= 20000)) &&
    (guide.screenshotRef == null || isText(guide.screenshotRef)) && (guide.url == null || isText(guide.url)) &&
    (guide.city == null || cities.includes(guide.city))), '导入攻略字段无效');
  const lodgingRequirements = input.lodgingRequirements == null ? [] : strings(input.lodgingRequirements, '住宿要求');
  const avoidModes = input.avoidModes ?? [];
  requireInput(Array.isArray(avoidModes) && avoidModes.every(item => MODES.includes(item)), '禁用交通方式无效');
  const services = travelServices(input, start, days, origin?.trim() ?? null);
  requireInput(![mode, intercityMode, ...services.journeys.map(item => item.mode),
    ...services.routePreferences.map(item => item.mode)].some(item => avoidModes.includes(item)), '指定交通方式与禁用方式冲突');
  return {
    roomId: room.id.trim(), destination: room.destination.trim(), days, cities, members: people, mode, intercityMode,
    origin: origin?.trim() ?? null, travelerCount, lodgingRequirements, guides: guides.map(({ text, screenshotRef, url, city }) =>
      ({ text: text?.trim() ?? '', screenshotRef: screenshotRef ?? null, url: url ?? null, city: city ?? null })),
    ...services, avoidModes: [...new Set(avoidModes)],
    budgetFen: input.budgetFen ?? null, mustVisit: strings(mustVisit, '必去地点'),
    interests: strings(interests, '兴趣'), places: places.map((place, index) => importedPlace(place, cities, index)),
    quotes: quotes.map(quote)
  };
}
