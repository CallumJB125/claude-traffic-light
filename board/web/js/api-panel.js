// The "API and webhooks" panel's actions (render-api.js draws it). Admin
// only, accounts mode only: the hub answers 403 to anyone else anyway.
import { readTokenForm, readWebhookForm } from './render-api.js';

/**
 * deps: {api, teamId(), get(), set(patch), update(), withBusy(key, fn), toast(text, tone), copyText(text), errorText(err)}.
 * get/set read and merge the panel's own state object.
 */
export function createApiPanel(deps) {
  const { api, teamId, get, set, update, withBusy, toast, copyText, errorText } = deps;

  async function load() {
    const team = teamId();
    if (!team) return;
    set({ status: 'loading' });
    update();
    try {
      const [t, w] = await Promise.all([api.apiTokens(team), api.webhooks(team)]);
      set({ status: 'ok', error: null, tokens: t.tokens, scopes: t.scopes, endpoints: w.endpoints, event_types: w.event_types });
    } catch (err) {
      set({ status: 'error', error: errorText(err) });
    }
    update();
  }

  const replaceEndpoint = (e) => set({ endpoints: (get().endpoints ?? []).map((x) => (x.id === e.id ? e : x)) });

  async function loadLog(id) {
    try {
      const r = await api.webhookDeliveries(teamId(), id);
      set({ deliveries: { ...get().deliveries, [id]: r.deliveries } });
    } catch (err) {
      set({ deliveries: { ...get().deliveries, [id]: [] }, error: errorText(err) });
    }
    update();
  }

  /** → true when the form was this panel's. */
  function submit(form) {
    const kind = form.dataset.form;
    if (kind === 'api-token') {
      const body = readTokenForm(form);
      if (!body.name || !body.scopes.length) { toast('Give the token a name and at least one permission.', 'error'); return true; }
      withBusy('api-token-new', () => api.createApiToken(teamId(), body)).then((r) => {
        if (!r) return;
        form.reset();
        set({ secret: { kind: 'token', value: r.secret }, tokens: [r.token, ...(get().tokens ?? [])] });
        update();
      });
      return true;
    }
    if (kind === 'api-webhook') {
      const body = readWebhookForm(form);
      if (!body.url || !body.events.length) { toast('Enter an https URL and pick at least one event.', 'error'); return true; }
      withBusy('api-hook-new', () => api.createWebhook(teamId(), body)).then((r) => {
        if (!r) return;
        form.reset();
        set({ secret: { kind: 'webhook', value: r.secret }, endpoints: [...(get().endpoints ?? []), r.endpoint] });
        update();
      });
      return true;
    }
    return false;
  }

  /** → true when the action was this panel's. */
  function action(name, el) {
    const id = el.dataset.token ?? el.dataset.endpoint;
    switch (name) {
      case 'api-secret-done': set({ secret: null }); update(); return true;
      case 'api-copy-secret': copyText(get().secret?.value); return true;
      case 'api-cancel': set({ confirmRevoke: null, confirmDelete: null }); update(); return true;
      case 'api-revoke-ask': set({ confirmRevoke: id }); update(); return true;
      case 'api-hook-delete-ask': set({ confirmDelete: id }); update(); return true;
      case 'api-revoke':
        withBusy(`api-token:${id}`, () => api.revokeApiToken(teamId(), id)).then((r) => {
          set({ confirmRevoke: null, ...(r ? { tokens: (get().tokens ?? []).map((t) => (t.id === id ? r.token : t)) } : {}) });
          update();
        });
        return true;
      case 'api-hook-delete':
        withBusy(`api-hook:${id}`, () => api.deleteWebhook(teamId(), id)).then((r) => {
          set({ confirmDelete: null, ...(r ? { endpoints: (get().endpoints ?? []).filter((e) => e.id !== id) } : {}) });
          update();
        });
        return true;
      case 'api-hook-toggle':
        withBusy(`api-hook:${id}`, () => api.patchWebhook(teamId(), id, { enabled: el.dataset.enable === '1' })).then((r) => {
          if (r) { replaceEndpoint(r.endpoint); update(); }
        });
        return true;
      case 'api-hook-test':
        withBusy(`api-hook:${id}`, () => api.testWebhook(teamId(), id)).then((r) => {
          if (!r) return;
          const d = r.delivery;
          toast(d.state === 'delivered' ? `Test event delivered (${d.status}, ${d.latency_ms} ms).` : 'The test event was not delivered: see Deliveries.', d.state === 'delivered' ? 'info' : 'error');
          if (get().openLog === id) loadLog(id);
        });
        return true;
      case 'api-hook-log': {
        const open = get().openLog === id ? null : id;
        set({ openLog: open });
        update();
        if (open) loadLog(open);
        return true;
      }
      default: return false;
    }
  }

  return { load, submit, action };
}
