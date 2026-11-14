import { AgentError, importedPlace, issue, modeNames, PACE_LIMIT, quote, source, timeValue } from './contract.mjs';

const CATEGORIES = ['餐饮', '门票', '市内交通', '住宿', '往返交通'];
const missing = reference => source('none', reference, 'missing');
const normalize = text => text.normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();
const placeKey = (city, name) => JSON.stringify([city, normalize(name)]);
const hhmm = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');

export async function importGuides(trip, providers) {
  const issues = [];
  const places = [...trip.places];
  const results = await queryAll(trip.guides, async guide => {
    let recognized;
    if (guide.screenshotRef && providers.recognizeGuide) {
      try { recognized = await providers.recognizeGuide(guide.screenshotRef); } catch { recognized = null; }
    }
    const recognizedText = typeof recognized === 'string' ? recognized.trim() : '';
    const text = [guide.text, recognizedText].filter(Boolean).join('\n');
    const extracted = text && providers.extractGuide ? await providers.extractGuide({ text, cities: guide.city ? [guide.city] : trip.cities }) : [];
    return { text, recognizedText, extracted, queriedAt: new Date().toISOString() };
  });
  for (const [index, guide] of trip.guides.entries()) {
    const result = results[index];
    const guideIndex = index + 1;
    if (!guide.url) issues.push(issue('GUIDE_SOURCE_MISSING', '攻略缺少原帖链接', { guideIndex }));
    if (result.status === 'rejected') {
      issues.push(issue('GUIDE_UNREADABLE', '攻略解析失败，请检查正文或补充结构化地点', { guideIndex }));
      continue;
    }
    const { text, recognizedText, extracted, queriedAt } = result.value;
    if (guide.screenshotRef && !recognizedText) {
      issues.push(issue('GUIDE_SCREENSHOT_UNREADABLE', '截图未取得可用文字，请补充正文或识别结果', { guideIndex }));
    }
    let count = 0;
    for (const item of Array.isArray(extracted) ? extracted.slice(0, 12) : []) {
      if (typeof item?.name !== 'string' || !text.includes(item.name) || (guide.city && item.city !== guide.city)) continue;
      try {
        const candidate = importedPlace({ name: item.name, city: item.city, kind: item.kind,
          durationMinutes: item.durationMinutes, notes: item.notes, source: {
            provider: 'guide', reference: guide.url ?? '导入攻略 ' + guideIndex, confidence: 'unverified', queriedAt
          } }, trip.cities, places.length);
        if (!places.some(place => placeKey(place.city, place.name) === placeKey(candidate.city, candidate.name))) places.push(candidate);
        count++;
      } catch {
        issues.push(issue('GUIDE_ITEM_UNCONFIRMED', '攻略地点的类型或城市需要确认', { guideIndex }));
      }
    }
    if (!count) issues.push(issue('GUIDE_NO_PLACES', '攻略未提取出可核对的地点', { guideIndex }));
  }
  return { ...trip, places, issues };
}

function requiredPlaces(trip) {
  return [...new Map([...trip.mustVisit, ...trip.members.flatMap(member => member.mustVisit)]
    .map(name => [normalize(name), name])).values()];
}

export function coordinate(trip) {
  const preferences = trip.members;
  const pace = preferences.map(member => member.pace).sort((a, b) => PACE_LIMIT[a] - PACE_LIMIT[b])[0] ?? 'balanced';
  const issues = [];
  if (new Set(preferences.map(member => member.pace)).size > 1) {
    issues.push(issue('PACE_CONFLICT', '成员节奏不同，建议先按最宽松的节奏编排', { members: preferences.map(member => member.id) }));
  }
  const transportPrefs = preferences.filter(member => member.transportMode);
  if (new Set(transportPrefs.map(member => member.transportMode)).size > 1) {
    issues.push(issue('TRANSPORT_PREFERENCE_CONFLICT', '成员交通偏好不同，请确认默认方式或指定混合路段',
      { preferences: transportPrefs.map(({ id, transportMode }) => ({ id, transportMode })), plannedMode: trip.mode }));
  }
  return {
    pace, mustVisit: requiredPlaces(trip),
    dietaryRestrictions: [...new Set(preferences.flatMap(member => member.dietaryRestrictions))],
    teamBudgetFen: trip.budgetFen,
    memberBudgets: preferences.map(({ id, budgetFen }) => ({ id, budgetFen })),
    constraintsByMember: preferences.map(({ id, mustVisit, dietaryRestrictions }) => ({ id, mustVisit, dietaryRestrictions })),
    issues
  };
}

