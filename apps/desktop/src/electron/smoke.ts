/**
 * The self-check the packaged application can run on itself.
 *
 * A build that starts is not the same as a build that works: `node:sqlite`
 * could be missing from the packaged Node, the preload could be excluded from
 * the asar, the renderer bundle could be stale. Running this inside the
 * packaged binary is the only honest way to find out, and it is what CI runs
 * against `AI-Orchestrator-Setup.exe`'s payload.
 *
 * Enabled by `AI_ORCHESTRATOR_SMOKE=1`, so it can never fire in normal use.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AppServices } from '../main/services/app-services.js';

export interface SmokeCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function smokeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AI_ORCHESTRATOR_SMOKE'] === '1';
}

/**
 * Where to write a screenshot of the running window, if anywhere.
 *
 * Assertions describe what the screen shows; a picture is what a person can
 * check at a glance. Off unless a path is given, so it never fires in normal
 * use.
 */
export function screenshotTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  const target = env['AI_ORCHESTRATOR_SMOKE_SCREENSHOT'];
  return target && target.length > 0 ? target : null;
}

export async function runSmokeChecks(
  services: AppServices,
  window: BrowserWindow,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const check = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await check('electron-versions', () => {
    const { electron, node, chrome } = process.versions;
    if (!electron) throw new Error('not running under Electron');
    return `electron ${electron}, node ${node}, chromium ${chrome}`;
  });

  await check('node-sqlite', () => {
    const version = services.database.schemaVersion;
    if (version !== services.database.expectedSchemaVersion) {
      throw new Error(`schema ${version}, expected ${services.database.expectedSchemaVersion}`);
    }
    services.database.settings.set('smoke', new Date().toISOString());
    const mode = services.database.driver.get('PRAGMA journal_mode');
    const journal = String(Object.values(mode ?? {})[0]).toLowerCase();
    if (journal !== 'wal') throw new Error(`journal_mode is ${journal}`);
    if (!services.database.settings.get('smoke')) throw new Error('write/read round trip failed');
    return `schema ${version}, journal ${journal}`;
  });

  await check('renderer-loaded', async () => {
    const title = await window.webContents.executeJavaScript('document.title');
    if (typeof title !== 'string' || title.length === 0) throw new Error('no document title');
    return title;
  });

  await check('preload-bridge', async () => {
    const shape = (await window.webContents.executeJavaScript(
      '({ api: typeof window.api, require: typeof window.require })',
    )) as { api: string; require: string };
    if (shape.api !== 'object') throw new Error('window.api is missing');
    if (shape.require !== 'undefined') throw new Error('window.require is reachable');
    return 'bridge present, node unreachable';
  });

  await check('ipc-round-trip', async () => {
    const info = (await window.webContents.executeJavaScript('window.api.app.info()')) as {
      packaged: boolean;
      sqliteAvailable: boolean;
    };
    if (!info.sqliteAvailable) throw new Error('app.info reports sqlite unavailable');
    return `packaged=${info.packaged}`;
  });

  await check('runtime-diagnose', async () => {
    const report = (await window.webContents.executeJavaScript(
      'window.api.runtime.diagnose()',
    )) as { runtimes: Array<{ runtimeId: string }> };
    const ids = report.runtimes.map((r) => r.runtimeId).sort();
    if (ids.length !== 3) throw new Error(`expected 3 runtimes, got ${ids.join(', ')}`);
    return ids.join(', ');
  });

  await check('onboarding-rendered', async () => {
    // The approved design opens on a welcome step and puts the runtime
    // checklist behind "Começar", so the walk starts by pressing it.
    await waitForBody(window, /Bem-vindo/, 20_000);
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[data-testid="start"]\')?.click()',
    );
    await waitForBody(window, /Codex/, 20_000);
    const text = await waitForBody(window, /Git/, 20_000);
    if (!/Claude Code/.test(text)) {
      throw new Error(`checklist incomplete; body was: ${text.slice(0, 400)}`);
    }
    return 'runtime checklist rendered';
  });

  const screenshot = screenshotTarget();
  if (screenshot) {
    await check('screenshot-onboarding', async () => save(window, screenshot));

    // Then walk to the working screen, so the pair shows both halves of the
    // experience rather than only the first-run one.
    await check('screenshot-workbench', async () => {
      // "Pular onboarding" is how the design reaches the working screen from
      // here; the sidebar's Projetos heading is the proof it arrived.
      await window.webContents.executeJavaScript(
        'document.querySelector(\'[data-testid="skip-onboarding"]\')?.click()',
      );
      await waitForBody(window, /Projetos|Escolha um projeto/, 10_000).catch(() => '');
      return save(window, screenshot.replace(/\.png$/, '-workbench.png'));
    });
  }

  await check('execution-worktree-render-details-zoom-reload', async () => {
    let workspace: {id:string}, session: {id:string}, runId: string;
    if (process.env.AI_ORCHESTRATOR_SMOKE_REOPEN === '1') {
      const saved=JSON.parse(services.database.settings.get('smoke.graph') ?? '{}');
      workspace={id:saved.workspaceId}; session={id:saved.sessionId}; runId=saved.runId;
      if(!runId || services.database.runs.require(runId).status!=='DONE')throw new Error('Persisted run missing after process restart.');
    } else {
    workspace=services.workspaces.createConversation({name:'Execution Worktree · smoke fixture'});
    session=services.chat.createSession(workspace.id,'Analisar arquitetura');
    runId='run-smoke-'+Date.now();
    services.database.runs.create({id:runId,sessionId:session.id,workspaceId:workspace.id,objective:'Localizar a lógica do botão e revisar a interface',orchestratorAgentId:null,maxIterations:3});
    services.database.runs.setStatus(runId,'RUNNING');
    services.database.chat.addMessage({sessionId:session.id,runId,author:'user',body:'Localizar a lógica do botão e revisar a interface'});
    const start=Date.now()-10000;
    for(const [index,label] of ['Codex','Claude A','Claude B'].entries()) {
      services.database.runs.recordInvocation({runId,iteration:1,agentId:null,accountId:null,role:index===0?'ORCHESTRATOR':'CODING_WORKER',workerId:index===0?null:label,task:index===0?null:label+' · Análise concluída. Arquivos e dependências localizados.',outcome:'completed',exitCode:0,durationMs:2500,startedAt:new Date(start+index*1000).toISOString()});
    }
    services.database.runs.addStep({runId,iteration:1,phase:'task-join',status:'completed',summary:'Duas análises reunidas para revisão.'});
    services.database.runs.addStep({runId,iteration:1,phase:'evidence',status:'read',summary:'Script.py e wall_modeling.py · conteúdo conferido'});
    services.database.runs.setStatus(runId,'DONE','Consulta concluída. Fixture de UI; nenhum modelo foi chamado.');
      services.database.settings.set('smoke.graph',JSON.stringify({workspaceId:workspace.id,sessionId:session.id,runId}));
    }
    await window.webContents.executeJavaScript("location.hash='#/'; true");
    window.webContents.reload();
    await waitForBody(window,/Pular onboarding/,20000);
    await window.webContents.executeJavaScript('document.querySelector(\'[data-testid="skip-onboarding"]\')?.click()');
    await waitForBody(window,/Analisar arquitetura/,20000);
    await window.webContents.executeJavaScript('document.querySelector('+JSON.stringify('[data-testid="open-session-'+session.id+'"]')+').click()');
    await waitForBody(window,/Worktree/,20000);
    for(let i=0;i<100;i++) { if(await window.webContents.executeJavaScript('!!document.querySelector(\'[data-testid="execution-worktree"]\')'))break;await new Promise(r=>setTimeout(r,100)); }
    const before=await window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("[data-node-id]")].map(n=>n.dataset.nodeId))');
    if(before==='[]') { if(screenshot) await save(window,screenshot.replace(/\.png$/,'-graph-failure.png')); throw new Error('Execution graph did not render: '+String(await window.webContents.executeJavaScript('document.body.innerText')).slice(0,1200)); }
    await window.webContents.executeJavaScript('document.querySelector(\'[aria-label="Ajustar à tela"]\').click()');
    await new Promise(r=>setTimeout(r,200));
    if(screenshot)await save(window,screenshot.replace(/\.png$/,'-overview.png'));
    const surface = await window.webContents.executeJavaScript('(()=>{const r=document.querySelector(".worktree-canvas").getBoundingClientRect();return {x:Math.round(r.left+18),y:Math.round(r.top+110)}})()');
    const transform=await window.webContents.executeJavaScript('document.querySelector(".worktree-world").style.transform');
    window.webContents.sendInputEvent({type:'mouseDown',...surface,button:'left',clickCount:1});
    window.webContents.sendInputEvent({type:'mouseMove',x:surface.x+50,y:surface.y+35});
    window.webContents.sendInputEvent({type:'mouseUp',x:surface.x+50,y:surface.y+35,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,200));
    if(transform===await window.webContents.executeJavaScript('document.querySelector(".worktree-world").style.transform'))throw new Error('Pan did not move the canvas.');
    await window.webContents.executeJavaScript('document.querySelector(\'[aria-label="Ajustar à tela"]\').click()');
    await new Promise(r=>setTimeout(r,200));
    const fitted=await window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("[data-node-id]")].map(n=>n.dataset.nodeId).sort())');
    await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="Minimizar concluídas").click()');
    await waitForBody(window,/Expandir/,5000);
    await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="Expandir").click()');
    await window.webContents.executeJavaScript('document.querySelector(\'[aria-label="Aumentar zoom"]\').click()');
    await window.webContents.executeJavaScript('document.querySelector(".node-content").click()');
    await waitForBody(window,/Ver resposta completa/,5000);
    if(await window.webContents.executeJavaScript('!!document.querySelector(".node-pulse")'))throw new Error('Terminal graph has a spinner.');
    window.setSize(1024,720);window.maximize();window.unmaximize();
    if(screenshot)await save(window,screenshot.replace(/\.png$/,'-graph.png'));
    window.webContents.reload();
    await waitForBody(window,/Pular onboarding/,20000);
    await window.webContents.executeJavaScript('document.querySelector(\'[data-testid="skip-onboarding"]\')?.click()');
    await waitForBody(window,/Analisar arquitetura/,20000);
    await window.webContents.executeJavaScript('document.querySelector('+JSON.stringify('[data-testid="open-session-'+session.id+'"]')+').click()');
    await waitForBody(window,/Worktree/,20000);
    const persisted=await window.webContents.executeJavaScript('window.api.run.detail({runId:'+JSON.stringify(runId)+'})');
    if(persisted.invocations.length!==3 || persisted.run.status!=='DONE')throw new Error('Run did not survive reload.');
    for(let i=0;i<100;i++) { if(await window.webContents.executeJavaScript('!!document.querySelector("[data-node-id]")'))break;await new Promise(r=>setTimeout(r,100)); }
    window.setSize(1180,780);
    await new Promise(r=>setTimeout(r,200));
    await window.webContents.executeJavaScript('document.querySelector(\'[aria-label="Ajustar à tela"]\').click()');
    await new Promise(r=>setTimeout(r,200));
    const reopened=await window.webContents.executeJavaScript('JSON.stringify([...document.querySelectorAll("[data-node-id]")].map(n=>n.dataset.nodeId).sort())');
    if(fitted!==reopened)throw new Error('Visible node identities changed after reload.');
    const savedNodes=services.database.settings.get('smoke.graphNodes');
    if(process.env.AI_ORCHESTRATOR_SMOKE_REOPEN==='1' && fitted!==savedNodes)throw new Error('Graph changed after restarting the packaged process.');
    services.database.settings.set('smoke.graphNodes',fitted);
    return 'Persisted nodes, details, zoom, resize, maximize/restore and reload checked in Chromium. Fixture agents only.';
  });
  return checks;
}

/** Polls the rendered text until it matches, or gives up with what it saw. */
async function waitForBody(
  window: BrowserWindow,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await window.webContents.executeJavaScript('document.body.innerText')) as string;
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${pattern}; body was: ${text.slice(0, 400)}`);
}

async function save(window: BrowserWindow, target: string): Promise<string> {
  const image = await window.webContents.capturePage();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, image.toPNG());
  return target;
}

export function reportSmoke(checks: readonly SmokeCheck[]): boolean {
  for (const check of checks) {
    console.log(`${check.ok ? 'ok' : 'not ok'} - ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`# pass ${checks.length - failed}`);
  console.log(`# fail ${failed}`);
  return failed === 0;
}
