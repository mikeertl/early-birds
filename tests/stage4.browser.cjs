// Stage 4 walkthrough across independent browsers, using isolated shared data.
// Synthetic credentials only; external requests and production writes are blocked.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchBrowser } = require('./browser-helper.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const users=JSON.parse(await fs.readFile(path.join(root,'data/users.json'),'utf8'));
  const files={'data/users.json':users,'data/current.json':{version:1,updatedAt:'2026-10-15T07:59:00Z',updatedBy:'mike-ertl',courts:[],bagels:[]}};
  const revisions={'data/users.json':1,'data/current.json':1};
  let clock='2026-10-15T07:59:00Z',denied=0,writes=0,browser;
  const checks=[];
  const check=(ok,label)=>{assert(ok,label);checks.push(label);console.log('PASS: '+label);};
  const server=http.createServer(async(req,res)=>{
    const json=(data,status=200)=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(data));
    try {
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(pathname==='/clock') return json(clock);
      if(pathname.startsWith('/mock/')) {
        const marker=pathname.indexOf('/contents/');
        if(marker<0) return json({full_name:'mikeertl/early-birds'});
        const file=decodeURIComponent(pathname.slice(marker+10));
        if(!Object.hasOwn(files,file)) return json({},404);
        if(req.method==='PUT') {
          let raw='';for await(const chunk of req) raw+=chunk;
          const body=JSON.parse(raw);writes++;
          if(denied) {denied--;return json({},403);}
          if(body.sha!==String(revisions[file])) return json({},409);
          files[file]=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));revisions[file]++;
          return json({content:{sha:String(revisions[file])}});
        }
        return json({type:'file',encoding:'base64',sha:String(revisions[file]),content:Buffer.from(JSON.stringify(files[file])).toString('base64')});
      }
      if(Object.hasOwn(files,pathname.slice(1))) return json(files[pathname.slice(1)]);
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!['index.html','config.js','model.js','store.js','auth.js','booking.js','bagels.js','users.js','games.js','app.js','styles.css','manifest.webmanifest'].includes(file)) return res.writeHead(404).end();
      res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'}).end(await fs.readFile(path.join(root,file)));
    } catch {if(!res.writableEnded) json({},500);}
  });
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    browser=await launchBrowser({url:'http://127.0.0.1:'+server.address().port+'/',source:`
      const realDate=Date;window.acceptanceClock='2026-10-15T07:59:00Z';
      window.Date=class extends realDate {constructor(...args){super(...(args.length?args:[window.acceptanceClock]));}static now(){return realDate.parse(window.acceptanceClock);}};
      const realFetch=window.fetch.bind(window);window.browserErrors=[];
      window.addEventListener('error',event=>window.browserErrors.push(event.message));
      window.addEventListener('unhandledrejection',()=>window.browserErrors.push('Unhandled rejection'));
      window.fetch=(url,options)=>{
        const target=new URL(url,location.href);
        if(target.origin==='https://api.github.com') return realFetch('/mock'+target.pathname+target.search,options);
        if(target.origin!==location.origin) throw new Error('External requests forbidden');
        return realFetch(url,options);
      };
      window.advanceClock=async()=>{window.acceptanceClock=await(await realFetch('/clock')).json();};
    `});
    const admin=await browser.page(),player=await browser.page();
    async function signIn(page,id,isAdmin) {
      await page.evaluate(`document.getElementById('signInButton').click();document.getElementById('profileUser').value=${JSON.stringify(id)};document.getElementById('profileToken').value='synthetic-stage4-token';document.getElementById('profileAdmin').checked=${isAdmin};document.getElementById('profileForm').requestSubmit()`);
      await until(page,`window.EarlyBirdsAuth.getSession()?.userId===${JSON.stringify(id)} && !document.getElementById('refreshButton').disabled`);
    }
    async function refresh(page) {await page.evaluate('window.advanceClock().then(()=>window.EarlyBirdsStore.refresh()).then(()=>true)');}
    async function fields(page,winners,losers) {
      await page.evaluate(`(()=>{const values=${JSON.stringify({winners,losers})};document.getElementById('bagelFormat').value=values.winners.length===1?'singles':'doubles';document.getElementById('bagelFormat').dispatchEvent(new Event('change'));for(const [team,ids] of [['Winner',values.winners],['Loser',values.losers]])ids.forEach((id,i)=>{const field=document.getElementById('bagel'+team+(i+1));field.value=id;field.dispatchEvent(new Event('input',{bubbles:true}));});})()`);
    }
    async function submitSet(page,winners,losers) {
      await fields(page,winners,losers);
      await page.evaluate("document.getElementById('bagelForm').requestSubmit()");
      await until(page,"document.getElementById('bagelStatus').textContent.includes('Bagel saved')");
    }
    await signIn(admin,'mike-ertl',true);await signIn(player,'akiko',false);
    check(await player.evaluate("!window.EarlyBirdsAuth.getSession().isAdmin && document.getElementById('adminTabButton').hidden"),'Two independent sessions retain ordinary-player and Admin access');
    await admin.evaluate("document.getElementById('adminTabButton').click();document.getElementById('adminAddCourtButton').click();document.getElementById('courtNumber').value='1';document.getElementById('courtCode').value='001234';document.getElementById('courtForm').requestSubmit()");
    await until(admin,"!document.getElementById('courtDialog').open");
    const courtId=files['data/current.json'].courts[0].id;
    for(const id of ['akiko','arda','ellen']) {
      await admin.evaluate(`(()=>{const card=document.querySelector('#adminCourtsList [data-court-id="${courtId}"]'),select=card.querySelector('[data-admin-player-select]');select.value='${id}';select.dispatchEvent(new Event('change'));card.querySelector('.admin-add-player [data-admin-participation="green"]').click();})()`);
      await until(admin,`!document.getElementById('refreshButton').disabled && window.EarlyBirdsStore.getSnapshot().state.courts[0].green.includes('${id}')`);
    }
    check(files['data/current.json'].courts[0].green.length===4,'Admin creates today’s missed court and assigns four players using court controls');
    await refresh(player);
    check(await player.evaluate("!document.querySelector('#gamesList [data-bagel-court]')"),'Ordinary player cannot report before the one-hour game ends');
    clock='2026-10-15T08:00:00Z';await refresh(player);
    await player.evaluate(`document.querySelector('#gamesList [data-bagel-court="${courtId}"]').click()`);
    await until(player,"!document.getElementById('bagelFields').disabled");
    await fields(player,['akiko','mike-ertl'],['arda','ellen']);denied=1;
    await player.evaluate("document.getElementById('bagelForm').requestSubmit()");
    await until(player,"document.getElementById('saveBagelButton').textContent==='Retry save'");
    check(files['data/current.json'].bagels.length===0 && await player.evaluate("document.getElementById('bagelWinner1').value==='akiko' && document.getElementById('bagelLoser2').value==='ellen'"),'Rejected doubles submission retains the original choices without publishing a result');
    await player.evaluate("document.getElementById('saveBagelButton').click()");
    await until(player,"document.getElementById('bagelStatus').textContent.includes('Bagel saved')");
    await refresh(admin);
    check(await admin.evaluate("document.querySelectorAll('#bagelsList .bagel-card').length===1 && document.querySelector('#bagelsList .bagel-score').textContent.includes('Doubles')"),'Confirmed doubles persists and appears in the other browser after refresh');
    for(let n=0;n<2;n++) {
      await player.evaluate("document.getElementById('anotherBagelButton').click()");
      await submitSet(player,['arda'],['ellen']);
    }
    const records=files['data/current.json'].bagels;
    check(records.length===3 && new Set(records.map(b=>b.id)).size===3 && records.slice(1).every(b=>b.winners.length===1 && b.losers.length===1),'Two explicit carried-on singles sets can follow doubles with separate durable IDs');
    await player.evaluate("document.getElementById('closeBagelButton').click()");
    await refresh(admin);
    await admin.evaluate("document.getElementById('adminBagelsDetails').open=true;document.getElementById('historicalBagelButton').click()");
    await until(admin,"!document.getElementById('bagelFields').disabled");
    await admin.evaluate("document.getElementById('bagelDate').value='2026-10-14';document.getElementById('bagelDate').dispatchEvent(new Event('change'))");
    await submitSet(admin,['mike-ertl'],['akiko']);
    await admin.evaluate("document.getElementById('closeBagelButton').click()");
    check(files['data/current.json'].bagels.length===4 && files['data/current.json'].bagels[3].sourceCourtId===null,'Admin records a historical singles result without an existing court');
    await admin.evaluate("document.getElementById('adminPlayersDetails').open=true;document.querySelector('[data-player-id=\"akiko\"] [data-player-action=\"edit\"]').click();document.getElementById('playerName').value='Akiko renamed';document.getElementById('playerForm').requestSubmit()");
    await until(admin,"!document.getElementById('playerDialog').open");
    await admin.evaluate("document.querySelector('[data-player-id=\"ellen\"] [data-player-action=\"toggle\"]').click();document.getElementById('playerForm').requestSubmit()");
    await until(admin,"!document.getElementById('playerDialog').open");await refresh(player);
    check(await player.evaluate("document.getElementById('bagelsList').textContent.includes('Akiko renamed') && document.getElementById('bagelsList').textContent.includes('Ellen') && document.getElementById('sessionSummary').textContent==='Akiko renamed'") && files['data/current.json'].bagels[0].winners[0].name==='Akiko','Rename propagates to the other session while deactivation and saved historical names preserve results');
    clock='2026-10-16T09:00:00Z';await refresh(admin);await refresh(player);
    check(files['data/current.json'].courts.length===0 && files['data/current.json'].bagels.length===4 && await player.evaluate("!document.querySelector('#gamesList [data-bagel-court]') && document.querySelectorAll('#bagelsList .bagel-card').length===4"),'Next-day cleanup removes the court and ordinary reporting actions while retaining all four results');
    const target=records[0].id;
    await admin.evaluate("document.getElementById('manageBagelsButton').click()");
    await until(admin,"document.querySelectorAll('#bagelSearchResults button').length===4");
    await admin.evaluate(`document.querySelector('[data-delete-bagel-id="${target}"]').click();document.getElementById('backToBagelsButton').click()`);
    check(files['data/current.json'].bagels.length===4,'Cancelling Admin deletion leaves every result intact');
    denied=1;
    await admin.evaluate(`document.querySelector('[data-delete-bagel-id="${target}"]').click();document.getElementById('confirmBagelDeleteButton').click()`);
    await until(admin,"document.getElementById('confirmBagelDeleteButton').textContent==='Retry deletion'");
    await refresh(player);
    check(await player.evaluate("document.querySelectorAll('#bagelsList .bagel-card').length===4"),'Rejected Admin deletion remains unchanged in the other session');
    await admin.evaluate("document.getElementById('confirmBagelDeleteButton').click()");
    await until(admin,"document.getElementById('bagelDeleteStatus').textContent.includes('deleted')");await refresh(player);
    check(files['data/current.json'].bagels.length===3 && !files['data/current.json'].bagels.some(b=>b.id===target) && await player.evaluate("document.querySelectorAll('#bagelsList .bagel-card').length===3"),'Retried confirmed deletion removes exactly one set and converges across browsers');
    await admin.evaluate("document.getElementById('closeManageBagelsButton').click()");
    const visitor=await browser.page();await refresh(visitor);
    check(await visitor.evaluate("!window.EarlyBirdsAuth.getSession() && document.querySelectorAll('#bagelsList .bagel-card').length===3 && document.getElementById('adminTabButton').hidden"),'A new visitor session sees persistent history without Admin controls');
    check(await player.evaluate("window.EarlyBirdsAuth.getSession().userId==='akiko' && !window.EarlyBirdsAuth.getSession().isAdmin && window.browserErrors.length===0") && await admin.evaluate("window.EarlyBirdsAuth.getSession().userId==='mike-ertl' && window.EarlyBirdsAuth.getSession().isAdmin && window.browserErrors.length===0") && await visitor.evaluate('window.browserErrors.length===0'),'Independent identities remain correct with no uncaught browser errors');
    if(process.env.STAGE4_RESULT_PATH) await fs.writeFile(process.env.STAGE4_RESULT_PATH,JSON.stringify({task:'4.7',result:'passed',transport:'Local in-memory GitHub Contents simulator; synthetic credentials; no external requests or live writes',checks,writeAttempts:writes,finishedAt:new Date().toISOString(),productionDataChanged:false},null,2)+'\n');
    console.log('Stage 4 multi-session acceptance passed. No live data changed.');
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
async function until(page,expression) {
  for(let n=0;n<150;n++) {if(await page.evaluate(expression)) return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Timed out waiting for Stage 4 acceptance state: '+expression);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