async function queryAll(tasks, operation) {
  const results = [];
  for (let start = 0; start < tasks.length; start += 3) {
    results.push(...await Promise.allSettled(tasks.slice(start, start + 3).map(async task => operation(task))));
  }
  return results;
}

export async function retrieve(trip, providers) {
  const issues = [...trip.issues];
  const places = [...trip.places];
  const services = [...trip.stays.map(stay => ({ ...stay, category: '住宿' })),
    ...trip.journeys.map(journey => ({ ...journey, category: journey.kind === 'intercity' ? '城际交通' : '往返交通' }))];
  const quotes = [...trip.quotes];
  const pending = services.filter(service => !quotes.some(entry => entry.serviceId === service.id &&
    entry.category === service.category && (entry.date === null || entry.date === (service.checkInDate ?? service.departDate)) &&
    (entry.totalFen !== null || entry.unitFenRange !== null)));
  const results = await queryAll(pending.slice(0, 30), async service => {
    const date = service.checkInDate ?? service.departDate;
    if (!date || !trip.travelerCount) return null;
    const value = await providers.quote?.({ ...service, travelerCount: trip.travelerCount });
    if (!value || (value.date != null && value.date !== date)) return null;
    const entry = quote({ ...value, category: service.category, serviceId: service.id, date });
    if ((entry.totalFen === null && entry.unitFenRange === null) || entry.travelers !== trip.travelerCount ||
      entry.taxIncluded === null || (entry.unit === 'person' && entry.quantity !== trip.travelerCount)) return null;
    if (service.category === '住宿' && (entry.unit !== 'roomNight' || entry.quantity !== service.rooms * service.nights)) return null;
    return entry;
  });
  for (const [index, service] of pending.entries()) {
    const result = results[index];
    if (result?.status === 'fulfilled' && result.value) {
      const replaced = quotes.findIndex(entry => entry.serviceId === service.id && entry.totalFen === null && entry.unitFenRange === null);
      if (replaced >= 0) quotes[replaced] = result.value;
      else quotes.push(result.value);
    } else {
      issues.push(issue('AUTO_QUOTE_UNAVAILABLE', '暂无适用自动报价，可手动补充', { serviceId: service.id }));
    }
  }
  if (!providers.search) {
    if (places.length === 0 && !trip.guides.length) throw new AgentError('MAP_NOT_CONFIGURED', '请配置高德服务或导入地点资料');
    return { places, issues, quotes };
  }
  const searches = [];
  for (const city of trip.cities) {
    for (const keyword of requiredPlaces(trip)) {
      if (!places.some(place => place.city === city && normalize(place.name) === normalize(keyword) && place.location)) {
        searches.push({ city, keyword });
      }
    }
    for (const place of places.filter(item => item.city === city && !item.location && item.source.provider === 'guide')) {
      searches.push({ city, keyword: place.name, kind: place.kind });
    }
    for (const kind of ['sight', 'food', 'hotel', 'station']) {
      if (!places.some(place => place.city === city && place.kind === kind)) searches.push({ city, kind });
    }
    const targeted = [...trip.stays.filter(stay => stay.city === city && stay.place).map(stay => ({ keyword: stay.place, kind: 'hotel' })),
      ...trip.journeys.flatMap(journey => [
        ...(journey.fromCity === city ? [{ keyword: journey.fromPlace, kind: 'station' }] : []),
        ...(journey.toCity === city ? [{ keyword: journey.toPlace, kind: 'station' }] : [])
      ])];
    for (const task of targeted) searches.push({ city, ...task });
    for (const keyword of new Set([...trip.interests, ...trip.members.flatMap(member => member.interests)])) {
      searches.push({ city, kind: 'sight', keyword });
    }
  }
  const unique = [...new Map(searches.map(search => [JSON.stringify(search), search])).values()];
  const budget = 60;
  if (unique.length > budget) issues.push(issue('SEARCH_LIMIT', '部分候选查询超出本次调用上限，请导入地点或缩小查询范围'));
  const searched = await queryAll(unique.slice(0, budget), task => providers.search(task.city, task));
  const rejected = searched.filter(result => result.status === 'rejected');
  if (!places.length && !trip.guides.length && searched.length && rejected.length === searched.length) throw rejected[0].reason;
  const ids = new Set();
  for (const [index, result] of searched.entries()) {
    if (result.status === 'rejected') {
      issues.push(issue('SEARCH_UNAVAILABLE', '部分候选未能查询', {
        ...unique[index], providerCode: result.reason?.code ?? 'UNKNOWN'
      }));
      continue;
    }
    for (const place of result.value) {
      if (ids.has(place.id)) continue;
      ids.add(place.id);
      const matching = places.map((item, i) => [item, i]).filter(([item]) =>
        placeKey(item.city, item.name) === placeKey(place.city, place.name));
      const imported = matching.length === 1 ? matching[0] : null;
      if (imported && imported[0].id.startsWith('import-') && !imported[0].location &&
        result.value.filter(item => item.name === place.name).length === 1 && place.location) {
        places[imported[1]] = { ...imported[0], location: place.location, address: place.address,
          citycode: place.citycode, locationSource: place.source };
      } else if (imported?.[0].id.startsWith('import-') && imported[0].address && imported[0].address === place.address) {
        continue;
      } else {
        places.push(place);
      }
    }
  }
  if (!places.length && !trip.guides.length) throw new AgentError('NO_CANDIDATES', '没有找到可用于规划的地点');
  return { places, issues, quotes };
}

