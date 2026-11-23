// Independent browser sessions sharing an in-memory GitHub Contents simulator.
// No credentials, external requests or repository writes are used.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchBrowser } = require('./browser-helper.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  const users = JSON.parse(await fs.readFile(path.join(root,'data/users.json'),'utf8'));
  const seed = JSON.parse(await fs.readFile(path.join(root,'data/current.json'),'utf8'));
  const files = {'data/users.json':users,'data/current.json':{...seed,courts:[],bagels:[]}};
  const revisions = {'data/users.json':1,'data/current.json':1};
  let conflictCount=0, denied=0, barrier=null, browser;
  const checks=[];
  function check(ok,label) { assert(ok,label);checks.push(label);console.log('PASS: '+label); }
  const server=http.createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    function json(value,status=200) { response.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value)); }
    try {
      const pathname=new URL(request.url,'http://localhost').pathname;
      if(pathname.startsWith('/mock/')) {
        const marker=pathname.indexOf('/contents/');
        if(marker<0) {json({full_name:'mikeertl/early-birds'});return;}
        const file=decodeURIComponent(pathname.slice(marker+10));
        if(!Object.hasOwn(files,file)) {json({},404);return;}
        if(request.method==='PUT') {
          let raw='';for await(const chunk of request) raw+=chunk;
          const body=JSON.parse(raw);
          if(denied) {denied--;json({},403);return;}
          if(barrier) {
            const active=barrier;
            await new Promise(resolve=>{
              active.waiters.push(resolve);
              if(active.waiters.length===2) {clearTimeout(active.timer);barrier=null;active.waiters.forEach(release=>release());}
            });
          }
          if(body.sha!==String(revisions[file])) {conflictCount++;json({},409);return;}
          files[file]=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));revisions[file]++;
          json({content:{sha:String(revisions[file])}});return;
        }
        json({type:'file',encoding:'base64',sha:String(revisions[file]),content:Buffer.from(JSON.stringify(files[file])).toString('base64')});return;
      }
      if(Object.hasOwn(files,pathname.slice(1))) {json(files[pathname.slice(1)]);return;}
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!['index.html','config.js','model.js','store.js','auth.js','booking.js','bagels.js','users.js','games.js','app.js','styles.css','manifest.webmanifest','assets/early-birds.svg','assets/bagel.svg','assets/wood-grain.svg','assets/bagel.gif','assets/bagel-still.png','assets/favicon.ico','assets/favicon.png','assets/apple-touch-icon.png','assets/icon-192.png','assets/icon-512.png','assets/icon-maskable-512.png'].includes(file)) {response.writeHead(404).end();return;}
      const content=await fs.readFile(path.join(root,file));
      response.writeHead(200,{'Content-Type':file.endsWith('.gif')?'image/gif':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':file.endsWith('.ico')?'image/x-icon':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webmanifest')?'application/manifest+json':'text/html'}).end(content);
    } catch {if(!response.writableEnded) json({},500);}
  });
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base='http://127.0.0.1:'+server.address().port;
    browser=await launchBrowser({url:base+'/',source:`
      const actualFetch=window.fetch.bind(window);
      window.browserErrors=[];
      window.addEventListener('error',event=>window.browserErrors.push(event.message));
      window.addEventListener('unhandledrejection',()=>window.browserErrors.push('Unhandled rejection'));
      window.fetch=(url,options)=>{
        const target=new URL(url,location.href);
        if(target.origin==='https://api.github.com') return actualFetch('/mock'+target.pathname+target.search,options);
        if(target.origin!==location.origin) throw new Error('External requests are forbidden in this test');
        return actualFetch(url,options);
      };
    `});
    const pages={};
    for(const id of ['arda','ellen','dimitar','mike-ertl','akiko']) {
      const page=await browser.page();pages[id]=page;
      await page.evaluate(`(()=>{
        document.getElementById('signInButton').click();document.getElementById('profileUser').value=${JSON.stringify(id)};
        document.getElementById('profileToken').value='synthetic-stage3-token';document.getElementById('profileForm').requestSubmit();
      })()`);
      await until(page,`window.EarlyBirdsAuth.getSession()?.userId===${JSON.stringify(id)} && !document.getElementById('refreshButton').disabled`);
    }
    check(true,'Five independent browser sessions sign in with different players');
    const date='2099-10-15';
    async function add(page,number) {
      await page.evaluate(`(()=>{
        document.getElementById('addCourtButton').click();document.getElementById('courtDate').value='${date}';
        document.getElementById('courtNumber').value='${number}';document.getElementById('courtCode').value='012345';
        document.getElementById('courtForm').requestSubmit();
      })()`);
      await until(page,"!document.getElementById('courtDialog').open && !document.getElementById('refreshButton').disabled");
      return files['data/current.json'].courts.find(c=>c.courtNumber===number).id;
    }
    const first=await add(pages.arda,1),second=await add(pages.ellen,2);
    check(first!==second && files['data/current.json'].courts.length===2,'Booking forms create independent simultaneous courts and enrol each booker');
    const selector=(id,status)=>`document.querySelector('#gamesList [data-court-id="${id}"] [data-participation="${status}"]')`;
    async function refresh(page) { await page.evaluate('window.EarlyBirdsStore.refresh().then(()=>true)'); }
    async function click(page,id,status) {
      const control=selector(id,status);
      assert(await page.evaluate(`Boolean(${control} && !${control}.disabled)`),'Expected available '+status+' action');
      await page.evaluate(control+'.click()');
      await until(page,"!document.getElementById('refreshButton').disabled && !document.querySelector('#gamesList [data-participation]:disabled:not([data-overlap=\"true\"])')");
    }
    const court=id=>files['data/current.json'].courts.find(c=>c.id===id);
    await refresh(pages.ellen);
    check(await pages.ellen.evaluate(selector(first,'green')+'.disabled'),'Another simultaneous green place disables Add me');
    await click(pages.ellen,second,'reserved');await click(pages.ellen,first,'green');
    await refresh(pages.dimitar);await click(pages.dimitar,first,'green');
    check(court(first).green.length===3 && court(second).green.length===0 && court(second).reserved.includes('ellen'),'Voluntary reserve frees overlap while simultaneous reserve membership is retained');
    const racers=[pages['mike-ertl'],pages.akiko];await Promise.all(racers.map(refresh));
    barrier={waiters:[],timer:null};
    const active=barrier;
    active.timer=setTimeout(()=>{if(barrier===active){barrier=null;active.waiters.forEach(release=>release());}},5000);
    await Promise.all(racers.map(page=>click(page,first,'green')));
    check(conflictCount>0,'Two browser joins read the same SHA and encounter a forced Contents conflict');
    const winner=court(first).green.find(id=>['mike-ertl','akiko'].includes(id));
    const reserve=winner==='mike-ertl'?'akiko':'mike-ertl';
    check(court(first).green.length===4 && court(first).reserved.join(',')===reserve && new Set([...court(first).green,...court(first).reserved]).size===5,'Last-place race retains both players with four green and one reserve');
    check(await pages[reserve].evaluate(`document.querySelector('#gamesList [data-court-id="${first}"] .participation-status').textContent.includes('Another player took the last place')`),'Losing browser explains last-place outcome and shows reserve membership');
    await Promise.all(racers.map(refresh));
    check(await pages[winner].evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='${first}').reserved.includes('${reserve}')`),'Both sessions converge after refresh without lost membership');
    await click(pages[winner],first,'reserved');await refresh(pages[reserve]);
    check(court(first).green.length===3 && [winner,reserve].every(id=>court(first).reserved.includes(id)),'Choosing Reserve opens a place without automatically promoting another reserve');
    await click(pages[reserve],first,'green');await click(pages[reserve],first,'none');await refresh(pages[winner]);
    await click(pages[winner],first,'green');
    check(court(first).green.length===4 && court(first).green.includes(winner) && !court(first).reserved.includes(reserve) && !court(first).green.includes(reserve),'Reserve explicitly claims a place; removal and reclaim work across sessions');
    denied=1;await click(pages[winner],first,'reserved');
    check(court(first).green.includes(winner) && await pages[winner].evaluate("!document.getElementById('retrySaveButton').hidden && document.getElementById('saveError').textContent.includes('not saved')"),'Rejected write retains confirmed membership and offers retry');
    await pages[winner].evaluate("document.getElementById('retrySaveButton').click()");
    await until(pages[winner],"!document.getElementById('refreshButton').disabled && document.getElementById('retrySaveButton').hidden");
    await refresh(pages[reserve]);
    check(await pages[reserve].evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='${first}').reserved.includes('${winner}')`),'Retry reaches shared data and is visible in the other session');
    await pages.akiko.evaluate(`document.getElementById('addCourtButton').click()`);
    check(await pages.akiko.evaluate(`document.getElementById('courtLocationAlexandra').checked && document.getElementById('courtCode').required && !document.getElementById('courtCodeFields').hidden`),'New bookings default to Alexandra with a required code');
    check(await pages.akiko.evaluate(`document.getElementById('courtTime').options.length===15 && document.getElementById('courtTime').value==='08:00'`),'Alexandra retains hourly starts and the default time');
    await pages.akiko.evaluate(`document.getElementById('courtNumber').value='6';document.getElementById('courtLocationNuffield').click()`);
    check(await pages.akiko.evaluate(`(()=>{const times=Array.from(document.getElementById('courtTime').options).map(o=>o.value);return times.length===29 && times[0]==='07:00' && times[1]==='07:30' && times.at(-1)==='21:00' && document.getElementById('courtTime').value==='08:00';})()`),'Nuffield offers half-hour starts from 7am through 9pm and preserves an hourly selection');
    check(await pages.akiko.evaluate(`document.getElementById('courtNumber').value==='' && Array.from(document.getElementById('courtNumber').options).map(o=>o.value).join(',')===',1,2,3,4'`),'Nuffield offers only courts 1–4 and clears an Alexandra court 6 selection');
    await pages.akiko.evaluate(`document.getElementById('courtLocationAlexandra').click();document.getElementById('courtNumber').value='4';document.getElementById('courtLocationNuffield').click()`);
    check(await pages.akiko.evaluate(`document.getElementById('courtNumber').value==='4'`),'Switching locations preserves a valid court selection');
    await pages.akiko.evaluate(`(()=>{
      document.getElementById('courtDate').value='2099-10-16';
      document.getElementById('courtNumber').value='1';
      document.getElementById('courtLocationNuffield').click();
    })()`);
    check(await pages.akiko.evaluate(`document.getElementById('courtCodeFields').hidden && !document.getElementById('courtCode').required && document.getElementById('courtCode').disabled`),'Nuffield selection hides the code and removes its validation');
    await pages.akiko.evaluate(`document.getElementById('courtTime').value='07:30';document.getElementById('courtForm').requestSubmit()`);
    await until(pages.akiko, "!document.getElementById('courtDialog').open && !document.getElementById('refreshButton').disabled");
    const nuffield=files['data/current.json'].courts.find(c=>c.location==='nuffield');
    check(nuffield && nuffield.code==='' && nuffield.time==='07:30' && await pages.akiko.evaluate(`(()=>{
      const card=document.querySelector('#gamesList [data-court-id="${nuffield.id}"]');
      return card.querySelector('.game-location').textContent==='Nuffield' && card.querySelector('.game-time').textContent==='7:30am' && !card.querySelector('.game-code');
    })()`),'Nuffield saves without a code and shows its location beside time and court');
    await pages.akiko.setViewport(375,812);
    check(await pages.akiko.evaluate(`Array.from(document.querySelectorAll('#gamesList .game-meta')).every(meta=>{
      const rects=Array.from(meta.children).map(span=>span.getBoundingClientRect());
      return ['Alexandra','Nuffield'].includes(meta.querySelector('.game-location').textContent) &&
        rects.every(rect=>Math.abs(rect.top-rects[0].top)<1) && rects.at(-1).right<=375;
    })`),'Both venue names fit beside time and court on a 375px iPhone mini viewport');
    await pages.akiko.evaluate(`document.querySelector('#gamesList [data-court-id="${nuffield.id}"] [data-court-management="edit"]').click()`);
    check(await pages.akiko.evaluate(`document.getElementById('courtLocationNuffield').checked && document.getElementById('courtCodeFields').hidden && document.getElementById('courtTime').value==='07:30'`),'Editing a Nuffield booking restores its location');
    await pages.akiko.evaluate(`document.getElementById('courtLocationAlexandra').click()`);
    check(await pages.akiko.evaluate(`Array.from(document.getElementById('courtNumber').options).map(o=>o.value).join(',')===',1,2,3,4,5,6' && document.getElementById('courtNumber').value==='1'`),'Editing back to Alexandra restores courts 1–6 and keeps the selected valid court');
    check(await pages.akiko.evaluate(`document.getElementById('courtTime').value==='' && document.getElementById('courtTime').options.length===15`),'Switching a half-hour booking to Alexandra clears the time for an explicit hourly selection');
    await pages.akiko.evaluate(`document.getElementById('courtTime').value='08:00'`);
    check(await pages.akiko.evaluate(`document.getElementById('courtCode').required && !document.getElementById('courtForm').checkValidity()`),'Changing to Alexandra requires a code again');
    await pages.akiko.evaluate(`document.getElementById('courtCode').value='123456';document.getElementById('courtForm').requestSubmit()`);
    await until(pages.akiko, "!document.getElementById('courtDialog').open && !document.getElementById('refreshButton').disabled");
    check(court(nuffield.id).location==='alexandra' && court(nuffield.id).code==='123456','Location edits save with the appropriate access code');
    for(const [id,page] of Object.entries(pages)) {
      check(await page.evaluate(`window.EarlyBirdsAuth.getSession().userId==='${id}' && window.browserErrors.length===0`),'Independent identity retained without browser errors: '+id);
    }
    if(process.env.STAGE3_RESULT_PATH) await fs.writeFile(process.env.STAGE3_RESULT_PATH,JSON.stringify({task:'3.7',result:'passed',transport:'Local in-memory GitHub Contents simulator; no external requests or live writes',checks,conflicts:conflictCount,finishedAt:new Date().toISOString()},null,2)+'\n');
    console.log('Stage 3 multi-session acceptance checks passed. No live data changed.');
  } finally {
    if(barrier) {clearTimeout(barrier.timer);barrier.waiters.forEach(release=>release());}
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}
async function until(page,expression) {
  for(let n=0;n<150;n++) {if(await page.evaluate(expression)) return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('Timed out waiting for browser acceptance state: '+expression);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
