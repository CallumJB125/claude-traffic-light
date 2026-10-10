const { test, expect, chromium } = require('@playwright/test');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// The month view opens on today's month; plans sit mid-month (around today, clamped to days 2..26) so every date is in it.
const day = (n) => { const t = new Date(); const d = new Date(t.getFullYear(), t.getMonth(), Math.min(26, Math.max(2, t.getDate())) + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('actual Chromium calendar pointer drag persists its full date range', async () => {
  const { tenancy } = await import('../board/hub/test/tenancy/fixture.js');
  const f = await tenancy({ config: { webDir:path.resolve(__dirname,'../board/web') } });
  let browser;
  try {
    const u=f.users.amember;
    const own=await f.as(u,'POST',`/api/boards/${f.A.board}/cards`,{title:'Pointer planner fixture',repo_id:f.A.repo});
    expect(own.status).toBe(200); const id=own.body.card.id;
    const planned=await f.as(u,'PATCH',`/api/cards/${id}/planning`,{request_id:randomUUID(),version:own.body.card.version,start_date:day(-1),due_date:day(1)});
    expect(planned.status).toBe(200);
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1104,height:860},extraHTTPHeaders:{Authorization:`Bearer ${u.token}`}});
    const page=await context.newPage();
    // Calendar is behind the planner flag (a84e1d1d) and sits in the Advanced views group, so open it by deep link.
    await page.goto(`${f.h.base}/?board=${f.A.board}&planner=1&view=calendar`);
    await expect(page.locator('.calendar-grid')).toBeVisible();
    await page.locator(`[data-planning-card="${id}"]`).dragTo(page.locator(`[data-planning-day="${day(3)}"]`));
    await expect.poll(()=>f.h.hub.card(id).due_date).toBe(day(3));
    expect(f.h.hub.card(id).start_date).toBe(day(1));
    await page.reload();
    await expect(page.locator(`[data-planning-day="${day(3)}"]`)).toContainText('Pointer planner fixture');
  } finally { await browser?.close();await f.h.close(); }
});
