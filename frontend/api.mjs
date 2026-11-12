import { demoApi } from './demo.mjs';

export function httpApi(base) {
  async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetch(base+path, {
        method,
        credentials: 'include',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('无法连接后端，请检查服务地址和网络。');
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || '请求失败（HTTP '+response.status+'）。');
    if (data === null && path !== '/session' && !path.endsWith('/preferences/me')) {
      throw new Error('后端未返回预期的 JSON 数据。');
    }
    return data;
  }

  const roomPath = id => '/rooms/'+encodeURIComponent(id);
  return {
    session: () => request('/session'),
    login: (name, password) => request('/session', 'POST', { name, password }),
    logout: () => request('/session', 'DELETE'),
    rooms: () => request('/rooms'),
    create: input => request('/rooms', 'POST', input),
    join: code => request('/rooms/join', 'POST', { code }),
    room: id => request(roomPath(id)),
    preference: id => request(roomPath(id)+'/preferences/me'),
    savePreference: (id, input) => request(roomPath(id)+'/preferences/me', 'PUT', input),
    plans: id => request(roomPath(id)+'/plans')
  };
}

export const apiBase = new URLSearchParams(location.search).get('api')?.replace(/\/+$/, '');
export const api = apiBase ? httpApi(apiBase) : demoApi(localStorage);
