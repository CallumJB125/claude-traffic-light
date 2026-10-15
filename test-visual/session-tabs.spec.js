// Actual hook state -> capture routing -> authenticated local hub -> sandboxed
// drawer. Every folder, session, handover and account belongs to this fixture.
// No provider process, native clipboard or real account is used.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const Tap = require('../hooks/handover-tap.js');

const ROOT = path.resolve(__dirname, '..');
const GOAL = 'Keep messages bound to the selected session';
const PROGRESS = 'The selected session now retains its recorded response.';

test('captured session tabs show useful context and save only a reviewed explicit draft', async ({}, testInfo) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-session-tabs-'));
  const home = path.join(temp, 'hook-home'), profile = path.join(temp, 'profile'), repo = path.join(temp, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const sessionId = 'synthetic-session-tabs';
  const fixture = path.join(temp, 'fixture-main.js');
  fs.writeFileSync(fixture, `
    const {app}=require('electron');
    const fs=require('node:fs');const path=require('node:path');
    const {createBuddyWindow}=require(${JSON.stringify(path.join(ROOT, 'buddy-window'))});
    const Handover=require(${JSON.stringify(path.join(ROOT, 'src/session-handover'))});
    app.getAppPath=()=>${JSON.stringify(ROOT)};
    global.__sessionTabsLogs=[];
    app.whenReady().then(async()=>{
      let rows=[];
      const writer=Handover.create({rootDir:process.env.PLEXIFORM_SESSION_TABS_HOME,home:process.env.PLEXIFORM_SESSION_TABS_HOME,rows:()=>rows});
      const buddy=createBuddyWindow({isDev:true,handoverWriter:()=>writer,log:(...a)=>global.__sessionTabsLogs.push(a),
        openTimeline:()=>false,continueIn:async()=>({ok:false,cancelled:true})});
      global.__sessionTabsBuddy=buddy;
      global.__sessionTabsPublish=async sessions=>{
        rows=sessions.map(s=>({adapter:s.source,sessionId:s.sessionId,cwd:s.cwd,lastActiveMs:Date.parse(s.updatedAt)}));
        await writer.tick();buddy.sessionsChanged(sessions);
      };
      buddy.setCapture(true);buddy.open('board');global.__sessionTabsReady=true;
    }).catch(e=>{global.__sessionTabsError=e.message;});
    app.on('window-all-closed',()=>app.quit());
  `);
  let app;
  const database = path.join(profile, 'board', 'board.db');
  const query = sql => {
    if (!fs.existsSync(database)) return null;
    const db = new DatabaseSync(database, { readOnly: true });
    try { return db.prepare(sql).get(); } catch { return null; } finally { db.close(); }
  };
  const emit = async () => {
    Tap.record({ rootDir: home, adapter: 'codex', sessionId, cwd: repo, signal: 'prompt-submit', data: { prompt: GOAL } });
    Tap.record({ rootDir: home, adapter: 'codex', sessionId, cwd: repo, signal: 'tool-use', data: { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/selected-session.js') } } });
    execFileSync(process.execPath, [path.join(ROOT, 'hooks/emit.js'), 'tool-use', '--source', 'codex', '--session', sessionId,
      '--task', 'drawer', '--cwd', repo, '--title', 'Selected session context', '--summary', PROGRESS],
    { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home }, input: '' });
    const sessions = fs.readdirSync(path.join(home, 'sessions')).filter(n => n.endsWith('.json'))
      .map(n => JSON.parse(fs.readFileSync(path.join(home, 'sessions', n), 'utf8')));
    await app.evaluate((_, reports) => global.__sessionTabsPublish(reports), sessions);
  };
  try {
    app = await electron.launch({ args: [fixture, `--user-data-dir=${profile}`], env: { ...process.env, PLEXIFORM_SESSION_TABS_HOME: home } });
    await expect.poll(() => app.evaluate(() => ({ ready: global.__sessionTabsReady, error: global.__sessionTabsError })), { timeout: 15000 }).toEqual({ ready: true, error: undefined });
    await emit();
    await expect.poll(() => query('SELECT COUNT(*) n FROM work_capture_cards')?.n, { timeout: 15000 }).toBe(1);
    const card = query('SELECT c.* FROM cards c JOIN work_capture_cards w ON w.card_id=c.id');
    expect(card.run_state).toBeNull(); expect(card.body).toContain(GOAL); expect(card.body).toContain(PROGRESS);
    expect(card.body).toContain('src/selected-session.js');
    const pane = code => app.evaluate(async ({ webContents }, js) => {
      const target = webContents.getAllWebContents().find(w => /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()));
      return target ? target.executeJavaScript(js, true) : null;
    }, code);
    await expect.poll(() => pane(`document.querySelector('.card[data-card-id="${card.id}"] .card-open') !== null`), { timeout: 15000 }).toBe(true);
    await pane(`document.querySelector('.card[data-card-id="${card.id}"] .card-open').click()`);
    const panelText = () => pane('document.querySelector(".drawer .tabpanel")?.textContent');
    const choose = async tab => {
      await pane(`document.querySelector('.drawer [data-action="tab"][data-tab="${tab}"]').click()`);
      await expect.poll(() => pane('document.querySelector(".drawer [role=tab][aria-selected=true]")?.dataset.tab')).toBe(tab);
    };
    await expect.poll(panelText).toContain('Reported session activity');
    const activity = await panelText();
    expect(activity).toContain(GOAL); expect(activity).toContain(PROGRESS); expect(activity).toContain('src/selected-session.js');
    expect(activity).not.toContain('No activity yet.');
    await choose('packet');
    await expect.poll(() => pane('!!document.querySelector("[data-action=packet-use-report]")')).toBe(true);
    expect(await pane('document.querySelector("[name=brief]").value')).toBe('');
    expect(query('SELECT COUNT(*) n FROM task_packets').n).toBe(0);
    await pane('document.querySelector("[data-action=packet-use-report]").click()');
    await expect.poll(() => pane('document.querySelector("[name=brief]").value')).toBe(GOAL);
    expect(await pane('document.querySelector("[name=progress]").value')).toBe(PROGRESS);
    expect(await pane('document.querySelector("[name=paths]").value')).toBe('src/selected-session.js');
    expect(await pane('[...document.querySelectorAll("[name=decisions], [name=reportedChecks], [name=nextAction]")].map(e=>e.value)')).toEqual(['', '', '']);
    expect(query('SELECT COUNT(*) n FROM task_packets').n).toBe(0);
    // An edit must survive moving between tabs and a refresh before Save.
    await pane('const input=document.querySelector("[name=brief]");input.value="Reviewed selected-session brief";input.dispatchEvent(new Event("input",{bubbles:true}))');
    await choose('activity'); await choose('packet');
    await pane('document.querySelector("[data-action=communication-reload]").click()');
    await expect.poll(() => pane('document.querySelector("[name=brief]").value')).toBe('Reviewed selected-session brief');
    expect(query('SELECT COUNT(*) n FROM task_packets').n).toBe(0);
    expect(await pane('document.querySelectorAll("[data-action=packet-use-report]").length')).toBe(0);
    await pane('document.querySelector("form[data-form=task-packet] button[type=submit]").click()');
    await expect.poll(() => query('SELECT COUNT(*) n FROM task_packets').n).toBe(1);
    const saved = JSON.parse(query('SELECT data FROM task_packets WHERE version=1').data);
    expect(saved.brief).toBe('Reviewed selected-session brief'); expect(saved.progress).toBe(PROGRESS);
    expect(saved.decisions).toEqual([]); expect(saved.reportedChecks).toEqual([]); expect(saved.nextAction).toBe('');
    await choose('messages');
    await expect.poll(panelText).toContain('do not enter this reported session');
    expect(await pane('document.querySelectorAll("[data-action=open-session]").length')).toBe(1);
    expect(await pane('document.querySelectorAll("form[data-form=task-message]").length')).toBe(0);
    await choose('ownership');
    await expect.poll(panelText).toContain('Reported file activity');
    expect(await panelText()).toContain('src/selected-session.js');
    expect(await panelText()).toContain('not ownership declarations or file locks');
    await choose('handover');
    await expect.poll(() => pane('document.querySelectorAll("[data-action=local-handover-refresh]").length')).toBe(1);
    for (const action of ['local-handover-copy', 'local-handover-save', 'open-timeline'])
      expect(await pane(`document.querySelectorAll('.tabpanel [data-action="${action}"]').length`)).toBe(1);
    expect(await pane('document.querySelectorAll(".tabpanel [data-action=continue-in]").length')).toBe(1);
    // A background renderer cannot open a native save dialog or export local
    // handover text. Actual native sheet focus restoration is checked manually.
    const exported = path.join(temp, 'synthetic-session-handover.md');
    await app.evaluate(({ dialog, BaseWindow }, destination) => {
      global.__sessionTabsSaveDialogs = 0;
      dialog.showSaveDialog = async () => {
        global.__sessionTabsSaveDialogs++;
        return { canceled: false, filePath: destination };
      };
      for (const window of BaseWindow.getAllWindows()) window.hide();
    }, exported);
    await pane('document.querySelector("[data-action=local-handover-save]").click()');
    await expect.poll(() => pane('document.body.textContent.includes("This local session is no longer available on this board.")')).toBe(true);
    expect(await app.evaluate(() => global.__sessionTabsSaveDialogs)).toBe(0);
    expect(fs.existsSync(exported)).toBe(false);
    await app.evaluate(() => global.__sessionTabsBuddy.open('board'));
    await choose('comments');
    expect(await pane('document.querySelectorAll("[name=for_agent]").length')).toBe(0);
    expect(await panelText()).toContain('Saved on this card.');
    // Persist a synthetic historical handoff through the same card-detail API.
    const db = new DatabaseSync(database);
    try {
      const board = db.prepare('SELECT org_id FROM boards WHERE id=?').get(card.board_id);
      const member = db.prepare('SELECT id FROM members WHERE org_id=? LIMIT 1').get(board.org_id);
      const repoId = randomUUID(), at = new Date().toISOString();
      db.prepare('INSERT INTO repos(id,org_id,canonical_url,short_name) VALUES(?,?,?,?)').run(repoId, board.org_id, 'github.com/synthetic/session-tabs', 'session-tabs');
      db.prepare('INSERT INTO memories(id,org_id,repo_id,kind,body,card_id,author_member_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), board.org_id, repoId, 'handoff', 'The previous agent recorded this handoff body.', card.id, member.id, at, at);
    } finally { db.close(); }
    await pane('document.querySelector("[data-action=close-drawer]").click()');
    await expect.poll(() => pane('document.querySelector(".drawer") === null')).toBe(true);
    await pane(`document.querySelector('.card[data-card-id="${card.id}"] .card-open').click()`);
    await expect.poll(() => pane('document.querySelector(".drawer")?.open')).toBe(true);
    await choose('details');
    await expect.poll(panelText).toContain('The previous agent recorded this handoff body.');
    expect(await panelText()).not.toContain('[object Object]');
    await choose('packet');
    await expect.poll(() => pane('document.querySelector("[name=brief]").value')).toBe('Reviewed selected-session brief');
    expect(await pane('document.querySelectorAll("[data-action=packet-use-report]").length')).toBe(0);
    expect(query('SELECT COUNT(*) n FROM task_packets').n).toBe(1);
    expect(query('SELECT COUNT(*) n FROM dispatches').n).toBe(0);
    expect(query('SELECT COUNT(*) n FROM runs').n).toBe(0);
    await expect.poll(() => pane('(()=>{const d=document.querySelector(".drawer");return Boolean(d?.open && getComputedStyle(d).opacity === "1" && d.getBoundingClientRect().width > 0);})()')).toBe(true);
    await pane('document.querySelector("[data-form=task-packet]").scrollIntoView({block:"start"});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const shot = await app.evaluate(async ({ webContents }) => {
      const w = webContents.getAllWebContents().find(w => /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()));
      return (await w.capturePage()).toPNG().toString('base64');
    });
    fs.writeFileSync(testInfo.outputPath('synthetic-session-context.png'), Buffer.from(shot, 'base64'));
  } finally {
    await app?.evaluate(() => global.__sessionTabsBuddy?.stop()).catch(() => {});
    await app?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
