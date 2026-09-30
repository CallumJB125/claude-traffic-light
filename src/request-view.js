// What the widget shows for a pending permission request: a one-line
// headline for the Allow/Deny strip (with an explicit "+N more chars" when it
// is cut) and the full text behind it, so what you approve is what you saw.
// Edits show a diff summary, not just the path. Invisible and direction-
// changing characters are made visible, so a command can't hide what it says.
// Pure: signal-server.js attaches it to each request; index.html renders it
// as text only.

const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]|\udb40[\udc00-\udc7f]/g;
const reveal = (s) => String(s).replace(HIDDEN, (ch) => `⟨U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);

const HEADLINE_CHARS = 60;
const DETAIL_CHARS = 20000;

const lines = (s) => (typeof s === 'string' && s !== '' ? s.split('\n') : []);
const str = (v) => (typeof v === 'string' ? v : '');

function editView(tool, input) {
  const file = str(input.file_path) || str(input.notebook_path) || '(no path)';
  if (tool === 'Write') {
    const body = lines(input.content);
    return { headline: `write ${body.length} line${body.length === 1 ? '' : 's'} — ${file}`, detail: `${file}\nwhole file, ${body.length} lines:\n${body.map((l) => `+ ${l}`).join('\n')}` };
  }
  const edits = tool === 'MultiEdit' && Array.isArray(input.edits) ? input.edits
    : tool === 'NotebookEdit' ? [{ old_string: '', new_string: str(input.new_source), mode: input.edit_mode }]
    : [input];
  let minus = 0, plus = 0;
  const parts = edits.map((e, i) => {
    const o = lines(str(e?.old_string));
    const n = lines(str(e?.new_string));
    minus += o.length; plus += n.length;
    const head = `@@ edit ${i + 1}${e?.replace_all ? ' (every occurrence)' : ''}${e?.mode ? ` (${e.mode})` : ''}`;
    return [head, ...o.map((l) => `- ${l}`), ...n.map((l) => `+ ${l}`)].join('\n');
  });
  const all = edits.some((e) => e?.replace_all) ? ', every occurrence' : '';
  return { headline: `−${minus} +${plus} lines${edits.length > 1 ? ` in ${edits.length} edits` : ''}${all} — ${file}`, detail: `${file}\n${parts.join('\n')}` };
}

function describeRequest(req) {
  const tool = str(req?.tool) || 'tool';
  const input = req?.toolInput && typeof req.toolInput === 'object' && !Array.isArray(req.toolInput) ? req.toolInput : null;
  let v;
  if (!input) v = { headline: str(req?.summary), detail: `${str(req?.summary)}\n\n(older hook: only this summary was recorded — check the terminal)` };
  else if (typeof input.command === 'string') v = { headline: input.command, detail: input.command + (typeof input.description === 'string' ? `\n\n# ${input.description}` : '') };
  else if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) v = editView(tool, input);
  else v = { headline: JSON.stringify(input), detail: JSON.stringify(input, null, 2) };
  const headline = reveal(v.headline).replace(/\s+/g, ' ').trim();
  const detail = reveal(v.detail);
  return {
    tool,
    headline: headline.slice(0, HEADLINE_CHARS),
    moreChars: Math.max(0, headline.length - HEADLINE_CHARS),
    detail: detail.slice(0, DETAIL_CHARS),
    detailCutChars: Math.max(0, detail.length - DETAIL_CHARS),
    cwd: str(req?.cwd),
  };
}

module.exports = { describeRequest, reveal, HEADLINE_CHARS, DETAIL_CHARS };
