// Every waiting input a Claude Code hook can answer, in one place: what the
// blocking hook writes to requests/<id>.json for each kind, and how a widget
// answer for that kind becomes the hook's output. docs/waiting-inputs.md has
// the table of which inputs are hookable and the doc links behind it.
//
//   kind        channel (hook event)   answered with
//   permission  PermissionRequest      decision.behavior allow|deny (+ a session-scoped permission suggestion)
//   plan        PermissionRequest      allow (+ setMode acceptEdits) | deny with a message ("keep planning")
//   question    PreToolUse             permissionDecision allow + updatedInput.answers | deny
//   elicitation Elicitation            action accept (+ content) | decline | cancel
//
// Anything that doesn't fit its kind yields null: the hook prints nothing and
// the normal terminal prompt stays in charge. Nothing here ever decides on
// its own; the only answers are the ones a person chose.
const { hashToolInput } = require('./answer-file.js');

const KINDS = ['permission', 'plan', 'question', 'elicitation'];

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function kindOfTool(tool) {
  if (tool === 'ExitPlanMode') return 'plan';
  if (tool === 'AskUserQuestion') return 'question';
  return 'permission';
}

// AskUserQuestion's input: 1–4 questions, each {question, header, options:[{label, description?}], multiSelect?}.
function questionsOf(input) {
  const qs = Array.isArray(input?.questions) ? input.questions.slice(0, 8) : [];
  return qs.filter((q) => plain(q) && typeof q.question === 'string').map((q, i) => ({
    id: `q${i}`,
    question: str(q.question, 2000),
    header: str(q.header, 60),
    multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? q.options.slice(0, 16) : []).filter((o) => plain(o) && typeof o.label === 'string')
      .map((o, j) => ({ id: `q${i}o${j}`, label: str(o.label, 200), ...(typeof o.description === 'string' ? { description: str(o.description, 500) } : {}) })),
  }));
}

// A permission update Claude Code suggested, shown as an option. Only these
// types, and only for this session: "allow for this session", never a rule
// written into a settings file from the widget.
const SUGGESTION_TYPES = new Set(['addRules', 'addDirectories', 'setMode']);
function suggestionLabel(s) {
  if (s.type === 'addDirectories') return `Allow access to ${(s.directories || []).join(', ')} for this session`;
  if (s.type === 'setMode') return `Switch to ${s.mode} mode for this session`;
  const rules = (s.rules || []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
  return `Allow ${rules.join(', ')} for this session`;
}
function cleanSuggestions(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 16).filter((s) => plain(s) && SUGGESTION_TYPES.has(s.type) && (s.type !== 'addRules' || s.behavior === 'allow')).map((s) => {
    if (s.type === 'addDirectories') return { type: s.type, directories: (Array.isArray(s.directories) ? s.directories : []).filter((d) => typeof d === 'string').slice(0, 8).map((d) => d.slice(0, 1000)) };
    if (s.type === 'setMode') return { type: s.type, mode: str(s.mode, 40) };
    return { type: s.type, behavior: 'allow', rules: (Array.isArray(s.rules) ? s.rules : []).filter((r) => plain(r) && typeof r.toolName === 'string').slice(0, 8).map((r) => ({ toolName: str(r.toolName, 200), ...(typeof r.ruleContent === 'string' ? { ruleContent: str(r.ruleContent, 2000) } : {}) })) };
  }).filter((s) => (s.type !== 'addRules' || (s.behavior === 'allow' && s.rules.length)) && (s.type !== 'addDirectories' || s.directories.length) && (s.type !== 'setMode' || ['acceptEdits', 'default', 'plan'].includes(s.mode)));
}

// Modes a widget click may switch to. bypassPermissions/auto are never offered.
const SAFE_SUGGESTION = (s) => s.type !== 'setMode' || s.mode === 'acceptEdits' || s.mode === 'default' || s.mode === 'plan';

// The fields a request file carries beyond {id, sessionId, host, cwd,
// toolInput, toolInputHash, createdAt}. `data` is the hook payload.
function describeHookInput(channel, data) {
  if (channel === 'Elicitation') {
    const input = {
      mcp_server_name: str(data?.mcp_server_name, 200), message: str(data?.message, 4000), mode: str(data?.mode, 20) || 'form',
      ...(typeof data?.url === 'string' ? { url: str(data.url, 2000) } : {}),
      ...(typeof data?.elicitation_id === 'string' ? { elicitation_id: str(data.elicitation_id, 200) } : {}),
      ...(plain(data?.requested_schema) ? { requested_schema: data.requested_schema } : {}),
    };
    return { kind: 'elicitation', channel, tool: `mcp:${input.mcp_server_name || 'server'}`, toolInput: input };
  }
  const tool = str(data?.tool_name, 200) || 'tool';
  const kind = kindOfTool(tool);
  const toolInput = data?.tool_input;
  const out = { kind, channel, tool, toolInput };
  if (channel === 'PermissionRequest' && kind === 'permission') {
    out.permissionSuggestions = cleanSuggestions(data?.permission_suggestions).filter(SAFE_SUGGESTION);
  }
  return out;
}

