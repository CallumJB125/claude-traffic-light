// Read-only GitHub access for evidence verification and the Done merge poll.
// Interface (tests inject a fake with the same shape):
//   getPull(canonical_url, number) → {number, state:'open'|'closed', merged, merged_by, merged_at, head_ref, head_repo_id, head_repo,
//     base_repo_id, base_ref, html_url} | null   (head_repo_id is null when the head repo was deleted; D90)
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
        head_repo_id: p.head?.repo?.id ?? null, head_repo: p.head?.repo?.full_name ?? null,
        base_repo_id: p.base?.repo?.id ?? null, base_ref: p.base?.ref ?? null,
        head_sha: p.head?.sha ?? null, merge_commit_sha: p.merge_commit_sha ?? null,
      };
    },
    async getCommit(canonical, sha) {
      const or = ownerRepo(canonical);
      if (!or || !/^[0-9a-f]{7,40}$/i.test(sha ?? '')) return null;
      const c = await get(`/repos/${or}/commits/${sha}`);
      return c ? { sha: c.sha } : null;
    },
    // A single server-captured branch/ref, encoded as one path component.
    // No client refspec, wildcard, traversal, arbitrary endpoint or fallback.
    async getBaseCommit(canonical, ref) {
      const or=ownerRepo(canonical);
      if(!or || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(or) || typeof ref!=='string' || !ref || ref.length>200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
        || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('@{'))return null;
      const commit=await get(`/repos/${or}/commits/${encodeURIComponent(ref)}`);
      return commit && /^[0-9a-f]{40}$/i.test(commit.sha??'') ? {sha:commit.sha.toLowerCase()} : null;
    },
  };
}

// A GitHub client that knows nothing: every lookup is null (self_reported).
export const noGitHub = { enabled: false, async getPull() { return null; }, async getCommit() { return null; }, async getBaseCommit() { return null; } };

// "123", "#123", ".../pull/123" → 123
export function prNumberOf(ref) {
  const m = /(?:^#?|\/pull\/)(\d+)\/?$/.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
}

// D90: a PR is evidence for a card only when it is the card's own work: the run
// branch (or a later board/<KEY>-r<n>), head in the same repo as the base (no
// fork; a deleted head repo is unbound), targeting the base the run was
// dispatched with. `stored` is the binding recorded at verification, if any.
export function prBound(pull, { branch, key, baseRef, stored = null }) {
  if (!pull) return false;
  const head = String(pull.head_ref ?? '');
  if (!(head === branch || head.startsWith(`board/${key}-r`))) return false;
  if (pull.head_repo_id == null || pull.head_repo_id !== pull.base_repo_id) return false;
  if (pull.base_ref == null || pull.base_ref !== (stored?.base_ref ?? baseRef)) return false;
  if (stored?.head_repo_id != null && stored.head_repo_id !== pull.head_repo_id) return false;
  return true;
}
