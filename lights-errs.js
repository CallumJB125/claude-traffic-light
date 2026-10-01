window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