// What the widget shows for a request: title, text and the options a click
// can send. Each option carries the exact answer it writes.
function viewOf(req) {
  const input = plain(req?.toolInput) ? req.toolInput : {};
  const tool = str(req?.tool, 200) || 'tool';
  switch (req?.kind) {
    case 'question': {
      const questions = questionsOf(input);
      const one = questions.length === 1 && !questions[0].multiSelect ? questions[0] : null;
      return {
        title: one?.header || 'Claude has a question',
        text: questions.map((q) => q.question).join('\n\n'),
        questions,
        options: [
          ...(one ? one.options.map((o) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}), answer: { decision: 'allow', extra: { answers: { [one.question]: o.label } } } })) : []),
          { id: 'deny', label: 'Decline to answer', answer: { decision: 'deny' } },
        ],
        freeText: true,
      };
    }
    case 'plan':
      return {
        title: 'Plan ready: approve?',
        text: str(input.plan, 20000),
        options: [
          { id: 'allow', label: 'Approve', answer: { decision: 'allow' } },
          { id: 'allow-accept-edits', label: 'Approve, auto-accept edits', answer: { decision: 'allow', extra: { mode: 'acceptEdits' } } },
          { id: 'deny', label: 'Keep planning', answer: { decision: 'deny', extra: { message: 'Keep planning: the plan was not approved yet.' } } },
        ],
      };
    case 'elicitation': {
      const url = input.mode === 'url' && typeof input.url === 'string';
      return {
        title: `${str(input.mcp_server_name, 200) || 'An MCP server'} asks for input`,
        text: str(input.message, 4000) + (url ? `\n\n${input.url}` : ''),
        ...(plain(input.requested_schema) ? { schema: input.requested_schema } : {}),
        options: [
          { id: 'accept', label: url ? 'Done, continue' : 'Submit', answer: { decision: 'accept' }, needsContent: !url && !!plain(input.requested_schema) },
          { id: 'decline', label: 'Decline', answer: { decision: 'decline' } },
          { id: 'cancel', label: 'Cancel', answer: { decision: 'cancel' } },
        ],
      };
    }
    default: {
      const sugg = Array.isArray(req?.permissionSuggestions) ? req.permissionSuggestions : [];
      return {
        title: `Allow ${tool}?`,
        text: '',
        options: [
          { id: 'allow', label: 'Allow once', answer: { decision: 'allow' } },
          ...sugg.map((s, i) => ({ id: `allow-session-${i}`, label: suggestionLabel(s), answer: { decision: 'allow', extra: { permissionIndex: i, suggestionHash: hashToolInput(s) } } })),
          { id: 'deny', label: 'Deny', answer: { decision: 'deny' } },
        ],
      };
    }
  }
}

const DENY_MESSAGE = 'Denied from the Claude Traffic Light widget';

// A widget answer → what the hook prints for Claude Code, or null.
function answerOutput(req, answer) {
  if (!req || !answer || !KINDS.includes(req.kind)) return null;
  const { decision } = answer;
  const extra = answer.extra || {};
  const input = plain(req.toolInput) ? req.toolInput : {};
  if (req.kind === 'elicitation') {
    if (req.channel !== 'Elicitation' || !['accept', 'decline', 'cancel'].includes(decision)) return null;
    const out = { hookEventName: 'Elicitation', action: decision };
    if (decision === 'accept') out.content = plain(extra.content) ? extra.content : {};
    return { hookSpecificOutput: out };
  }
  if (decision !== 'allow' && decision !== 'deny') return null;
  const message = typeof extra.message === 'string' && extra.message.trim() ? extra.message.slice(0, 1000) : DENY_MESSAGE;
  if (req.kind === 'question') {
    let updatedInput = null;
    if (decision === 'allow') {
      const texts = questionsOf(input).map((q) => q.question);
      const answers = plain(extra.answers) ? extra.answers : null;
      // Docs: map EACH question's text to the chosen answer.
      if (!answers || !texts.length || !texts.every((t) => typeof answers[t] === 'string' && answers[t].trim()) || Object.keys(answers).some((k) => !texts.includes(k))) return null;
      updatedInput = { ...input, answers };
    }
    if (req.channel === 'PreToolUse') {
      return { hookSpecificOutput: decision === 'allow'
        ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput }
        : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } };
    }
    if (req.channel !== 'PermissionRequest') return null;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision === 'allow' ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message } } };
  }
  if (req.channel !== 'PermissionRequest') return null;
  if (decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
  const d = { behavior: 'allow' };
  if (req.kind === 'plan' && extra.mode === 'acceptEdits') d.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  if (req.kind === 'permission' && extra.permissionIndex !== undefined) {
    const s = (Array.isArray(req.permissionSuggestions) ? req.permissionSuggestions : [])[extra.permissionIndex];
    // The rule applied is the one the person clicked: the answer names the
    // suggestion's hash, and the suggestion at that index must still match it.
    if (!s || !SAFE_SUGGESTION(s) || extra.suggestionHash !== hashToolInput(s)) return null;
    d.updatedPermissions = [{ ...s, destination: 'session' }];
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } };
}

module.exports = { KINDS, DENY_MESSAGE, kindOfTool, questionsOf, cleanSuggestions, describeHookInput, viewOf, answerOutput };
