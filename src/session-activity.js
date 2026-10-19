'use strict';
// Activity is an intentionally closed vocabulary. Provider tool names,
// arguments, commands, paths and reasoning text never become activity text.
const ACTIVITY_LABELS = Object.freeze(['Thinking', 'Running a command', 'Editing files', 'Reading files', 'Searching', 'Using a tool', 'Coordinating agents']);
const validActivity = (a) => a !== null && typeof a === 'object' && !Array.isArray(a) && ACTIVITY_LABELS.includes(a.label) && ['working', 'completed'].includes(a.phase) && Number.isSafeInteger(a.observed_at) && a.observed_at >= 0;
const CODEX_LABELS = Object.freeze({ reasoning: 'Thinking', commandExecution: 'Running a command', fileChange: 'Editing files', webSearch: 'Searching', imageView: 'Reading files', mcpToolCall: 'Using a tool', dynamicToolCall: 'Using a tool', collabAgentToolCall: 'Coordinating agents' });
const CLAUDE_LABELS = Object.freeze({ Bash: 'Running a command', Read: 'Reading files', Glob: 'Searching', Grep: 'Searching', Edit: 'Editing files', Write: 'Editing files', MultiEdit: 'Editing files', NotebookEdit: 'Editing files', WebSearch: 'Searching', WebFetch: 'Reading files', Agent: 'Coordinating agents', Task: 'Coordinating agents' });
const codexActivityLabel = (type) => Object.hasOwn(CODEX_LABELS, type) ? CODEX_LABELS[type] : null;
const claudeActivityLabel = (block) => block?.type === 'thinking' ? 'Thinking' : block?.type === 'tool_use' ? (Object.hasOwn(CLAUDE_LABELS, block.name) ? CLAUDE_LABELS[block.name] : 'Using a tool') : null;
module.exports = { ACTIVITY_LABELS, validActivity, codexActivityLabel, claudeActivityLabel };
