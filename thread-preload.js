// Thread page bridge (chat-first preview, redesign R2a). The page reads the one
// row main opened it for and can ask for two navigation effects. Every call
// names that row; main refuses any other (src/thread-main.js guard T).
// R2b-1: a reply to the bound chat ({id, body}; main fixes the task and the
// action). R4-1a: thread:act, a choice on a request main showed this chat
// (approve once, deny, answer, choose, stop); main checks every key. R4-1b adds
// approve for this task and switch AI (`ai` to preview, `review` to apply).
// R4-2: a terminal session's hook requests (read, and answer one; the push is a ping with no data).
const { contextBridge, ipcRenderer } = require('electron');

const ROW_ID = /^[0-9a-f]{64}$/;
const id = (v) => (typeof v === 'string' && ROW_ID.test(v) ? v : '');
const sharedReviewCall = (row, req) => ipcRenderer.invoke('thread:shared-review', id(row), req);

contextBridge.exposeInMainWorld('threadApi', {
  open: (row) => ipcRenderer.invoke('thread:open', id(row)),
  state: (row) => ipcRenderer.invoke('thread:state', id(row)),
  close: (row) => ipcRenderer.invoke('thread:close', id(row)),
  openInTasks: (row) => ipcRenderer.invoke('thread:open-in-tasks', id(row)),
  goToTerminal: (row) => ipcRenderer.invoke('thread:go-to-terminal', id(row)),
  // Main's own pushes. The row id arrives with readiness; listeners only.
  onReady: (cb) => ipcRenderer.on('thread:ready', (_e, m) => cb(id(m?.id))),
  onEvent: (cb) => ipcRenderer.on('thread:event', (_e, m) => cb(m && typeof m === 'object' ? { id: id(m.id), event: m.event } : null)),
  // Copy link (provisional deep-link form, awaiting Callum): plexiform://thread/<id>.
  copyLink: (row) => ipcRenderer.invoke('thread:copy-link', id(row)),
  // Reply to the bound chat. Only the two keys main accepts.
  message: (row, body) => ipcRenderer.invoke('thread:message', { id: id(row), body: typeof body === 'string' ? body : '' }),
  // A choice on a request in this chat. Only the keys main accepts, as strings or true; main refuses any other shape.
  act: (row, r) => {
    const o = r && typeof r === 'object' ? r : {}, out = { id: id(row) };
    for (const k of ['action', 'approvalId', 'scope', 'askId', 'answer', 'choiceId', 'ai', 'review']) if (typeof o[k] === 'string') out[k] = o[k];
    if (o.confirmed === true) out.confirmed = true;
    return ipcRenderer.invoke('thread:act', out);
  },
  // R4-2: the bound session's waiting requests, and an answer to one of them. `more` is passed as plain data; main checks it.
  inputs: (row) => ipcRenderer.invoke('thread:inputs', id(row)),
  onInputsChanged: (cb) => ipcRenderer.on('thread:inputs-changed', (_e, m) => cb(id(m?.id))),
  answerInput: (row, inputId, optionId, more) => {
    const out = { id: id(row), inputId: typeof inputId === 'string' ? inputId : '', optionId: typeof optionId === 'string' ? optionId : '' };
    if (more && typeof more === 'object') out.more = JSON.parse(JSON.stringify(more));
    return ipcRenderer.invoke('thread:answer-input', out);
  },
  // T2: a teammate's shared session (read-only): its projection, and the way back to Team sessions.
  sharedState: (row) => ipcRenderer.invoke('thread:shared-state', id(row)),
  openTeam: (row) => ipcRenderer.invoke('thread:open-team', id(row)),
  // T3: an interact share's review card, its confirm, and my own proposals. The page sends only the op, the
  // exact text and main's selection; main resolves everything else.
  // T3b: inside the confirmed window the page also sends what it is showing (generation and turn), and main decides whether
  // that skips the card. "Ask me each time" is its own closed shape.
  sharedReview: (row, op, text, seen) => sharedReviewCall(row, seen && typeof seen === 'object'
    ? { op: String(op), text: String(text), seen: { generation: seen.generation, turn: seen.turn ?? null } } : { op: String(op), text: String(text) }),
  sharedAskEach: (row, on) => sharedReviewCall(row, { askEach: on === true }),
  sharedConfirm: (row, selection, text) => ipcRenderer.invoke('thread:shared-confirm', id(row), { selection: String(selection), text: String(text) }),
  sharedProposals: (row) => ipcRenderer.invoke('thread:shared-proposals', id(row)),
  // T4a: one of my own Plexiform-held sessions (read-only): its projection, and the way to Overview.
  ownedState: (row) => ipcRenderer.invoke('thread:owned-state', id(row)),
  openOverview: (row) => ipcRenderer.invoke('thread:open-overview', id(row)),
  // Back to Board from an ended chat.
  board: () => ipcRenderer.send('thread:board'),
});
