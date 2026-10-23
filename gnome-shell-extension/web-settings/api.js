const token = new URLSearchParams(window.location.search).get('token') ?? '';

export function hasToken() {
    return Boolean(token);
}

export async function request(path, {method = 'GET', body = null} = {}) {
    const headers = {'X-Agent-Quota-Token': token};
    if (body !== null)
        headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
        method,
        headers,
        body: body === null ? null : JSON.stringify(body),
        cache: 'no-store',
    });
    let payload = null;
    try {
        payload = await response.json();
    } catch (_error) {
        // The server always sends JSON for API errors; keep a useful fallback
        // for a proxy or a truncated response.
    }
    if (!response.ok)
        throw new Error(payload?.error ?? `Settings request failed (${response.status})`);
    return payload;
}

export const api = {
    state: () => request('/api/state'),
    setting: (key, value) => request('/api/settings', {method: 'POST', body: {key, value}}),
    layout: (layout, settings) => request('/api/layout', {method: 'POST', body: {layout, settings}}),
    secret: (provider, key, value) => request('/api/secret', {method: 'POST', body: {provider, key, value}}),
    stop: () => request('/api/stop', {method: 'POST', body: {}}),
};