function daySelections(trip, places, prefs, issues) {
  const days = trip.days.map(day => ({
    ...day, visits: [], inTransit: trip.journeys.find(journey =>
      (journey.departDay < day.day && journey.arriveDay > day.day) ||
      (journey.kind === 'outbound' && day.day < journey.arriveDay) ||
      (journey.kind === 'return' && day.day > journey.departDay))
  }));
  const used = new Set();
  const ambiguous = new Set();
  function station(city, name, journey) {
    const matching = places.filter(place => place.city === city && normalize(place.name) === normalize(name));
    if (matching.length === 1) return matching[0];
    issues.push(issue(matching.length ? 'AMBIGUOUS_PLACE' : 'STATION_LOCATION_UNVERIFIED', '交通站点坐标待确认', {
      serviceId: journey.id, city, place: name
    }));
    return { id: journey.id + ':' + city + ':' + name, name, city, kind: 'station', location: null, address: null,
      citycode: null, opening: [], openingSource: missing('营业时间'), dietary: [], source: journey.source };
  }
  for (const name of prefs.mustVisit) {
    const matching = places.filter(place => normalize(place.name) === normalize(name));
    if (matching.length !== 1) {
      matching.forEach(place => ambiguous.add(place.id));
      issues.push(issue(matching.length ? 'AMBIGUOUS_PLACE' : 'MUST_VISIT_MISSING', '必去地点需要确认', {
        place: name, candidates: matching.map(({ id, city, address }) => ({ id, city, address }))
      }));
      continue;
    }
    const place = matching[0];
    const options = days.filter(day => day.city === place.city && !day.inTransit);
    const day = options.find(day => day.visits.length < PACE_LIMIT[prefs.pace] &&
      place.opening.some(period => period.date == null || period.date === day.date))
      ?? options.find(day => day.visits.length < PACE_LIMIT[prefs.pace]);
    if (!day) {
      issues.push(issue('MUST_VISIT_UNSCHEDULED', '该城市的必去地点超过当前节奏可安排的数量', { place: name }));
      continue;
    }
    day.visits.push(place);
    used.add(placeKey(place.city, place.name));
  }
  for (const [index, day] of days.entries()) {
    if (day.inTransit) {
      day.stops = [];
      issues.push(issue('DAY_IN_TRANSIT', '当天处于跨天交通途中', { day: day.day, date: day.date, serviceId: day.inTransit.id }));
      continue;
    }
    const available = places.filter(place => place.city === day.city && !ambiguous.has(place.id));
    const nextDay = days[index + 1];
    const previousDay = days[index - 1];
    const choose = kind => available.find(place => place.kind === kind);
    if (!day.visits.some(place => place.kind === 'sight')) {
      const sight = available.find(place => place.kind === 'sight' && !used.has(placeKey(place.city, place.name)));
      if (sight && day.visits.length < PACE_LIMIT[prefs.pace]) {
        day.visits.push(sight);
        used.add(placeKey(sight.city, sight.name));
      }
    }
    const food = available.filter(place => place.kind === 'food');
    const compatible = place => prefs.dietaryRestrictions.every(tag => place.dietary.includes(tag));
    const meal = day.visits.some(place => place.kind === 'food') ? null : food.find(compatible) ?? food[0];
    const inbound = trip.journeys.find(journey => journey.arriveDay === day.day && journey.kind !== 'return');
    const outbound = trip.journeys.find(journey => journey.departDay === day.day && journey.kind !== 'outbound');
    const stay = trip.stays.find(stay => stay.checkInDay <= day.day && stay.checkOutDay > day.day);
    const hotelMatches = stay?.place ? available.filter(place => place.kind === 'hotel' && normalize(place.name) === normalize(stay.place)) : [];
    const hotel = stay?.place ? (hotelMatches.length === 1 ? hotelMatches[0] : null) : null;
    const arrival = inbound ? station(day.city, inbound.toPlace, inbound) :
      !previousDay || previousDay.city !== day.city ? choose('station') : null;
    const departure = outbound ? station(day.city, outbound.fromPlace, outbound) : !nextDay ? choose('station') : null;
    if ((!previousDay || previousDay.city !== day.city) && !arrival) {
      issues.push(issue('ARRIVAL_UNCONFIRMED', '缺少入城站点，需补充到达安排', { date: day.date, city: day.city }));
    }
    if (!nextDay && !departure) {
      issues.push(issue('DEPARTURE_UNCONFIRMED', '缺少离城站点，需补充返程安排', { date: day.date, city: day.city }));
    }
    if (!day.visits.length) issues.push(issue('NO_DAY_VISITS', '当天暂无游览候选', { date: day.date }));
    if (stay && !hotel) issues.push(issue('HOTEL_UNCONFIRMED', '住宿地点待确认', { day: day.day, date: day.date, serviceId: stay.id }));
    if (!meal && !day.visits.some(place => place.kind === 'food')) {
      issues.push(issue('MEAL_UNCONFIRMED', '缺少餐饮地点', { date: day.date }));
    }
    if (meal && day.visits.length) day.visits.splice(1, 0, meal);
    else if (meal) day.visits.push(meal);
    day.stops = [
      ...(arrival ? [{ place: arrival, label: '抵达 ' + arrival.name, role: 'arrival', journey: inbound ?? null }] : []),
      ...day.visits.map(place => ({ place, label: place.name, role: place.kind })),
      ...(hotel && !day.visits.includes(hotel) ? [{ place: hotel, label: '住宿 ' + hotel.name, role: 'hotel' }] : []),
      ...(departure ? [{ place: departure, label: '离开 ' + departure.name, role: 'departure', journey: outbound ?? null }] : [])
    ];
  }
  return days;
}

