const { test, expect, chromium, _electron: electron } = require('@playwright/test');
const { windowByFile } = require('./app');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const port = () => new Promise(resolve => { const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const value=s.address().port;s.close(()=>resolve(value));}); });
async function fixture() {
  const cleanup=[],{communicationRig}=await import('../board/hub/test/communication-helpers.js'),{runHb}=await import('../board/hub/test/helpers.js');
  const f=await communicationRig({after:fn=>cleanup.push(fn)},{config:{webDir:path.resolve(__dirname,'../board/web')}});
  for(const [p,paths] of [[f.sender,['src/shared/**']],[f.recipient,['src/shared/ui.js']]]) {
    expect((await p.client.rpc(p.run,'board_declare_plan',{paths})).ok).toBe(true);
    await p.client.hb([runHb(p.run,{child_alive:true,cost_usd:null})]);
  }
  return {f,runHb,close:async()=>{for(const fn of cleanup.reverse())await fn();}};
}
async function exercise(page, f, runHb, runtime) {
  await page.locator(`[data-action="open"][data-card="${f.sender.run.card_id}"]`).first().click();
  await page.getByRole('tab',{name:'Coordination',exact:true}).click();
  const panel=page.locator('.task-ownership');
  await expect(panel).toContainText('Agent active · fresh host signal');
  await expect(panel).toContainText('Declared paths overlap');
  await expect(panel).toContainText('src/shared/ui.js');
  await expect(panel).not.toContainText('B-SECRET');
  await expect(page.locator('#sec-overlaps')).toContainText("admin's Codex");
  await expect(page.locator('#sec-overlaps')).not.toContainText("admin's Claude");
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.resolve(__dirname,`../work/ownership-visible-${runtime}.png`)});
  console.log(`Coordination ${runtime}: initial projection verified`);
  // The client must consume its relative lease while the supplied hub clock
  // is stationary. No server poll may revive it within this interval.
  f.h.hub.ownership.live.get(f.sender.run.run_id).deadline=f.h.hub.mono()+2000;
  await panel.getByRole('button',{name:'Refresh coordination',exact:true}).click();
  await expect(panel).toContainText('Agent active · fresh host signal');
  await expect(panel).toContainText('Heartbeat expired',{timeout:4000});
  await f.sender.client.hb([runHb(f.sender.run,{child_alive:true,cost_usd:null})]);
  await panel.getByRole('button',{name:'Refresh coordination',exact:true}).click();
  await expect(panel).toContainText('Agent active · fresh host signal');
  f.db.run('UPDATE members SET removed_at=? WHERE id=?',f.h.hub.iso(),f.A.admin);
  console.log(`Coordination ${runtime}: client expiry and renewed signal verified`);
  await panel.getByRole('button',{name:'Refresh coordination',exact:true}).click();
  await expect(panel).not.toContainText('src/shared/ui.js');
  await expect(panel).not.toContainText('Declared paths overlap');
  console.log(`Coordination ${runtime}: current peer removal verified`);
  await page.route('**/api/cards/*/ownership*',route=>route.abort('connectionfailed'));
  // The visible five-second poll must discover this real request failure.
  // A manual button can disappear when that poll wins the race.
  await expect(page.getByRole('button',{name:'Reload coordination',exact:true})).toBeVisible({timeout:8000});
  await expect(page.locator('[data-dialog="drawer"]')).not.toContainText('src/shared/**');
  console.log(`Coordination ${runtime}: network failure withholds old paths`);
  await page.unroute('**/api/cards/*/ownership*');
  console.log(`Coordination ${runtime}: failure route removed`);
  await page.getByRole('button',{name:'Reload coordination',exact:true}).click();
  await expect(panel).toContainText('src/shared/**');
  console.log(`Coordination ${runtime}: current network recovery verified`);
  // A current account revocation must clear the panel, not leave old paths.
  f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.device_id);
  await panel.getByRole('button',{name:'Refresh coordination',exact:true}).click();
  await expect.poll(async()=>page.isClosed() || !(await page.locator('body').textContent()).includes('src/shared/**')).toBe(true);
  if(!page.isClosed())await expect(page.locator('body')).not.toContainText(f.users.amember.token);
  console.log(`Coordination ${runtime}: account revocation clears or closes old view`);
}
test('actual installed Chrome coordination shows current declarations, expires and clears failed or revoked results',async()=>{
  const rig=await fixture();let browser;
  try {
    browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:1180,height:900},extraHTTPHeaders:{authorization:`Bearer ${rig.f.users.amember.token}`}}),page=await context.newPage();
    await page.goto(`${rig.f.h.base}/?board=${rig.f.A.board}`);
    await test.step('current paths, lease expiry, peer removal, request failure/recovery and account revocation',()=>exercise(page,rig.f,rig.runHb,'chrome'));
  }finally{await test.step('close synthetic Chrome and hub',async()=>{await browser?.close();await rig.close();});}
});
test('actual production Electron board coordination uses the same current authority and lease/error behavior',async()=>{
  const rig=await fixture(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'plexiform-ownership-ui-'));let app;
  try {
    const home=path.join(temp,'signals'),backups=path.join(temp,'backups'),projects=path.join(temp,'projects');
    for(const dir of [home,backups,projects,path.join(home,'sessions')])fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(home,'.help-shown'),'2000-01-01T00:00:00.000Z');
    fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({roam:false,randomEvents:false,seasonal:false,hints:{teamSeen:true}}));
    const u=rig.f.users.amember;
    app=await electron.launch({args:[path.join(__dirname,'planner-fixture-main.js'),'--demo','visual','--buddy-mock-accounts','--buddy','account'],env:{...process.env,
      CLAUDE_TRAFFIC_LIGHT_HOME:home,CLAUDE_TRAFFIC_LIGHT_BACKUPS:backups,CLAUDE_TRAFFIC_LIGHT_PROJECTS:projects,
      CLAUDE_TRAFFIC_LIGHT_PORT:String(await port()),CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT:String(await port()),
      PLEXIFORM_PLANNER_TEST_HUB:rig.f.h.base,PLEXIFORM_PLANNER_TEST_ACCOUNT:JSON.stringify({hub:rig.f.h.base,token:u.token,device_id:u.device_id,user:{id:u.id,email:u.email}})}});
    const profile=await app.evaluate(({app})=>app.getPath('userData'));expect(profile).toContain('plexiform-dev-');expect(profile).not.toContain('/Library/Application Support');
    const account=await windowByFile(app,'account.html');await account.evaluate(()=>window.buddyAccount.go('hub'));await account.locator('input[name="url"]').fill(rig.f.h.base);await account.getByRole('button',{name:'Continue',exact:true}).click();
    const sidebar=await windowByFile(app,'sidebar.html');await expect(sidebar.locator('body')).toContainText('Alpha');await sidebar.evaluate(()=>window.buddy.select('board'));
    await expect.poll(()=>app.windows().find(p=>p.url().startsWith(`${rig.f.h.base}/?`))?.url()).toBeTruthy();
    const page=app.windows().find(p=>p.url().startsWith(`${rig.f.h.base}/?`));await test.step('current paths, lease expiry, peer removal, request failure/recovery and account revocation',()=>exercise(page,rig.f,rig.runHb,'electron'));
  }finally{await test.step('close synthetic Electron and hub',async()=>{await app?.close();await rig.close();fs.rmSync(temp,{recursive:true,force:true});});}
});
