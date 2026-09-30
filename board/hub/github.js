// Read-only GitHub access for evidence verification and the Done merge poll.
// Interface (tests inject a fake with the same shape):
//   getPull(canonical_url, number) → {number, state:'open'|'closed', merged, merged_by, merged_at, head_ref, html_url} | null
//   getCommit(canonical_url, sha)  → {sha} | null
// canonical_url is scope.normalizeRemoteUrl() output ("github.com/owner/repo").
// Non-GitHub repos resolve to null (evidence then stays self_reported).

function ownerRepo(canonical) {
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(canonical ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

export const GITHUB_TIMEOUT_MS = 10_000;

export function createGitHub({ token = null, api = 'https://api.github.com', fetchImpl = globalThis.fetch, timeoutMs = GITHUB_TIMEOUT_MS } = {}) { // privacy-flow: hub-server
  async function get(path) {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'board-hub', 'x-github-api-version': '2022-11-28' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${api}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) }); // privacy-flow: hub-server
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${path} → ${res.status}`);
    return res.json();
  }
  return {
    enabled: true,
    async getPull(canonical, number) {
      const or = ownerRepo(canonical);
      if (!or || !Number.isSafeInteger(number)) return null;
      const p = await get(`/repos/${or}/pulls/${number}`);
      if (!p) return null;
      return {
        number: p.number, state: p.state, merged: !!p.merged, merged_by: p.merged_by?.login ?? null,
        merged_at: p.merged_at ?? null, head_ref: p.head?.ref ?? null, html_url: p.html_url ?? null,
      };
    },
    async getCommit(canonical, sha) {
      const or = ownerRepo(canonical);
      if (!or || !/^[0-9a-f]{7,40}$/i.test(sha ?? '')) return null;
      const c = await get(`/repos/${or}/commits/${sha}`);
      return c ? { sha: c.sha } : null;
    },
  };
}

// A GitHub client that knows nothing: every lookup is null (self_reported).
export const noGitHub = { enabled: false, async getPull() { return null; }, async getCommit() { return null; } };

// "123", "#123", ".../pull/123" → 123
export function prNumberOf(ref) {
  const m = /(?:^#?|\/pull\/)(\d+)\/?$/.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
}