export async function mapTrip(trip, retrieved, prefs, providers) {
  const issues = [...retrieved.issues];
  const days = daySelections(trip, retrieved.places, prefs, issues);
  const legs = [];
  let previous;
  const usedPreferences = new Set();
  for (const day of days) {
    for (const [index, stop] of day.stops.entries()) {
      if (previous && !stop.journey?.arriveDay && previous.place.id !== stop.place.id) {
        const sameDay = previous.day === day.day;
        const intercity = previous.place.city !== stop.place.city;
        const preference = trip.routePreferences.find(value => value.day === day.day &&
          normalize(value.from) === normalize(previous.place.name) && normalize(value.to) === normalize(stop.place.name));
        if (preference) usedPreferences.add(preference);
        const mode = preference?.mode ?? (intercity ? trip.intercityMode : trip.mode);
        const vehicles = preference?.vehicles ?? null;
        const seatsPerVehicle = preference?.seatsPerVehicle ?? null;
        if (['driving', 'taxi'].includes(mode) && (vehicles === null || seatsPerVehicle === null ||
          trip.travelerCount === null || vehicles * seatsPerVehicle < trip.travelerCount)) {
          issues.push(issue('VEHICLE_CAPACITY_UNCONFIRMED', '车辆数或座位不能确认覆盖团队人数', {
            day: day.day, date: day.date, from: previous.place.name, to: stop.place.name, vehicles, seatsPerVehicle
          }));
        }
        legs.push({ id: preference?.id ?? null, day: day.day, date: day.date, fromDay: previous.day, fromDate: previous.date, index, sameDay, intercity,
          from: previous.place, to: stop.place, mode, vehicles, seatsPerVehicle });
      }
      previous = { place: stop.place, day: day.day, date: day.date };
    }
  }
  for (const value of trip.routePreferences) {
    if (!usedPreferences.has(value)) issues.push(issue('ROUTE_PREFERENCE_UNAPPLIED', '指定路段未编入当前草案', value));
  }
  if (legs.length > 60 && providers.route) issues.push(issue('ROUTE_LIMIT', '超出本次地图调用上限的路段待确认'));
  const results = await queryAll(legs.slice(0, 60), leg => providers.route?.(leg.from, leg.to, leg.mode, leg.date, trip.avoidModes));
  const routes = legs.map((leg, index) => {
    const result = results[index];
    const route = result?.status === 'fulfilled' && !result.value?.segments?.some(segment => trip.avoidModes.includes(segment.mode))
      ? result.value : null;
    const { from, to, ...keys } = leg;
    if (!route) issues.push(issue('ROUTE_UNVERIFIED', '路线耗时待确认', {
      day: leg.day, date: leg.date, from: from.name, to: to.name, mode: leg.mode,
      providerCode: result?.status === 'rejected' ? result.reason?.code ?? 'UNKNOWN' : null
    }));
    return { ...keys, from: { id: from.id, name: from.name, city: from.city }, to: { id: to.id, name: to.name, city: to.city },
      durationMinutes: route?.durationMinutes ?? null, distanceMeters: route?.distanceMeters ?? null,
      source: route?.source ?? missing('路线数据'), basis: route?.basis ?? null, segments: route?.segments ?? [] };
  });
  return { days: days.map(({ day, city, date, stops }) => ({ day, city, date, stops })), routes, issues, quotes: retrieved.quotes };
}

