// Trusted UI for fixed saved-card data shapes. Card text is never HTML/code.
(function (root) {
  'use strict';
  function ui(doc) {
    const el = (tag, text, cls) => { const n = doc.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (label, action, disabled = false) => { const b = el('button', label, 'btn small'); b.type = 'button'; b.disabled = disabled; b.addEventListener('click', action); return b; };
    return { el, button };
  }
  function render({ document: doc, cards, disabled, provenance, onEdit, onToggle, onAdd }) {
    const { el, button } = ui(doc), box = el('section'); box.id = 'result-cards';
    box.append(el('h3', 'Saved result cards', 'sect'), el('p', provenance || 'Cards save with this task’s checkpoint.', 'tx-empty'));
    if (!cards.length) box.append(el('p', 'Keep an interactive checklist, metric or small table beside this task.', 'tx-empty'));
    for (const card of cards) {
      const article = el('article', null, 'box'); article.dataset.cardId = card.id;
      article.append(el('h4', card.title || 'Untitled card'));
      if (card.kind === 'checklist') {
        article.append(el('p', `${card.items.filter(i => i.done).length} of ${card.items.length} complete`, 'tx-empty'));
        for (const item of card.items) {
          const label = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = item.done; input.disabled = disabled;
          input.addEventListener('change', () => onToggle(card.id, item.id, input.checked));
          label.append(input, doc.createTextNode(` ${item.label || 'Untitled item'}`)); const line = el('p'); line.append(label); article.append(line);
        }
      } else if (card.kind === 'metric') {
        article.append(el('strong', `${card.value || 'No value set'}${card.unit ? ` ${card.unit}` : ''}`));
        if (card.note) article.append(el('p', card.note));
      } else if (card.kind === 'table') {
        const table = el('table'); table.setAttribute('aria-label', card.title || 'Saved table');
        const head = el('thead'), tr = el('tr');
        for (const label of card.columns) { const th = el('th', label); th.scope = 'col'; tr.append(th); } head.append(tr); table.append(head);
        const body = el('tbody');
        for (const values of card.rows) { const row = el('tr'); for (const value of values) row.append(el('td', value)); body.append(row); }
        table.append(body); article.append(table);
      }
      article.append(button('Edit card', () => onEdit(card.id), disabled)); box.append(article);
    }
    const actions = el('div', null, 'd-actions');
    for (const [kind, label] of [['checklist', 'Add checklist'], ['metric', 'Add metric'], ['table', 'Add table']]) actions.append(button(label, () => onAdd(kind), disabled || cards.length >= 8));
    box.append(actions, el('p', 'Card values are saved data, not live calculations. Only explicit edits change them; cards run no scripts or network requests.', 'tx-empty'));
    return box;
  }
  function editor({ document: doc, state, onRender, onSave, onCancel, onReload, onRemove, newId }) {
    const { el, button } = ui(doc), form = el('form', null, 'box'); form.id = 'result-card-editor'; form.addEventListener('submit', e => e.preventDefault());
    const card = state.cards.find(c => c.id === state.cardId);
    form.append(el('h3', card ? `Edit ${card.kind}` : 'Review card removal', 'sect'), el('p', `Saving against checkpoint version ${state.expectedVersion}.`, 'tx-empty'));
    const field = (label, value, max, change) => {
      const wrap = el('label', label, 'field'), input = el('input'); input.type = 'text'; input.value = value; input.maxLength = max; input.disabled = state.busy; input.setAttribute('aria-label', label);
      input.addEventListener('input', () => change(input.value)); wrap.append(input); form.append(wrap); return input;
    };
    if (card) {
      field('Card title', card.title, 120, v => { card.title = v; });
      if (card.kind === 'metric') {
        for (const [key, label, max] of [['value', 'Value', 80], ['unit', 'Unit', 40], ['note', 'Note', 240]]) field(label, card[key], max, v => { card[key] = v; });
      } else if (card.kind === 'checklist') {
        card.items.forEach((item, index) => {
          field(`Item ${index + 1}`, item.label, 240, v => { item.label = v; });
          const row = el('div', null, 'd-actions'), label = el('label', ' Complete '), check = el('input'); check.type = 'checkbox'; check.checked = item.done; check.disabled = state.busy;
          check.addEventListener('change', () => { item.done = check.checked; }); label.prepend(check);
          row.append(label, button(`Remove item ${index + 1}`, () => { card.items.splice(index, 1); onRender(); }, state.busy)); form.append(row);
        });
        form.append(button('Add item', () => { card.items.push({ id: newId(), label: '', done: false }); onRender(); }, state.busy || card.items.length >= 20));
      } else if (card.kind === 'table') {
        card.columns.forEach((name, index) => field(`Column ${index + 1}`, name, 80, v => { card.columns[index] = v; }));
        const columns = el('div', null, 'd-actions');
        columns.append(button('Add column', () => { card.columns.push(`Column ${card.columns.length + 1}`); card.rows.forEach(row => row.push('')); onRender(); }, state.busy || card.columns.length >= 6),
          button('Remove last column', () => { card.columns.pop(); card.rows.forEach(row => row.pop()); onRender(); }, state.busy || card.columns.length <= 1)); form.append(columns);
        card.rows.forEach((row, index) => {
          form.append(el('h4', `Row ${index + 1}`));
          row.forEach((value, col) => field(`Row ${index + 1}, ${card.columns[col] || `column ${col + 1}`}`, value, 240, v => { row[col] = v; }));
          form.append(button(`Remove row ${index + 1}`, () => { card.rows.splice(index, 1); onRender(); }, state.busy));
        });
        form.append(button('Add row', () => { card.rows.push(card.columns.map(() => '')); onRender(); }, state.busy || card.rows.length >= 20));
      }
    }
    const error = el('p', state.error || '', 'err'); error.id = 'result-card-error'; error.setAttribute('role', 'alert'); form.append(error);
    const actions = el('div', null, 'd-actions');
    actions.append(button('Save card changes', onSave, state.busy), button('Cancel card changes', onCancel, state.busy));
    if (card) actions.append(button('Remove this card', onRemove, state.busy));
    if (state.error) actions.append(button('Reload and discard this draft', onReload, state.busy));
    form.append(actions); return form;
  }
  root.ResultCardsView = { render, editor };
}(typeof globalThis !== 'undefined' ? globalThis : this));
