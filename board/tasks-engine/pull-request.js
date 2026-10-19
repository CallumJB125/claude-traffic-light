// Explicit draft PR creation from an already published clean task branch.
// Never commits, pushes, resets, fetches or executes repository configuration.
// The GitHub credential stays in this process, scoped to one reviewed operation.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveBin, probeEnv } from '../runner/backends/detect.js';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*[\x00-\x20~^:?*\[\\])[A-Za-z0-9._/-]{1,200}$/;
const TTL = 5 * 60_000;
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
const stale = () => failure('CONFLICT', 'The pull request review changed. Review again.');
const manual = message => failure('POLICY_DENIED', message);
const binding = t => hash([t.id, t.state, t.stateSince, t.sessionId, t.repo, t.worktree, t.gitDir, t.gitRef, t.branch, t.baseBranch, t.baseSha, t.ai, t.permissionLevel, t.checkpoint, t.handover, t.source, t.sourceMeta]);
const json = s => { try { return JSON.parse(s); } catch { return null; } };
const exactText = (v, max) => typeof v === 'string' && v.length <= max && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const remoteRepo = raw => {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][\w.-]{0,99})\/([A-Za-z0-9][\w.-]{0,99}?)(?:\.git)?$/.exec(raw);
  return m && ![m[1],m[2]].some(x => x === '.' || x === '..') ? `${m[1]}/${m[2]}` : null;
};

function run(bin, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 << 20 }, (error, stdout) => { // privacy-flow: tasks-pr
      if (error) reject(manual('Git or GitHub CLI could not complete this check.')); else resolve(stdout);
    });
    child.stdin?.end();
  });
}

