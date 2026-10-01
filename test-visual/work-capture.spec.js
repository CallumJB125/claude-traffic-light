// Actual emitter → main routing → authenticated hub → sandboxed board pane.
// All accounts, repository folders, sessions and userData are synthetic.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('reported Codex work creates a team card, unmatched work creates a personal card and review never becomes Done', async () => {
  const { tenancy } = await import('../board/hub/test/tenancy/fixture.js');
  const x = await tenancy({ config: { webDir: path.resolve(__dirname, '../board/web') } });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-work-capture-app-'));
  let app;
  try {
    const repo=path.join(temp,'repo'),home=path.join(temp,'hook-home');fs.mkdirSync(repo);fs.mkdirSync(home);
    execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'remote','add','origin','https://github.com/shared/app.git']);
    const user=x.users.amember;
    app=await electron.launch({args:[path.join(__dirname,'clients-fixture-main.js'),`--user-data-dir=${path.join(temp,'profile')}`],env:{...process.env,
      PLEXIFORM_CLIENT_TEST_HUB:x.h.base,PLEXIFORM_CLIENT_TEST_ACCOUNT:JSON.stringify({hub:x.h.base,token:user.token,device_id:user.device_id,user:{id:user.id,email:user.email}})}});
    await expect.poll(()=>app.evaluate(()=>global.__clientTestInit),{timeout:15000}).toMatchObject({stage:'connected',result:{ok:true}});
    expect(fs.realpathSync(await app.evaluate(({app})=>app.getPath('userData')))).toBe(fs.realpathSync(path.join(temp,'profile')));
    const emit=async (session,signal,cwd,title) => {
      execFileSync(process.execPath,[path.resolve(__dirname,'../hooks/emit.js'),signal,'--source','codex','--session',session,'--task','build','--cwd',cwd,'--title',title,'--summary','PRIVATE BRIEF'],
        {env:{...process.env,CLAUDE_TRAFFIC_LIGHT_HOME:home},input:''});
      const sessions=fs.readdirSync(path.join(home,'sessions')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(home,'sessions',n),'utf8')));
      await app.evaluate((_,events)=>global.__clientTestBuddy.sessionsChanged(events),sessions);
    };
    await emit('team-work','tool-use',repo,'Fix automatic routing');
    await expect.poll(()=>x.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n).toBe(1);
    const mapping=x.db.get('SELECT * FROM work_capture_cards'),card=x.h.hub.card(mapping.card_id);
    expect(mapping.board_id).toBe(x.A.board);expect(mapping.repo_id).toBe(x.A.repo);expect(card.body).toBe('');expect(card.run_state).toBeNull();
    await app.evaluate(()=>global.__clientTestBuddy.open('board'));
    const pane=js=>app.evaluate(async({webContents},[origin,code])=>{
      const wc=webContents.getAllWebContents().find(w=>w.getURL().startsWith(`${origin}/?`));return wc?await wc.executeJavaScript(code,true):null;
    },[x.h.base,js]);
    await expect.poll(()=>pane(`document.querySelector('.card[data-card-id="${card.id}"] .capture-report')?.textContent`),{timeout:15000}).toBe('Reported Codex · working');
    await emit('team-work','stop',repo,'Fix automatic routing');
    await expect.poll(()=>x.h.hub.card(card.id).column_name).toBe('in_review');
    expect(x.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n).toBe(1);expect(x.h.hub.card(card.id).run_state).toBeNull();
    await emit('personal-work','tool-use',temp,'Review personal notes');
    const localDb=path.join(temp,'profile','board','board.db');
    await expect.poll(async()=>JSON.stringify({exists:fs.existsSync(localDb),status:await app.evaluate(()=>global.__clientTestBuddy.status()),logs:await app.evaluate(()=>global.__clientTestLogs)}),{timeout:15000}).toContain('"exists":true');
    const {DatabaseSync:Database}=require('node:sqlite');
    await expect.poll(()=>{const db=new Database(localDb,{readOnly:true});try{return db.prepare('SELECT COUNT(*) AS n FROM work_capture_cards').get().n;}catch{return null;}finally{db.close();}},{timeout:15000}).toBe(1);
    const db=new Database(localDb,{readOnly:true});try{
      const local=db.prepare('SELECT c.* FROM cards c JOIN work_capture_cards w ON w.card_id=c.id').get();
      expect(local.repo_id).toBeNull();expect(local.title).toBe('Review personal notes');expect(local.column_name).toBe('in_progress');expect(local.run_state).toBeNull();
    }finally{db.close();}
    expect(x.db.get('SELECT COUNT(*) AS n FROM work_capture_cards').n).toBe(1);
    await app.evaluate(()=>global.__clientTestBuddy.open('thismac'));
    await expect.poll(()=>app.evaluate(()=>global.__clientTestBuddy.devPage('document.body.textContent'))).toContain('Automatic work cards');
    const text=await app.evaluate(()=>global.__clientTestBuddy.devPage('document.body.textContent'));
    expect(text).toContain('My board (this Mac)');expect(text).toContain('Fix automatic routing');expect(text).not.toContain(user.token);
    await emit('personal-work','tool-use',temp,'Updated personal task');
    await expect.poll(()=>app.evaluate(()=>global.__clientTestBuddy.devPage('document.body.textContent'))).toContain('Updated personal task');
  }finally{await app?.evaluate(()=>global.__clientTestBuddy.stop()).catch(()=>{});await app?.close();await x.h.close();fs.rmSync(temp,{recursive:true,force:true});}
});
