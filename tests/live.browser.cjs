// Local control page for real GitHub verification. No production configuration changes.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { launchBrowser } = require('./browser-helper.cjs');
const root = path.resolve(__dirname, '..');
let status = { running:false, checks:[], error:'', cleanup:[] };
let runConfig;
let barrier = [];
let base;
function check(ok, name) {
  if (!ok) throw new Error(name);
  status.checks.push(name);
  console.log('PASS: ' + name);
}
async function github(token, repository, file, method='GET', body) {
  const response = await fetch('https://api.github.com/repos/' + repository + (file ? '/contents/' + file : ''), {
    method, headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub returned HTTP '+response.status+' during '+method+'. Check test-repository access and Contents permissions.');
  return response.json();
}
async function run(token, repository) {
  status={running:true,checks:[],error:'',cleanup:[],repository,startedAt:new Date().toISOString()};
  const runId=randomUUID();
  const folder='verification/'+runId;
  const created=[];
  let browser;
  try {
    const metadata=await github(token,repository);
    check(metadata.full_name.toLowerCase()===repository.toLowerCase(),'Dedicated test repository accessible');
    const branch=metadata.default_branch || 'main';
    const users=JSON.parse(await fs.readFile(path.join(root,'data/users.json'),'utf8'));
    const state=JSON.parse(await fs.readFile(path.join(root,'data/current.json'),'utf8'));
    state.courts=[];state.bagels=[];
    runConfig={owner:repository.split('/')[0],repo:repository.split('/')[1],branch,
      usersPath:folder+'/users.json',statePath:folder+'/current.json',users,state,runId};
    for(const [file,data] of [[runConfig.usersPath,users],[runConfig.statePath,state]]) {
      await github(token,repository,file,'PUT',{branch,message:'Initialise isolated Early Birds verification',content:Buffer.from(JSON.stringify(data)).toString('base64')});
      created.push(file);
    }
    check(true,'Unique test files initialised; existing repository files untouched');
    browser=await launchBrowser({url:base+'/app/'});
    const a=await browser.page(), b=await browser.page();
    async function signIn(page,userId) {
      const result=await page.evaluate(`(async()=>{
        document.getElementById('signInButton').click();
        document.getElementById('profileUser').value=${JSON.stringify(userId)};
        document.getElementById('profileToken').value=${JSON.stringify(token)};
        document.getElementById('profileForm').requestSubmit();
        for(let i=0;i<150;i++) {
          const session=window.EarlyBirdsAuth.getSession();
          if(session) {await window.EarlyBirdsStore.refresh();return session.userId;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        return null;
      })()`);
      check(result===userId,'Real GitHub sign-in: '+userId);
    }
    await signIn(a,'mike-ertl'); await signIn(b,'akiko');
    check(await a.evaluate('window.EarlyBirdsAuth.getSession().userId')==='mike-ertl' &&
      await b.evaluate('window.EarlyBirdsAuth.getSession().userId')==='akiko','Two independent browser sessions retain different players');
    for(const page of [a,b]) await page.evaluate(`localStorage.setItem('longbourn-user-id','longbourn-sentinel');localStorage.setItem('longbourn-github-token','unrelated-sentinel');`);
    const tomorrow=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000));
    const booking={type:'court.add',court:{id:'live-court-'+runId,date:tomorrow,time:'08:00',courtNumber:1,code:'012345',bookedBy:'mike-ertl'}};
    const courtId=booking.court.id;
    await a.evaluate(`window.EarlyBirdsStore.mutate(${JSON.stringify(booking)}).then(()=>true)`);
    check(await b.evaluate(`window.EarlyBirdsStore.refresh().then(data=>data.state.courts.some(c=>c.id===${JSON.stringify(courtId)}))`),'Second session sees first session booking after refresh');
    await b.evaluate(`window.EarlyBirdsStore.mutate({type:'participation.set',courtId:${JSON.stringify(courtId)},status:'green'}).then(()=>true)`);
    check(await a.evaluate(`window.EarlyBirdsStore.refresh().then(data=>data.state.courts[0].green.includes('akiko'))`),'First session sees second session join after refresh');
    await Promise.all([a,b].map(page=>page.evaluate('window.holdNextWrite=true')));
    await Promise.all([a,b].map(page=>page.evaluate(`window.EarlyBirdsStore.mutate({type:'participation.set',courtId:${JSON.stringify(courtId)},status:'reserved'}).then(()=>true)`)));
    const conflicts=(await a.evaluate('window.liveConflicts'))+(await b.evaluate('window.liveConflicts'));
    check(conflicts>0,'Real GitHub SHA conflict observed and reconciled');
    check(await a.evaluate(`window.EarlyBirdsStore.refresh().then(data=>['mike-ertl','akiko'].every(id=>data.state.courts[0].reserved.includes(id)))`),'Both concurrent changes retained in GitHub');
    check(await a.evaluate(`(async()=>{
      window.failNextWrite=true;
      try{await window.EarlyBirdsStore.mutate({type:'participation.set',courtId:${JSON.stringify(courtId)},status:'green'});return false;}
      catch{return window.EarlyBirdsStore.getRecovery().outcome==='failed' && !document.getElementById('retrySaveButton').hidden;}
    })()`),'Injected rejected write retains input and offers retry');
    check(await b.evaluate(`window.EarlyBirdsStore.refresh().then(data=>!data.state.courts[0].green.includes('mike-ertl'))`),'Rejected write did not reach live shared data');
    await a.evaluate('window.EarlyBirdsStore.retry().then(()=>true)');
    check(await b.evaluate(`window.EarlyBirdsStore.refresh().then(data=>data.state.courts[0].green.includes('mike-ertl'))`),'Retry persists original change to GitHub and reaches second session');
    check(await a.evaluate(`(async()=>{document.getElementById('signOutButton').click();await new Promise(r=>setTimeout(r,100));return !window.EarlyBirdsAuth.getSession() && localStorage.getItem('longbourn-user-id')==='longbourn-sentinel' && localStorage.getItem('longbourn-github-token')==='unrelated-sentinel';})()`),'Sign-out preserves Longbourn storage');
    check(await b.evaluate('window.EarlyBirdsAuth.getSession().userId')==='akiko','Other independent browser session remains signed in');
  } catch(error) {
    // Errors from our helpers are fixed strings, not API bodies or CDP expressions.
    status.error=error.name==='TypeError' || error.name==='TimeoutError' ? 'Network or browser connection failed. Retry when available.' : error.message;
    console.log('Live verification did not complete. See the local result page.');
  } finally {
    if(browser) await browser.close().catch(()=>{status.error=status.error||'Browser cleanup failed.';});
    for(const file of created.reverse()) {
      try {
        const current=await github(token,repository,file+'?ref='+encodeURIComponent(runConfig.branch));
        await github(token,repository,file,'DELETE',{branch:runConfig.branch,sha:current.sha,message:'Remove isolated Early Birds verification data'});
        status.cleanup.push(file);
      } catch {status.error=status.error||'Test-file cleanup needs attention. Remove only the unique verification folder shown in the report.';}
    }
    status.folder=folder;
    status.finishedAt=new Date().toISOString();
    status.running=false;
    runConfig=null;
    await fs.writeFile(path.join(__dirname,'live-last-result.json'),JSON.stringify(status,null,2)+'\n');
  }
}
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Early Birds live verification</title><style>body{max-width:650px;margin:40px auto;padding:16px;font:16px system-ui;line-height:1.5}input,button{font:inherit;display:block;box-sizing:border-box;min-height:44px;width:100%;margin:8px 0 20px}pre{white-space:pre-wrap}</style>
<h1>Early Birds live verification</h1><p>Run two independent browser sessions against a dedicated GitHub test repository. Production files and Longbourn are excluded. A unique verification folder is created and removed; test commits remain in the test repository.</p>
<form id="setup"><label>Test repository (must end in -test)<input name="repository" value="mikeertl/early-birds-test" required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+-test"></label>
<label>Token with Contents: Read and write for that repository<input name="token" type="password" autocomplete="off" required></label><button>Run live checks</button></form>
<p>The token is used in memory and temporary isolated test browsers. Their profiles are removed after testing. It is not included in logs or the result file.</p><pre id="result" role="status"></pre>
<script>const form=document.getElementById('setup'),result=document.getElementById('result');form.addEventListener('submit',async event=>{event.preventDefault();const payload=Object.fromEntries(new FormData(form));form.elements.token.value='';try{const response=await fetch('/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});result.textContent=await response.text();}catch{result.textContent='Could not start checks.';}});setInterval(async()=>{try{const status=await(await fetch('/status')).json();if(status.running||status.finishedAt)result.textContent=JSON.stringify(status,null,2);}catch{}},1000);</script></html>`;
const server=http.createServer(async(request,response)=>{
  response.setHeader('Cache-Control','no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  try {
    if(request.headers.host!==new URL(base).host) {response.writeHead(403).end();return;}
    if(request.method==='POST' && request.headers.origin!==base) {response.writeHead(403).end();return;}
    if(request.url==='/status') {response.setHeader('Content-Type','application/json');response.end(JSON.stringify(status));return;}
    if(request.url==='/barrier' && request.method==='POST' && runConfig) {
      barrier.push(response);
      if(barrier.length===2) {barrier.splice(0).forEach(item=>item.end('ready'));}
      else setTimeout(()=>{if(!response.writableEnded){barrier=barrier.filter(item=>item!==response);response.writeHead(408).end();}},12000);
      return;
    }
    if(request.url==='/start' && request.method==='POST') {
      if(status.running){response.writeHead(409).end('A run is already active.');return;}
      let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>8192){response.writeHead(413).end();return;}}
      const input=JSON.parse(raw);
      if(typeof input.repository!=='string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-test$/.test(input.repository) || typeof input.token!=='string' || !input.token.trim()) {
        response.writeHead(400).end('Enter a dedicated repository ending in -test and its token.');return;
      }
      void run(input.token.trim(),input.repository).catch(()=>{status.running=false;status.error='Could not finish verification or save its report.';});
      response.writeHead(202).end('Started. Results will appear here.');return;
    }
    if(request.url==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);return;}
    if(request.url.startsWith('/app/') && runConfig) {
      const file=request.url.slice(5)||'index.html';
      if(file===runConfig.usersPath || file===runConfig.statePath){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(file===runConfig.usersPath?runConfig.users:runConfig.state));return;}
      if(["assets/early-birds.svg","assets/bagel.svg","assets/favicon.ico","assets/favicon.png","assets/apple-touch-icon.png","assets/icon-192.png","assets/icon-512.png","assets/icon-maskable-512.png"].includes(file)) {
        response.setHeader('Content-Type',file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'image/x-icon');
        response.end(await fs.readFile(path.join(root,file)));return;
      }
      const allowed=['index.html','styles.css','config.js','auth.js','model.js','store.js','booking.js','bagels.js','users.js','games.js','app.js','manifest.webmanifest'];
      if(!allowed.includes(file)){response.writeHead(404).end();return;}
      let content=await fs.readFile(path.join(root,file),'utf8');
      if(file==='config.js') content+=`\nwindow.EarlyBirdsConfig=Object.freeze({...window.EarlyBirdsConfig,github:Object.freeze(${JSON.stringify({owner:runConfig.owner,repo:runConfig.repo,branch:runConfig.branch,usersPath:runConfig.usersPath,statePath:runConfig.statePath})}),storageKeys:Object.freeze(Object.fromEntries(Object.entries(window.EarlyBirdsConfig.storageKeys).map(([key,value])=>[key,value.replace('early-birds-','early-birds-live-${runConfig.runId}-')])))});`;
      response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webmanifest')?'application/manifest+json':'text/html');
      response.end(content);return;
    }
    response.writeHead(404).end('Not found');
  } catch {response.writeHead(400).end('Request could not be processed.');}
});
if(typeof WebSocket==='undefined'){console.error('Use Node.js 22+, or Node 20 with --experimental-websocket.');process.exit(1);}
server.on('error',()=>{console.error('Could not start the local runner. Choose another LIVE_TEST_PORT.');process.exitCode=1;});
process.on('SIGINT',()=>{
  if(status.running){console.log('A live run is active. Wait for test-file cleanup before stopping.');return;}
  server.close(()=>process.exit(0));
});
server.listen(Number(process.env.LIVE_TEST_PORT||8787),'127.0.0.1',()=>{base='http://127.0.0.1:'+server.address().port;console.log('Live verification setup: '+base);});