export function createTaskPullRequest({ gitBin, env = process.env, dataDir, journalDir = dataDir, now = Date.now, connect }) {
  const reviews = new Map();
  const ghBin = resolveBin('gh', env).bin;
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const gitEnv = { ...probeEnv(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const gitArgs = ['--no-pager', '-c', `core.hooksPath=${nullFile}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${nullFile}`, '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false'];
  const git = (cwd, args) => run(gitBin, ['-C', cwd, ...gitArgs, ...args], gitEnv, dataDir);
  const checked = async (promise, current) => { const out = await promise; if (!current()) throw stale(); return out; };
  async function github() {
    if (connect) return connect(); // isolated test transport; never comes from a renderer
    if (!ghBin) throw manual('Install GitHub CLI and sign in before reviewing a pull request.');
    const token = (await run(ghBin, ['auth', 'token', '--hostname', 'github.com'], { ...probeEnv(env), GH_PROMPT_DISABLED: '1' }, dataDir)).trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw manual('Sign in to GitHub CLI before reviewing a pull request.');
    return async (method, endpoint, body) => {
      try {
        const response = await fetch(`https://api.github.com/${endpoint}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Plexiform', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}) }); // privacy-flow: tasks-pr
        // Bound even error responses; never return response text or credential.
        let bytes = 0, chunks = [];
        for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > (2 << 20)) throw new Error(); chunks.push(chunk); }
        return { status: response.status, body: json(Buffer.concat(chunks).toString('utf8')) };
      } catch { return { status: 0, body: null }; }
    };
  }
  async function local(t, current) {
    if (!gitBin || t.state !== 'in_review' || t.workInPlace || !t.worktreeCreated || !t.gitDir || !t.repo?.root || !BRANCH.test(t.branch ?? '') || !BRANCH.test(t.baseBranch ?? '') || t.branch === t.baseBranch || t.gitRef !== `refs/heads/${t.branch}`) throw manual('This task needs a separate committed and published branch.');
    const root = await checked(fs.realpath(t.worktree), current);
    if (root !== t.worktree) throw stale();
    const config = await checked(git(root, ['config', '--no-includes', '--list']), current);
    if (config.split('\n').some(s => /^(?:include|includeif|filter)\.|^core\.(?:worktree|sparsecheckout|alternaterefscommand)=/i.test(s))) throw manual('This repository configuration requires manual pull request creation.');
    const gd = (await checked(git(root, ['rev-parse', '--absolute-git-dir']), current)).trim();
    if (gd !== t.gitDir || (await checked(git(root, ['symbolic-ref', '--quiet', 'HEAD']), current)).trim() !== t.gitRef) throw stale();
    const top = (await checked(git(root, ['rev-parse', '--show-toplevel']), current)).trim();
    if (top !== root) throw stale();
    if ((await checked(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']), current))) throw manual('Commit and publish the task branch before reviewing a pull request. Local files are unchanged.');
    const flags = await checked(git(root, ['ls-files', '-v', '-z']), current);
    if (flags.split('\0').filter(Boolean).some(s => !s.startsWith('H '))) throw manual('Hidden index changes require manual review.');
    const urls = (await checked(git(root, ['config', '--no-includes', '--get-all', 'remote.origin.url']), current)).trimEnd().split('\n');
    const repo = urls.length === 1 && remoteRepo(urls[0]);
    if (!repo) throw manual('A single standard github.com origin remote is required.');
    const head = (await checked(git(root, ['rev-parse', '--verify', 'HEAD']), current)).trim();
    if (!OID.test(head)) throw stale();
    const stat = await checked(fs.stat(gd), current);
    return { repo, head, branch: t.branch, base: t.baseBranch, config: hash(config), task: binding(t), identity: [stat.dev,stat.ino] };
  }
  async function get(api, endpoint, current) {
    const r = await checked(api('GET', endpoint), current);
    if (r.status !== 200) throw manual('GitHub could not verify this account, repository or branch.');
    return r.body;
  }
  async function capture(t, api, current) {
    const l = await local(t, current), user = await get(api, 'user', current), repo = await get(api, `repos/${l.repo}`, current);
    if (!Number.isSafeInteger(user?.id) || user.id < 1 || typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(user.login) || !Number.isSafeInteger(repo?.id) || repo.id < 1 || repo?.full_name?.toLowerCase() !== l.repo.toLowerCase() || repo.permissions?.push !== true || repo.archived !== false) throw manual('This GitHub account cannot create a pull request in this repository.');
    const head = await get(api, `repos/${l.repo}/git/ref/heads/${encodeURIComponent(l.branch)}`, current);
    const base = await get(api, `repos/${l.repo}/git/ref/heads/${encodeURIComponent(l.base)}`, current);
    if (head?.ref !== `refs/heads/${l.branch}` || base?.ref !== `refs/heads/${l.base}` || head.object?.type !== 'commit' || base.object?.type !== 'commit' || !OID.test(base.object.sha) || head.object.sha !== l.head) throw manual('Publish this exact task commit before reviewing. Plexiform never pushes automatically.');
    if (hash(await local(t,current)) !== hash(l)) throw stale();
    return { ...l, account: { id: user.id, login: user.login }, baseHead: base.object.sha, repoId: repo.id };
  }
  function receipt(p, a) {
    if (!p || !Number.isSafeInteger(p.number) || p.number < 1 || p.html_url !== `https://github.com/${a.repo}/pull/${p.number}` || p.user?.id !== a.account.id || p.head?.ref !== a.branch || p.base?.ref !== a.base || p.head.repo?.full_name?.toLowerCase() !== a.repo.toLowerCase() || p.base.repo?.full_name?.toLowerCase() !== a.repo.toLowerCase() || p.body !== a.body || p.title !== a.title || !['open','closed'].includes(p.state) || !OID.test(p.head.sha) || !OID.test(p.base.sha)) return null;
    return { status: 'created', number: p.number, url: p.html_url, state: p.state, draft: p.draft === true, changed: p.head.sha !== a.head || p.base.sha !== a.baseHead, head: p.head.sha };
  }
  async function recover(t, current = () => true, save) {
    const a = t.prAttempt;
    if (!a || a.status !== 'dispatching') throw stale();
    const api = await checked(github(), current), user = await get(api, 'user', current);
    if (user?.id !== a.account.id) throw manual('Use the original GitHub account to check this receipt.');
    // A retained attempt holds only hashes, not the submitted text.
    const found = await get(api, `repos/${a.repo}/pulls?state=all&head=${encodeURIComponent(a.repo.split('/')[0] + ':' + a.branch)}&base=${encodeURIComponent(a.base)}&per_page=100`, current);
    if (!Array.isArray(found)) throw stale();
    const matches = found.filter(p => hash([p.title,p.body]) === a.textHash);
    if (matches.length === 1) {
      const r = receipt(matches[0], { ...a, title: matches[0].title, body: matches[0].body });
      if (r) { t.prAttempt = { ...a, status: 'created', receipt: r }; save(); return r; }
    }
    return { status: 'unconfirmed', reason: 'No exact receipt was found. Inspect GitHub before any manual retry; Plexiform will not create another pull request.' };
  }
  async function preview(t, text, current = () => true) {
    if (t.prAttempt && t.prAttempt.status !== 'refused') return { status: 'unconfirmed', reason: 'A pull request was already attempted. Check its receipt before continuing.' };
    if (!text || Object.keys(text).some(k => !['title','body'].includes(k)) || !exactText(text.title,120) || !text.title.trim() || /[\r\n]/.test(text.title) || !exactText(text.body,10000)) throw failure('VALIDATION','Write a title and description within the displayed limits.');
    const api = await checked(github(), current), c = await capture(t, api, current);
    const patch = await checked(git(t.worktree, ['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames',`${c.baseHead}...${c.head}`,'--']), current);
    if (!patch || Buffer.byteLength(patch) > 256 * 1024 || /(?:^|\n)(?:Binary files |GIT binary patch)/.test(patch)) throw manual('This change needs manual review on GitHub.');
    if (hash(await capture(t,api,current)) !== hash(c)) throw stale();
    const id = crypto.randomUUID(), body = `${text.body.trim()}\n\n<!-- plexiform-task:${t.id}:${id} -->`, expiresAt = now() + TTL;
    const review = { status: 'review', repo: c.repo, account: c.account.login, branch: c.branch, base: c.base, head: c.head, baseHead: c.baseHead, title: text.title.trim(), body, patch, expiresAt };
    const digest = hash([c,review]);
    for (const [k,r] of reviews) if (r.expiresAt <= now()) reviews.delete(k);
    while (reviews.size >= 100) reviews.delete(reviews.keys().next().value);
    reviews.set(id,{c,review,digest,expiresAt});
    return {...review,id,hash:digest};
  }
  async function apply(t,id,digest,current = () => true,save) {
    const r = reviews.get(id); reviews.delete(id);
    const fresh = () => current() && r && r.expiresAt > now() && binding(t) === r.c.task;
    if (!fresh() || r.digest !== digest || typeof save !== 'function' || t.prAttempt && t.prAttempt.status !== 'refused') throw stale();
    const api = await checked(github(),fresh), c = await capture(t,api,fresh);
    if (hash(c) !== hash(r.c)) throw stale();
    // Durable consumption precedes the only outbound mutation. A restart or
    // lost reply offers read-only receipt recovery, never a second POST.
    const attempt = {...c,id,status:'dispatching',textHash:hash([r.review.title,r.review.body]),at:now()};
    t.prAttempt = attempt; save();
    if (!fresh()) { t.prAttempt = {...attempt,status:'refused'}; save(); throw stale(); }
    // Persist creation/compaction of the existing journal directory as well as
    // its fsynced task record. Unsupported filesystems refuse before POST.
    for (const dir of new Set([journalDir,dataDir])) {
      const directory = await fs.open(dir,'r');
      try { if (!fresh()) throw stale(); await checked(directory.sync(),fresh); } finally { await directory.close(); }
    }
    if (!fresh()) throw stale();
    let result; try { result = await api('POST',`repos/${c.repo}/pulls`,{title:r.review.title,body:r.review.body,head:c.branch,base:c.base,draft:true,maintainer_can_modify:false}); } catch { result = {status:0}; }
    const out = result.status === 201 && result.body?.draft === true && receipt(result.body,{...c,title:r.review.title,body:r.review.body});
    if (out) { t.prAttempt = {...attempt,status:'created',receipt:out}; save(); return out; }
    if ([400,401,403,404,422].includes(result.status)) { t.prAttempt = {...attempt,status:'refused'}; save(); return {status:'refused',reason:'GitHub refused to create this draft. Review the account, branch and any existing pull request.'}; }
    return {status:'unconfirmed',reason:'GitHub did not return a verified receipt. Inspect or check the receipt; do not retry creation.'};
  }
  return { available: !!gitBin && (!!ghBin || !!connect), preview, apply, recover, clear: () => reviews.clear() };
}
