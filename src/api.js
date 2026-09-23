export const auth = {currentUser: null};
export async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/${path}`, {method, credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body)});
  let data; try { data = await response.json(); } catch { throw new Error('The server did not respond as expected. Please try again.'); }
  if (!response.ok) { const error = new Error(data.message || 'The request failed. Please try again.'); error.status = response.status; throw error; }
  return data;
}
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
