
'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'build/installer.nsh'), 'utf8');
const template = fs.readFileSync(require.resolve('app-builder-lib/templates/nsis/uninstaller.nsh'), 'utf8');
// Bounded interpreter of the actual simple removal tail. Kernel outcomes and
// documented NSIS sticky error/IfErrors-clear semantics are explicit inputs;
// this is a boundary model, not Windows/NSIS runtime acceptance.
function removal({ incomingError = false, removeFails = false, executableRemains = false, reset = true } = {}) {
  const begin = source.indexOf('  SetOutPath $TEMP', source.indexOf('!macro customRemoveFiles'));
  const end = source.indexOf('!macroend', begin);
  const lines = source.slice(begin, end).split('\n').map(l => l.trim()).filter(l => l && !/^[;#]/.test(l));
  if (!reset) lines.splice(lines.indexOf('ClearErrors'), 1);
  const labels = new Map(lines.flatMap((line, i) => line.endsWith(':') ? [[line.slice(0, -1), i]] : []));
  let error = incomingError, code = 0, aborted = false, removals = 0;
  for (let pc = 0, steps = 0; pc < lines.length && steps++ < 30; pc++) {
    const line = lines[pc];
    if (line.startsWith('SetOutPath ') || line.startsWith('DetailPrint ') || line.endsWith(':')) continue;
    if (line === 'ClearErrors') { error = false; continue; }
    if (line === 'RMDir /r $INSTDIR') { removals++; if (removeFails) error = true; continue; }
    if (line.startsWith('IfErrors ')) { const [, yes, no] = line.split(' '); const jump = error ? yes : no; error = false; if (jump !== '0') pc = labels.get(jump) - 1; continue; }
    if (line.startsWith('SetErrorLevel ')) { code = Number(line.split(' ')[1]); continue; }
    if (line.startsWith('Abort ')) { aborted = true; break; }
    if (line.startsWith('IfFileExists ')) { assert.match(line, /\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}/); if (!executableRemains) pc = labels.get(line.split(' ').at(-1)) - 1; continue; }
    throw Error('Unsupported boundary instruction: ' + line);
  }
  return { code, aborted, removals };
}
test('actual pinned atomic enumeration reaches EOF and retains explicit busy restore Abort', () => {
  const atomic = template.slice(template.indexOf('Function un.atomicRMDir'), template.indexOf('Function un.restoreFiles'));
  assert.match(atomic, /FindNext \$R1 \$R2\s+Goto loop/);
  assert.match(atomic, /StrCmp \$R2 "" break/);
  assert.match(atomic, /break:\s+StrCpy \$R3 0[\s\S]*FindClose \$R1/);
  assert.match(source, /\$\{if\} \$R0 != 0[\s\S]*Call un\.restoreFiles[\s\S]*Abort[\s\S]*ClearErrors\s+RMDir/);
});
test('actual removal boundary discards earlier EOF and succeeds only when files really remove', () => {
  assert.deepEqual(removal({ incomingError: true }), { code: 0, aborted: false, removals: 1 });
  assert.deepEqual(removal({ incomingError: true, reset: false }), { code: 1, aborted: true, removals: 1 }, 'original boundary falsely refuses success');
});
test('actual removal boundary preserves genuine removal errors with or without earlier EOF', () => {
  for (const incomingError of [true, false]) assert.deepEqual(removal({ incomingError, removeFails: true }), { code: 1, aborted: true, removals: 1 });
});
test('actual remaining-executable guard still refuses even without kernel error flag', () => {
  assert.deepEqual(removal({ executableRemains: true }), { code: 1, aborted: true, removals: 1 });
  assert.deepEqual(removal(), { code: 0, aborted: false, removals: 1 }, 'ordinary uninstall without EOF remains successful');
});