function expenseList(trip, quotes, dayPlans, issues) {
  const travelers = trip.travelerCount;
  const expenses = [];
  const charges = new Set();
  const primaryServices = new Set();
  const services = [
    ...trip.stays.map(stay => ({ ...stay, category: '住宿', date: stay.checkInDate, quantity: stay.rooms * stay.nights, unit: 'roomNight' })),
    ...trip.journeys.map(journey => ({ ...journey, category: journey.kind === 'intercity' ? '城际交通' : '往返交通',
      date: journey.departDate, quantity: 1, unit: 'team' })),
    ...dayPlans.flatMap(day => day.activities.flatMap(({ inboundRoute: route }) => route?.id ?
      [{ id: route.id, date: day.date, category: route.intercity ? '城际交通' : '市内交通',
        unit: route.vehicles ? 'vehicle' : 'team', quantity: route.vehicles ?? 1 }] : []))
  ];
  for (const quote of [...quotes].sort((a, b) =>
    Number(b.totalFen !== null || b.unitFenRange !== null) - Number(a.totalFen !== null || a.unitFenRange !== null))) {
    const service = services.find(item => item.id === quote.serviceId);
    const matches = dayPlans.some(day => (!quote.date || day.date === quote.date) &&
      (!quote.place || day.activities.some(activity => normalize(activity.placeName) === normalize(quote.place))));
    if ((quote.serviceId && (!service || (quote.date && quote.date !== service.date) ||
      (quote.travelers && trip.travelerCount && quote.travelers !== trip.travelerCount && quote.scope === 'shared' && service.category === '住宿') ||
      (quote.place && service.place && normalize(quote.place) !== normalize(service.place)) ||
      (quote.unit === 'vehicle' && service.unit === 'vehicle' && quote.quantity !== service.quantity) ||
      (service.category === '住宿' && (quote.unit !== service.unit || quote.quantity !== service.quantity)))) || (!service && !matches)) {
      issues.push(issue('QUOTE_NOT_APPLIED', '报价的适用日期或地点未编入行程', { label: quote.label }));
      continue;
    }
    const primary = quote.serviceId && quote.category === service?.category ? quote.serviceId : null;
    if ((quote.chargeId && charges.has(quote.chargeId)) || (primary && primaryServices.has(primary))) {
      issues.push(issue('DUPLICATE_CHARGE', '相同费用标识仅计一次', { label: quote.label, chargeId: quote.chargeId, serviceId: primary }));
      continue;
    }
    if (quote.chargeId) charges.add(quote.chargeId);
    if (primary) primaryServices.add(primary);
    expenses.push({ ...quote, id: 'expense-' + (expenses.length + 1) });
  }
  const missingExpense = (category, service) => {
    expenses.push({ id: 'expense-' + (expenses.length + 1), category, label: (service?.place ?? service?.id ?? category) + '待确认',
      scope: ['住宿', '市内交通'].includes(category) ? 'shared' : 'personal',
      unit: service?.unit ?? 'team', unitFen: null, unitFenRange: null, quantity: service?.quantity ?? 1, travelers, totalFen: null,
      conditions: null, place: service?.place ?? null, date: service?.date ?? null,
      serviceId: service?.id ?? null, chargeId: null, taxIncluded: null, source: missing(category + '报价') });
  };
  for (const service of services) {
    if (!expenses.some(expense => expense.serviceId === service.id && expense.category === service.category)) {
      missingExpense(service.category, service);
    }
  }
  const hasUnspecifiedIntercity = trip.days.some((day, i) => i > 0 && day.city !== trip.days[i - 1].city &&
    !trip.journeys.some(journey => journey.kind === 'intercity' && journey.arriveDay === day.day));
  for (const category of hasUnspecifiedIntercity ? [...CATEGORIES, '城际交通'] : CATEGORIES) {
    if (category === '住宿' && (trip.days.length === 1 || trip.stays.length)) continue;
    if (category === '往返交通' && trip.journeys.some(journey => journey.kind === 'outbound' || journey.kind === 'return')) {
      for (const direction of ['outbound', 'return']) {
        if (!trip.journeys.some(journey => journey.kind === direction)) missingExpense(category, { id: direction === 'outbound' ? '去程' : '返程' });
      }
      continue;
    }
    if (!expenses.some(expense => expense.category === category && (!expense.serviceId || category !== '城际交通'))) missingExpense(category);
  }
  for (const expense of expenses) {
    if (expense.totalFen === null) issues.push(issue('PRICE_MISSING', '费用待确认', { expenseId: expense.id, category: expense.category }));
  }
  const summary = new Map();
  let knownTotalFen = 0;
  let lowerFen = 0;
  let upperFen = 0;
  let unpricedCount = 0;
  for (const expense of expenses) {
    const bucket = summary.get(expense.category) ?? { category: expense.category, knownTotalFen: 0, missingCount: 0 };
    bucket.knownTotalFen += expense.totalFen ?? 0;
    if (expense.totalFen === null) bucket.missingCount++;
    summary.set(expense.category, bucket);
    knownTotalFen += expense.totalFen ?? 0;
    lowerFen += expense.totalFen ?? (expense.unitFenRange?.[0] ?? 0) * expense.quantity;
    upperFen += expense.totalFen ?? (expense.unitFenRange?.[1] ?? 0) * expense.quantity;
    if (expense.totalFen === null && !expense.unitFenRange) unpricedCount++;
  }
  if (!Number.isSafeInteger(upperFen)) throw new AgentError('INVALID_INPUT', '费用合计超出可计算范围');
  return { expenses, knownTotalFen, lowerFen, upperFen, unpricedCount, categories: [...summary.values()] };
}

