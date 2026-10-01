export const CLIENT_TOKEN_RE = /^clinv_[A-Za-z0-9_-]{43}$/;
export async function clientCall(method, path, body, csrf) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); // privacy-flow: board-view
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(data?.error?.message ?? 'Could not load your project. Please try again.');
    error.code = data?.error?.code; error.status = res.status; throw error;
  }
  return data;
}
