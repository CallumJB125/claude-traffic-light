// The Integrations page's Triggers panel (render-triggers.js): loading the
// team's rules and their activity, and an admin's create / mode / delete.
// The hub decides everything (admin-only, a week of dry run, confirmation);
// this only sends what was clicked and shows what came back.
import { triggerBody } from './render-triggers.js';

export function triggerActions({ api, state, update, withBusy, errorText, toast }) {
  const cur = () => state.integ.triggers ?? {};
  const set = (patch) => { state.integ = { ...state.integ, triggers: { ...cur(), ...patch } }; update(); };
  const replace = (trigger) => set({ data: { ...cur().data, triggers: (cur().data?.triggers ?? []).map((t) => (t.id === trigger.id ? trigger : t)) } });

  async function loadActivity() {
    try { set({ activity: (await api.triggerActivity()).firings ?? [] }); } catch (err) { set({ activity: [], error: errorText(err) }); }
  }

  async function load() {
    set({ status: 'loading' });
    try { set({ status: 'ok', data: await api.triggers(), error: null }); } catch (err) { set({ status: 'error', error: errorText(err) }); }
    if (cur().showActivity) loadActivity();
  }

  return {
    load,
    async submit(form) {
      let body;
      try { body = triggerBody(form); } catch (err) { set({ formError: errorText(err) }); return; }
      const res = await withBusy('trigger:new', () => api.createTrigger(body));
      if (!res?.trigger) return;
      form.reset();
      set({ formError: null, data: { ...cur().data, triggers: [...(cur().data?.triggers ?? []), res.trigger] } });
      toast('Trigger added. It is off until you start a dry run.');
    },
    async mode(id, mode) {
      const res = await withBusy(`trigger:${id}`, () => api.setTriggerMode(id, mode, mode === 'on'));
      set({ confirmOn: null });
      if (res?.trigger) replace(res.trigger);
    },
    confirmOn(id) { set({ confirmOn: id }); },
    async remove(id) {
      const res = await withBusy(`trigger:${id}`, () => api.deleteTrigger(id));
      if (res) set({ data: { ...cur().data, triggers: (cur().data?.triggers ?? []).filter((t) => t.id !== id) } });
    },
    toggleActivity() {
      const showActivity = !cur().showActivity;
      set({ showActivity, ...(showActivity ? { activity: null } : {}) });
      if (showActivity) loadActivity();
    },
  };
}