export async function planTrip(trip, prefs, map, providers) {
  const issues = [...prefs.issues, ...map.issues];
  if (!trip.days[0].date) issues.push(issue('TRAVEL_DATES_MISSING', '时长草案需补齐日期后核验路线和报价'));
  for (const kind of ['outbound', 'return']) {
    if (!trip.journeys.some(journey => journey.kind === kind && journey.durationMinutes !== null)) {
      issues.push(issue('JOURNEY_TIME_UNCONFIRMED', '首末日往返衔接时刻待确认', { kind }));
    }
  }
  let advice;
  const modelInputs = map.days.flatMap(day => day.stops.filter(stop => stop.role === 'sight')
    .map(({ place }) => ({ id: place.id, name: place.name, city: place.city })));
  if (providers.suggest && modelInputs.length) {
    try {
      advice = await providers.suggest(modelInputs);
    } catch (error) {
      issues.push(issue('MODEL_FALLBACK', '模型建议不可用，采用默认停留时长', { providerCode: error.code ?? 'UNKNOWN' }));
    }
  }
  const routes = new Map(map.routes.map(route => [route.day + '/' + route.index, route]));
  const scheduledStops = new Set();
  const dayPlans = map.days.map(day => {
    let cursor = 9 * 60;
    const activities = [];
    const departure = day.stops.find(stop => stop.role === 'departure' && stop.journey?.departTime)?.journey;
    for (const [index, { place, label, role, journey }] of day.stops.entries()) {
      const candidateRoute = routes.get(day.day + '/' + index);
      const route = candidateRoute && scheduledStops.has(candidateRoute.fromDay + '/' + candidateRoute.from.id)
        ? candidateRoute : null;
      if (candidateRoute && !route) {
        issues.push(issue('ROUTE_START_UNCONFIRMED', '原路线起点未编入行程，需要重新查询', { day: day.day, date: day.date, place: place.name }));
      }
      const proposed = advice?.minutes[place.id];
      const importedDuration = ['sight', 'food'].includes(role) ? place.durationMinutes : null;
      const modelDuration = !importedDuration && role === 'sight' && Number.isInteger(proposed) && proposed >= 30 && proposed <= 180;
      let minutes = importedDuration ?? (modelDuration ? proposed : { sight: 75, food: 60, hotel: 30, station: 30,
        arrival: 30, departure: 30 }[role]);
      const reserve = route ? route.durationMinutes ?? 30 : 0;
      const earliest = role === 'food' ? 11 * 60 + 30 : role === 'hotel' ? 15 * 60 : 0;
      let start = Math.max(earliest, cursor + reserve);
      if (role === 'arrival' && journey?.arriveTime) {
        start = timeValue(journey.arriveTime);
        minutes = Math.max(journey.bufferMinutes, 1);
      }
      if (role === 'departure' && journey?.departTime) {
        const deadline = timeValue(journey.departTime);
        const checkIn = deadline - Math.max(journey.bufferMinutes, 1);
        const earliestReach = (activities.length ? cursor : 0) + reserve;
        if (earliestReach > checkIn) {
          issues.push(issue('JOURNEY_TIME_CONFLICT', '活动或接驳与出发时刻冲突', {
            day: day.day, date: day.date, serviceId: journey.id, departTime: journey.departTime
          }));
          continue;
        }
        start = checkIn;
        minutes = deadline - checkIn;
      }
      if (role === 'sight' || role === 'food') {
        const openings = place.opening.filter(period => period.date == null || period.date === day.date);
        const next = openings.map(period => Math.max(start, timeValue(period.start)))
          .filter((time, i) => time + minutes <= timeValue(openings[i].end)).sort((a, b) => a - b)[0];
        if (next !== undefined) start = next;
        else issues.push(issue(place.opening.length ? 'OPENING_CONFLICT' : 'OPENING_UNVERIFIED',
          place.opening.length ? '计划时段与已导入营业时间不匹配' : '营业时间待确认', { day: day.day, date: day.date, place: place.name }));
      }
      if (role !== 'departure' && departure && start + minutes > timeValue(departure.departTime) - departure.bufferMinutes) {
        issues.push(issue('JOURNEY_TIME_CONFLICT', '活动无法安排在离城前', {
          day: day.day, date: day.date, place: place.name, serviceId: departure.id
        }));
        continue;
      }
      if (start + minutes >= 24 * 60) {
        issues.push(issue('DAY_OVERFLOW', '当日活动超出当天可用时间，后续活动需重新安排', { date: day.date, place: place.name }));
        break;
      }
      if (role === 'food' && !prefs.dietaryRestrictions.every(tag => place.dietary.includes(tag))) {
        issues.push(issue('DIET_UNVERIFIED', '餐饮候选的饮食限制需要核实', {
          date: day.date, place: place.name, restrictions: prefs.dietaryRestrictions
        }));
      }
      if ((role === 'arrival' || role === 'departure') && !journey?.[role === 'arrival' ? 'arriveTime' : 'departTime']) {
        issues.push(issue('TIMETABLE_UNCONFIRMED', '站点为衔接建议，车次与到发时间待确认', { date: day.date, place: place.name }));
      }
      cursor = start + minutes;
      scheduledStops.add(day.day + '/' + place.id);
      activities.push({
        id: (day.date ?? 'day-' + day.day) + '-' + (index + 1), start: hhmm(start), end: hhmm(cursor), durationMinutes: minutes,
        place: label, placeName: place.name, placeId: place.id, role, location: place.location, address: place.address, notes: place.notes ?? null,
        source: place.source, locationSource: place.locationSource ?? place.source,
        timeSource: journey?.[role === 'arrival' ? 'arriveTime' : 'departTime'] ? journey.source : source('planner', '编排时段', 'estimated'),
        durationSource: importedDuration ? place.source : modelDuration ? advice.source : source('planner', '停留或接驳预留时长', 'estimated'),
        opening: place.opening, openingSource: place.openingSource, dietary: place.dietary,
        transport: route ? modeNames[route.mode] + (route.durationMinutes === null ? '待确认（预留30分钟）' : '约 ' + route.durationMinutes + ' 分钟') : '',
        inboundRoute: route ? { ...route, reservedMinutes: reserve } : null, journeyId: journey?.id ?? null
      });
    }
    return { day: day.day, date: day.date, city: day.city, activities,
      journeyIds: trip.journeys.filter(journey => journey.departDay <= day.day && journey.arriveDay >= day.day).map(journey => journey.id) };
  });
  const scheduled = new Set(dayPlans.flatMap(day => day.activities.map(activity => normalize(activity.placeName))));
  for (const name of prefs.mustVisit) {
    if (!scheduled.has(normalize(name)) && !issues.some(item => item.place === name &&
      (item.code.startsWith('MUST_VISIT') || item.code === 'AMBIGUOUS_PLACE'))) {
      issues.push(issue('MUST_VISIT_UNSCHEDULED', '必去地点未编入行程', { place: name }));
    }
  }
  const { expenses, knownTotalFen, lowerFen, upperFen, unpricedCount, categories } =
    expenseList(trip, map.quotes, dayPlans, issues);
  if (prefs.teamBudgetFen !== null && knownTotalFen > prefs.teamBudgetFen) {
    issues.push(issue('KNOWN_COST_OVER_BUDGET', '已列金额超过团队预算', { knownTotalFen, budgetFen: prefs.teamBudgetFen }));
  }
  if (prefs.teamBudgetFen !== null && upperFen > prefs.teamBudgetFen && upperFen > knownTotalFen) {
    issues.push(issue(lowerFen > prefs.teamBudgetFen ? 'PRICE_RANGE_OVER_BUDGET' : 'PRICE_RANGE_BUDGET_RISK',
      '已列报价区间存在超支风险', { lowerFen, upperFen, budgetFen: prefs.teamBudgetFen }));
  }
  const missingCount = expenses.filter(expense => expense.totalFen === null).length;
  return {
    roomId: trip.roomId, title: trip.destination + ' · ' + trip.days.length + '日行程', currency: 'CNY', timezone: 'Asia/Shanghai',
    origin: trip.origin, travelerCount: trip.travelerCount, dateStatus: trip.days[0].date ? 'dated' : 'duration_only',
    stays: trip.stays, journeys: trip.journeys, lodgingRequirements: trip.lodgingRequirements, avoidModes: trip.avoidModes,
    guides: trip.guides.map(({ url, screenshotRef, city }) => ({ url, screenshotRef, city })),
    days: dayPlans, expenses, budget: { knownTotalFen, teamBudgetFen: prefs.teamBudgetFen, missingCount, unpricedCount,
      quotedRangeFen: [lowerFen, upperFen], totalRangeFen: unpricedCount ? null : [lowerFen, upperFen],
      balanceFen: missingCount || prefs.teamBudgetFen === null ? null : prefs.teamBudgetFen - knownTotalFen,
      perPersonFen: missingCount || trip.travelerCount === null ? null : Math.round(knownTotalFen / trip.travelerCount), categories },
    preferences: { pace: prefs.pace, mustVisit: prefs.mustVisit, dietaryRestrictions: prefs.dietaryRestrictions,
      memberBudgets: prefs.memberBudgets, constraintsByMember: prefs.constraintsByMember },
    issues
  };
}
