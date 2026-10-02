const { test, expect, chromium } = require('@playwright/test');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

test('actual Chromium calendar pointer drag persists its full date range', async () => {
  const { tenancy } = await import('../board/hub/test/tenancy/fixture.js');
  const f = await tenancy({ config: { webDir:path.resolve(__dirname,'../board/web') } });
  let browser;
  try {
    const u=f.users.amember;
    const own=await f.as(u,'POST',`/api/boards/${f.A.board}/cards`,{title:'Pointer planner fixture',repo_id:f.A.repo});
    expect(own.status).toBe(200); const id=own.body.card.id;
    const planned=await f.as(u,'PATCH',`/api/cards/${id}/planning`,{request_id:randomUUID(),version:own.body.card.version,start_date:'2026-10-02',due_date:'2026-10-04'});
    expect(planned.status).toBe(200);
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1104,height:860},extraHTTPHeaders:{Authorization:`Bearer ${u.token}`}});
    const page=await context.newPage();
    await page.goto(`${f.h.base}/?board=${f.A.board}`);
    await page.getByRole('button',{name:'Calendar',exact:true}).click();
    await expect(page.locator('.calendar-grid')).toBeVisible();
    await page.locator(`[data-planning-card="${id}"]`).dragTo(page.locator('[data-planning-day="2026-10-06"]'));
    await expect.poll(()=>f.h.hub.card(id).due_date).toBe('2026-10-06');
    expect(f.h.hub.card(id).start_date).toBe('2026-10-04');
    await page.reload();
    await expect(page.locator(`[data-planning-day="2026-10-06"]`)).toContainText('Pointer planner fixture');
  } finally { await browser?.close();await f.h.close(); }
});
