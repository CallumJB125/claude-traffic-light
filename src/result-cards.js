// Closed data shapes only. Saved cards never contain code, credentials,
// formulas or executable actions; the checkpoint supplies version/provenance.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResultCards = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LIMITS = Object.freeze({ cards: 8, bytes: 24 * 1024, title: 120, items: 20, label: 240, value: 80, unit: 40, note: 240, columns: 6, column: 80, rows: 20, cell: 240 });
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const bad = () => { throw new TypeError('Saved cards have invalid fields or exceed their size limit.'); };
  const shape = (v, keys) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) bad();
  };
  function cleanResultCards(value, cleanText = v => v) {
    if (!Array.isArray(value) || value.length > LIMITS.cards) bad();
    const clean = (v, max) => {
      if (typeof v !== 'string' || v.length > max) bad();
      const out = cleanText(v, max);
      if (typeof out !== 'string' || out.length > max) bad();
      return out;
    };
    const ids = new Set();
    const cards = value.map(card => {
      if (!card || typeof card.id !== 'string' || !ID.test(card.id) || clean(card.id, 64) !== card.id || ids.has(card.id)) bad();
      ids.add(card.id);
      const base = { id: card.id, kind: card.kind, title: clean(card.title, LIMITS.title) };
      if (card.kind === 'checklist') {
        shape(card, ['id', 'kind', 'title', 'items']);
        if (!Array.isArray(card.items) || card.items.length > LIMITS.items) bad();
        const items = new Set();
        return { ...base, items: card.items.map(item => {
          shape(item, ['id', 'label', 'done']);
          if (typeof item.id !== 'string' || !ID.test(item.id) || clean(item.id, 64) !== item.id || items.has(item.id) || typeof item.done !== 'boolean') bad();
          items.add(item.id); return { id: item.id, label: clean(item.label, LIMITS.label), done: item.done };
        }) };
      }
      if (card.kind === 'metric') {
        shape(card, ['id', 'kind', 'title', 'value', 'unit', 'note']);
        return { ...base, value: clean(card.value, LIMITS.value), unit: clean(card.unit, LIMITS.unit), note: clean(card.note, LIMITS.note) };
      }
      if (card.kind === 'table') {
        shape(card, ['id', 'kind', 'title', 'columns', 'rows']);
        if (!Array.isArray(card.columns) || !card.columns.length || card.columns.length > LIMITS.columns || !Array.isArray(card.rows) || card.rows.length > LIMITS.rows) bad();
        return { ...base, columns: card.columns.map(s => clean(s, LIMITS.column)), rows: card.rows.map(row => {
          if (!Array.isArray(row) || row.length !== card.columns.length) bad();
          return row.map(s => clean(s, LIMITS.cell));
        }) };
      }
      bad();
    });
    if (new TextEncoder().encode(JSON.stringify(cards)).length > LIMITS.bytes) bad();
    return cards;
  }
  return { cleanResultCards, LIMITS };
}));
