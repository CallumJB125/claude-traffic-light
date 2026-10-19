'use strict';
// A dedicated process owns optional reads of arbitrary recent project folders.
// It is killable even when macOS holds a native open for an unseen privacy prompt.
const Starter = require('./starter-pack.js');
process.once('message', message => {
  let detected = [];
  if (message?.type === 'detect' && Array.isArray(message.folders) && message.folders.length <= 20) {
    try { detected = Starter.detect(message.folders); } catch { /* optional suggestion absent */ }
  }
  if (process.connected) process.send({ type: 'detected', detected }, () => { if (process.connected) process.disconnect(); });
});
