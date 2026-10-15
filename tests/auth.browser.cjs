// Run a local preview first, then: node tests/auth.browser.cjs
// Uses synthetic tokens and intercepted GitHub responses; never writes to GitHub.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  if (typeof WebSocket === 'undefined') throw new Error('Browser checks require Node.js 22+ (or Node 20 with --experimental-websocket).');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'early-birds-auth-'));
  const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError;
  chrome.on('error', error => { launchError = error; });
  let ws;
  try {
    let port;
    for (let n = 0; n < 100; n++) {
      if (launchError) throw launchError;
      try {
        port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!port) throw new Error('Chrome did not start; set CHROME_BIN to your Chrome executable.');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callback = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) callback.reject(message.error);
        else callback.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    });
    async function cdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
        pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
      const realFetch = window.fetch.bind(window);
      window.tokenChecks = 0;
      window.mockFiles = {};
      window.mockWriteAttempts = 0;
      window.fetch = async (url, options = {}) => {
        if (!String(url).startsWith('https://api.github.com/')) {
          if (new URL(url, location.href).pathname.endsWith('/data/current.json')) {
            const data=await(await realFetch(url,options)).json();
            return new Response(JSON.stringify(window.fixtureState || {...data,courts:[],bagels:[]}));
          }
          if (new URL(url, location.href).pathname.endsWith('/data/users.json') && window.fixtureUsers) return new Response(JSON.stringify(window.fixtureUsers));
          return realFetch(url, options);
        }
        if (String(url).includes('/contents/')) {
          if (window.failShared) return new Response('{}', {status:503});
          const file = String(url).includes('users.json') ? 'data/users.json' : 'data/current.json';
          if (options.method === 'PUT') {
            window.mockWriteAttempts++;
            if (!window.allowWrites) throw new Error('Unexpected write');
            if (window.denySave) return new Response('{}', {status:403});
            if (window.racingState && file === 'data/current.json') {
              window.mockFiles[file]=JSON.stringify(window.racingState);window.racingState=null;
              return new Response('{}', {status:409});
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            window.mockFiles[file] = new TextDecoder().decode(Uint8Array.from(atob(JSON.parse(options.body).content), c=>c.charCodeAt(0)));
            if (window.loseAckOnce) {window.loseAckOnce=false;window.failShared=true;throw new TypeError('Simulated lost response');}
            return new Response(JSON.stringify({content:{sha:'test-sha'}}));
          }
          let data = window.mockFiles[file];
          if (!data) {
            const initial=await(await realFetch(file)).json();
            data=JSON.stringify(file==='data/current.json'?(window.fixtureState||{...initial,courts:[],bagels:[]}):(window.fixtureUsers||initial));
          }
          return new Response(JSON.stringify({ type:'file', encoding:'base64', content:btoa(String.fromCharCode(...new TextEncoder().encode(data))), sha:'test-sha' }));
        }
        if (options.method && options.method !== 'GET') throw new Error('Unexpected write');
        window.tokenChecks++;
        const token = options.headers.Authorization.replace('Bearer ', '');
        if (token === 'test-network') throw new TypeError('Never echo ' + token);
        if (token === 'test-slow') await new Promise(resolve => setTimeout(resolve, 300));
        const status = token === 'test-invalid' ? 401 : token === 'test-denied' ? 403 :
          token === 'test-hidden' ? 404 : token === 'test-unavailable' ? 503 : 200;
        return new Response('{}', { status });
      };
    ` });
    const url = process.env.TEST_URL || 'http://127.0.0.1:8000/';
    await cdp('Page.navigate', { url });
    for (let n = 0; n < 100; n++) {
      if (await evaluate('Boolean(window.EarlyBirdsUI && document.getElementById("profileUser").options.length === 10)')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const checks = await evaluate(`(async () => {
      const checks = [];
      const el = id => document.getElementById(id);
      const auth = window.EarlyBirdsAuth;
      const keys = window.EarlyBirdsConfig.storageKeys;
      function gameFixtures() {
        const base={durationMinutes:60,createdAt:'2026-10-15T08:00:00Z',createdBy:'mike-ertl',reserved:[]};
        return [
          {...base,id:'later',date:'2099-10-15',time:'13:00',courtNumber:3,code:'223344',bookedBy:'arda',green:[]},
          {...base,id:'simultaneous-b',date:'2099-10-14',time:'08:00',courtNumber:2,code:'654321',bookedBy:'akiko',green:['akiko'],reserved:['mike-ertl']},
          {...base,id:'simultaneous-a',date:'2099-10-14',time:'08:00',courtNumber:1,code:'012345',bookedBy:'mike-ertl',green:['mike-ertl','ellen'],reserved:['arda']},
        ];
      }
      window.gameFixtures=gameFixtures;
      const wait = () => new Promise(resolve => setTimeout(resolve, 30));
      function check(value, label) { if (!value) throw new Error(label); checks.push(label); }
      async function submit(token, user = 'mike-ertl', admin = false) {
        el('profileUser').value = user;
        el('profileToken').value = token;
        el('profileAdmin').checked = admin;
        el('profileForm').requestSubmit();
        await wait();
      }
      check(auth.getSession() === null && el('adminTabButton').hidden, 'visitor access');
      check(el('profileUser').options.length === 10, 'nine agreed players loaded');
      el('refreshButton').click(); await wait();
      check(el('dataStatus').textContent.includes('local preview') && !el('refreshButton').disabled, 'visitor refresh uses local preview JSON');
      check(window.EarlyBirdsStore.getSnapshot().users.users.length === 9, 'validated shared snapshot available');
      window.fixtureState={...window.EarlyBirdsStore.getSnapshot().state,courts:gameFixtures()};
      window.fixtureUsers=await(await fetch('data/users.json')).json();
      const literalName='<img src=x onerror="window.nameInjected=true">';
      window.fixtureUsers.users.find(u=>u.id==='ellen').name=literalName;
      window.fixtureUsers.users.find(u=>u.id==='ellen').active=false;
      await window.EarlyBirdsStore.refresh();
      const cards=[...document.querySelectorAll('.game-card')];
      check(cards.length===3 && cards.map(c=>c.dataset.courtId).join(',')==='simultaneous-a,simultaneous-b,later', 'cards sort by date/time/court and keep simultaneous courts separate');
      check(cards[0].querySelector('.game-date').textContent==='Wed 14 Oct 2099' && cards[0].querySelector('time').dateTime==='2099-10-14', 'exact calendar date format and semantic date');
      check(cards[0].querySelector('.game-time').textContent==='8:00am' && cards[2].querySelector('.game-time').textContent==='1:00pm', '12-hour morning and afternoon time formats');
      check(cards[0].querySelector('.game-court').textContent==='Court 1' && cards[0].querySelector('.game-booker').textContent==='Mike Ertl', 'court and booker shown');
      check(cards[0].querySelectorAll('.playing-player').length===2 && cards[0].querySelectorAll('.reserved-player').length===1 && cards[0].textContent.includes('Playing · 2 / 4') && cards[0].textContent.includes('Reserved · 1'), 'playing and reserve names have text-labelled groups');
      check(cards[2].textContent.includes('Nobody has joined yet.'), 'empty player list explained');
      check(cards[0].textContent.includes(literalName) && !cards[0].querySelector('img') && !window.nameInjected, 'inactive player names remain readable and markup is literal text');
      check(cards.every(c=>c.querySelector('.game-code').textContent.includes('Sign in')) && !el('gamesList').outerHTML.includes('012345') && !el('gamesList').outerHTML.includes('654321'), 'visitor cards contain no raw codes in text or attributes');
      window.fixtureUsers=null;await window.EarlyBirdsStore.refresh();
      document.querySelector('.game-card [data-participation="green"]').click();
      check(el('profileDialog').open && window.mockWriteAttempts===0, 'visitor participation requires sign-in without writing');
      el('cancelProfileButton').click();await wait();
      localStorage.setItem('longbourn-user-id', 'unrelated');
      const code = document.createElement('span'); document.body.appendChild(code);
      auth.renderCourtCode(code, '012345');
      check(!code.outerHTML.includes('012345') && code.textContent.includes('Sign in'), 'visitor code absent from DOM');
      el('addCourtButton').click();
      check(auth.getSession()===null && el('profileDialog').open && !el('courtDialog').open && el('profileError').textContent.includes('Sign in'), 'visitor Add Court requires sign-in');
      await submit('test-invalid');
      check(!auth.getSession() && el('profileError').textContent.includes('invalid') && el('profileToken').value === 'test-invalid', 'invalid token retains input; no sign-in');
      await submit('test-denied');
      check(!auth.getSession() && el('profileError').textContent.includes('denied'), 'denied token');
      await submit('test-hidden');
      check(!auth.getSession() && el('profileError').textContent.includes('404') && el('profileError').textContent.includes('Repository access'), 'hidden repository gives token-selection guidance');
      await submit('test-unavailable');
      check(!auth.getSession() && el('profileError').textContent.includes('HTTP 503'), 'GitHub outage distinguished from invalid token');
      await submit('test-network');
      check(!auth.getSession() && !el('profileError').textContent.includes('test-network') && el('profileError').textContent.includes('connection'), 'network error does not expose credential');
      await submit('test-valid');
      check(auth.getSession().userId === 'mike-ertl' && !el('profileDialog').open && el('adminTabButton').hidden, 'player sign-in');
      await wait();
      check(document.querySelector('.game-code').textContent==='*012345', 'signed-in card reveals exactly one star and leading zero');
      window.allowWrites=true;
      const game=id=>el('gamesList').querySelector('[data-court-id="'+id+'"]');
      const control=(id,status)=>game(id).querySelector('[data-participation="'+status+'"]');
      const membership=id=>window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id===id);
      async function place(id,status){control(id,status).click();await new Promise(r=>setTimeout(r,150));}
      check(!control('simultaneous-a','green') && control('simultaneous-a','none') && control('simultaneous-a','reserved'), 'green player gets Remove me and Reserve');
      check(control('simultaneous-b','green').disabled && control('simultaneous-b','none'), 'overlapping green place blocks reserve promotion');
      await place('simultaneous-a','reserved');
      check(!membership('simultaneous-a').green.includes('mike-ertl') && membership('simultaneous-a').reserved.includes('mike-ertl') && membership('simultaneous-a').reserved.includes('arda'), 'green player can reserve; existing reserves are not promoted');
      check(!control('simultaneous-b','green').disabled, 'moving to reserve opens an eligible Add me action');
      await place('simultaneous-b','green');
      check(membership('simultaneous-b').green.includes('mike-ertl') && !membership('simultaneous-b').reserved.includes('mike-ertl'), 'reserve can claim a free place without duplicate membership');
      await place('simultaneous-b','none');
      check(!membership('simultaneous-b').green.includes('mike-ertl'), 'green player can remove themselves');
      await place('simultaneous-a','green');await place('simultaneous-a','none');await place('simultaneous-a','reserved');
      check(membership('simultaneous-a').green.length===1 && membership('simultaneous-a').reserved.includes('mike-ertl'), 'Reserve explicitly stays yellow with open green places');
      await place('simultaneous-a','none');
      check(!membership('simultaneous-a').reserved.includes('mike-ertl'), 'yellow player can remove themselves');
      const fullState=JSON.parse(window.mockFiles['data/current.json']);
      fullState.courts.find(c=>c.id==='later').green=['akiko','arda','ellen','dimitar'];
      window.mockFiles['data/current.json']=JSON.stringify(fullState);await window.EarlyBirdsStore.refresh();
      const joinsBefore=window.mockWriteAttempts;
      control('later','green').click();control('later','green').click();await new Promise(r=>setTimeout(r,150));
      check(window.mockWriteAttempts===joinsBefore+1 && membership('later').green.length===4 && membership('later').reserved.filter(id=>id==='mike-ertl').length===1, 'full-court double join adds exactly one yellow reserve');
      check(!control('later','green') && control('later','none') && game('later').querySelector('.participation-status').textContent.includes('full'), 'full reserve sees Remove me and a clear outcome');
      async function externalChange(change, returning=false) {
        const state=JSON.parse(window.mockFiles['data/current.json']);change(state);
        window.mockFiles['data/current.json']=JSON.stringify(state);
        if(returning){window.dispatchEvent(new Event('focus'));await new Promise(r=>setTimeout(r,350));}
        else await window.EarlyBirdsStore.refresh();
      }
      await externalChange(state=>{state.courts.find(c=>c.id==='later').green.pop();},true);
      check(control('later','green') && !control('later','green').disabled && membership('later').reserved.includes('mike-ertl') && game('later').querySelector('.participation-help').textContent.includes('place is open'), 'returning to app reveals open place without promoting reserve');
      check(!game('later').querySelector('.participation-status').textContent.includes('full'), 'refresh clears obsolete full-court feedback');
      const raced=JSON.parse(window.mockFiles['data/current.json']);raced.courts.find(c=>c.id==='later').green.push('dimitar');window.racingState=raced;
      const attemptsBeforeRace=window.mockWriteAttempts;await place('later','green');
      check(window.mockWriteAttempts===attemptsBeforeRace+1 && membership('later').green.length===4 && membership('later').reserved.filter(id=>id==='mike-ertl').length===1 && game('later').querySelector('.participation-status').textContent.includes('Another player took the last place'), 'last-place SHA conflict refreshes full card and explains retained reserve');
      await externalChange(state=>{const c=state.courts.find(c=>c.id==='later');c.green=c.green.filter(id=>id!=='dimitar');c.reserved.push('dimitar');});
      check(control('later','green') && !control('later','green').disabled && membership('later').reserved.includes('dimitar'), 'another green player reserving opens Add me for existing reserve');
      await place('later','green');
      check(membership('later').green.includes('mike-ertl') && !membership('later').reserved.includes('mike-ertl') && membership('later').reserved.includes('dimitar'), 'eligible reserve explicitly claims open green place');
      await place('later','reserved');
      await externalChange(state=>{state.courts.find(c=>c.id==='later').green.push('dimitar');state.courts.find(c=>c.id==='later').reserved=state.courts.find(c=>c.id==='later').reserved.filter(id=>id!=='dimitar');});
      const staleOverlap=JSON.parse(window.mockFiles['data/current.json']);
      staleOverlap.courts.find(c=>c.id==='simultaneous-a').green.push('mike-ertl');window.mockFiles['data/current.json']=JSON.stringify(staleOverlap);
      const attemptsBeforeOverlap=window.mockWriteAttempts;await place('simultaneous-b','green');
      check(window.mockWriteAttempts===attemptsBeforeOverlap && control('simultaneous-b','green').disabled && game('simultaneous-b').querySelector('.participation-error').textContent.includes('Choose Reserve'), 'stale overlapping join is rejected without write and refreshed actions explain Reserve');
      window.denySave=true;await place('later','none');
      check(membership('later').reserved.includes('mike-ertl') && game('later').querySelector('.participation-error').textContent.includes('denied') && !el('retrySaveButton').hidden, 'failed membership change leaves colours and saved membership unchanged');
      window.denySave=false;el('retrySaveButton').click();await new Promise(r=>setTimeout(r,150));
      check(!membership('later').reserved.includes('mike-ertl') && game('later').querySelector('.participation-status').textContent.includes('removed'), 'global retry updates membership and card feedback');
      window.loseAckOnce=true;await place('later','reserved');
      check(window.EarlyBirdsStore.getRecovery().outcome==='uncertain' && [...document.querySelectorAll('[data-participation]')].every(button=>button.disabled), 'uncertain participation save blocks conflicting new actions');
      window.failShared=false;el('retrySaveButton').click();await new Promise(r=>setTimeout(r,150));
      check(membership('later').reserved.filter(id=>id==='mike-ertl').length===1 && !control('later','none').disabled, 'uncertain participation retry confirms one membership and unlocks controls');
      const management=(id,action)=>game(id).querySelector('[data-court-management="'+action+'"]');
      const adminManagement=(id,action)=>el('adminCourtsList').querySelector('[data-court-id="'+id+'"] [data-court-management="'+action+'"]');
      window.mockFiles['data/current.json']=JSON.stringify({...window.EarlyBirdsStore.getSnapshot().state,courts:gameFixtures()});await window.EarlyBirdsStore.refresh();
      check(management('simultaneous-a','edit') && management('simultaneous-a','delete') && !management('simultaneous-b','edit') && !management('later','delete'), 'ordinary booker sees management only for own court');
      management('simultaneous-a','edit').click();
      check(el('courtDialog').open && el('courtTitle').textContent==='Edit court' && el('courtDate').value==='2099-10-14' && el('courtCode').value==='012345' && el('courtBookerSelect').hidden && el('courtBooker').value==='Mike Ertl', 'edit prefills booking and keeps ordinary booker readonly');
      const editedPlayers=JSON.stringify([membership('simultaneous-a').green,membership('simultaneous-a').reserved]);
      el('courtCode').focus();el('courtCode').value='*001234';el('courtCode').dispatchEvent(new Event('input',{bubbles:true}));const editBefore=window.mockWriteAttempts;el('courtForm').requestSubmit();el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      check(!el('courtDialog').open && window.mockWriteAttempts===editBefore+1 && membership('simultaneous-a').code==='001234' && JSON.stringify([membership('simultaneous-a').green,membership('simultaneous-a').reserved])===editedPlayers, 'double edit saves once, normalises code and preserves membership');
      management('simultaneous-a','edit').click();el('courtCode').value='002345';
      const independent=JSON.parse(window.mockFiles['data/current.json']);independent.courts.find(c=>c.id==='simultaneous-a').courtNumber=3;window.racingState=independent;
      el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,200));
      check(!el('courtDialog').open && membership('simultaneous-a').courtNumber===3 && membership('simultaneous-a').code==='002345', 'edit conflict merges independent fields');
      management('simultaneous-a','edit').click();el('courtCode').value='003456';
      const sameField=JSON.parse(window.mockFiles['data/current.json']);sameField.courts.find(c=>c.id==='simultaneous-a').code='004567';window.mockFiles['data/current.json']=JSON.stringify(sameField);
      el('courtForm').requestSubmit();await wait();
      check(el('courtDialog').open && el('courtCode').value==='003456' && el('courtError').textContent.includes('edited by someone else') && !el('reloadCourtButton').hidden, 'same-field edit conflict keeps typed values and offers explicit review');
      el('reloadCourtButton').click();await wait();
      check(el('courtCode').value==='004567' && el('courtError').textContent==='', 'Load latest details explicitly replaces conflicting edit');
      el('courtCode').value='005678';window.denySave=true;el('courtForm').requestSubmit();await wait();el('closeCourtButton').click();management('simultaneous-a','edit').click();
      check(el('courtCode').value==='005678' && el('saveCourtButton').textContent.includes('Retry'), 'failed edit draft survives closing and reopening');
      window.denySave=false;el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      check(!el('courtDialog').open && membership('simultaneous-a').code==='005678', 'failed edit retries original change');
      management('simultaneous-a','edit').click();el('courtCode').value='006789';window.loseAckOnce=true;el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      check(el('courtDialog').open && el('courtFields').disabled && [...document.querySelectorAll('[data-court-management]')].every(button=>button.disabled), 'uncertain edit locks details and other management');
      window.failShared=false;el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
      check(!el('courtDialog').open && membership('simultaneous-a').code==='006789', 'uncertain edit reconciles without replacement');
      management('simultaneous-a','delete').click();const cancelBefore=window.mockWriteAttempts;
      check(el('courtTitle').textContent==='Delete court?' && el('courtFields').hidden && el('courtDescription').textContent.includes('Recorded bagels will be kept'), 'deletion requires named booking confirmation with history explanation');
      el('closeCourtButton').click();check(window.mockWriteAttempts===cancelBefore && membership('simultaneous-a'), 'cancelled deletion does not write');
      el('profileButton').click();await submit('', 'mike-ertl', true);await wait();
      check(!management('simultaneous-b','edit') && !management('later','delete') && adminManagement('simultaneous-b','edit') && adminManagement('later','delete'), 'Admin management of other bookers courts appears only in Admin tab');
      management('simultaneous-a','edit').click();
      check(el('courtBookerSelect').hidden, 'Games keeps own-booker editing without Admin ownership selector');
      el('closeCourtButton').click();el('adminTabButton').click();
      check(!el('adminPanel').hidden && el('gamesPanel').hidden && el('adminCourtsList').children.length===3, 'Admin tab displays all court management cards');
      adminManagement('simultaneous-b','edit').click();
      check(!el('courtBookerSelect').hidden && el('courtBooker').hidden && el('courtBookerSelect').value==='akiko', 'Admin gets booked-by selector');
      el('courtBookerSelect').value='arda';el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      check(!el('courtDialog').open && membership('simultaneous-b').bookedBy==='arda' && membership('simultaneous-b').green.join(',')==='akiko' && membership('simultaneous-b').reserved.join(',')==='mike-ertl', 'Admin changes ownership without enrolling or moving players');
      check(!el('adminPanel').hidden && el('adminPanel').contains(document.activeElement), 'Admin save keeps tab and focus in Admin');
      el('profileButton').click();await submit('', 'mike-ertl', false);await wait();
      check(el('adminCourtsList').children.length===0 && el('adminTabButton').hidden && !el('gamesPanel').hidden, 'leaving Admin clears management cards and returns to Games');
      management('simultaneous-a','delete').click();
      const deleteRace=JSON.parse(window.mockFiles['data/current.json']);deleteRace.courts.find(c=>c.id==='simultaneous-a').time='09:00';window.mockFiles['data/current.json']=JSON.stringify(deleteRace);
      el('courtForm').requestSubmit();await wait();
      check(el('courtDialog').open && el('courtError').textContent.includes('confirm deletion again'), 'changed booking requires renewed deletion confirmation');
      el('reloadCourtButton').click();await wait();
      check(el('courtDescription').textContent.includes('09:00'), 'deletion review shows updated booking details');
      window.denySave=true;el('courtForm').requestSubmit();await wait();
      check(el('courtDialog').open && membership('simultaneous-a') && el('courtError').textContent.includes('denied'), 'rejected deletion keeps court and offers retry');
      window.denySave=false;window.loseAckOnce=true;el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      check(el('courtDialog').open && !el('saveCourtButton').disabled && el('courtError').textContent.includes('not confirmed'), 'uncertain deletion remains open for reconciliation');
      window.failShared=false;el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
      check(!el('courtDialog').open && !game('simultaneous-a') && !membership('simultaneous-a'), 'booker deletion reconciles and removes card and participation');
      el('profileButton').click();await submit('', 'mike-ertl', true);await wait();
      el('adminTabButton').click();adminManagement('later','delete').click();el('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      check(!el('courtDialog').open && !membership('later') && membership('simultaneous-b'), 'Admin deletes another bookers court while preserving other games');
      el('profileButton').click();await submit('', 'mike-ertl', false);await wait();
      window.allowWrites=false;window.fixtureState=null;delete window.mockFiles['data/current.json'];await window.EarlyBirdsStore.refresh();
      check(!document.querySelector('.game-card') && el('gamesList').hidden, 'empty refresh removes old cards and restores empty state');
      check(el('dataError').textContent === '' && !el('dataStatus').textContent.includes('local preview'), 'sign-in refreshes GitHub data');
      window.failShared = true; el('refreshButton').click(); await wait();
      check(el('dataError').textContent.includes('could not complete') && window.EarlyBirdsStore.getSnapshot().users.users.length === 9, 'failed refresh preserves last good data and shows error');
      check(!el('staleNotice').hidden, 'failed refresh labels old data as stale');
      window.failShared = false; el('refreshButton').click(); await wait();
      check(el('dataError').textContent === '' && el('dataStatus').textContent.includes('refreshed'), 'refresh retry recovers');
      check(el('staleNotice').hidden, 'successful refresh clears stale notice');
      window.allowWrites = true;
      el('addCourtButton').click();
      check(el('courtDialog').open && el('courtBooker').value==='Mike Ertl' && el('courtBooker').readOnly, 'Add Court prefills signed-in booker');
      check(el('courtTime').value==='08:00' && el('courtDate').value==='' && el('courtNumber').value==='' && el('courtCode').value==='', 'booking defaults time only; other details required');
      check(el('courtTime').options[0].value==='07:00' && el('courtTime').options[14].value==='21:00' && el('courtNumber').options.length===7, 'agreed hourly times and six courts');
      el('nextWeekButton').click();
      const quick=[...el('courtQuickDates').querySelectorAll('button')];
      check(quick.length===7 && quick.every(button=>!button.disabled), 'next week offers seven future quick dates');
      quick[0].click(); check(el('courtDate').value>el('courtDate').min, 'quick date fills date picker');
      el('courtDate').value='2099-10-15';el('courtNumber').value='1';el('courtCode').value='123';
      const beforeInvalid=window.mockWriteAttempts; el('courtForm').requestSubmit(); await wait();
      check(el('courtDialog').open && window.mockWriteAttempts===beforeInvalid, 'invalid code never reaches a write');
      el('courtCode').focus();el('courtCode').value='*012345';el('courtCode').dispatchEvent(new Event('input',{bubbles:true}));
      check(el('courtCode').value==='012345', 'pasted star normalised and leading zero retained');
      const beforeSave=window.mockWriteAttempts;el('courtForm').requestSubmit();el('courtForm').requestSubmit();
      await new Promise(resolve=>setTimeout(resolve,150));
      check(!el('courtDialog').open && window.mockWriteAttempts===beforeSave+1, 'double submit creates exactly one booking and closes on confirmation');
      let created=window.EarlyBirdsStore.getSnapshot().state.courts;
      check(created.length===1 && created[0].bookedBy==='mike-ertl' && created[0].green.length===1 && created[0].green[0]==='mike-ertl' && created[0].code==='012345', 'saved court automatically enrols booker and stores six-digit code');
      el('addCourtButton').click();el('courtDate').value='2099-10-15';el('courtNumber').value='1';el('courtCode').value='123456';
      const beforeDuplicate=window.mockWriteAttempts;el('courtForm').requestSubmit();await wait();
      check(el('courtDialog').open && el('courtError').textContent.includes('already booked') && window.mockWriteAttempts===beforeDuplicate, 'duplicate court rejected without losing input');
      el('courtDate').value='2099-10-16';el('courtCode').value='001234';window.denySave=true;el('courtForm').requestSubmit();await wait();
      const retainedId=window.EarlyBirdsStore.getRecovery().action.court.id;
      check(el('courtDialog').open && el('courtCode').value==='001234' && el('courtDate').value==='2099-10-16', 'denied booking keeps typed form values');
      el('closeCourtButton').click();el('addCourtButton').click();
      check(el('courtCode').value==='001234' && el('saveCourtButton').textContent.includes('Retry'), 'closing failed form preserves its draft');
      window.denySave=false;el('courtForm').requestSubmit();await new Promise(resolve=>setTimeout(resolve,150));
      check(!el('courtDialog').open && window.EarlyBirdsStore.getSnapshot().state.courts.some(c=>c.id===retainedId && c.code==='001234'), 'form retry uses same booking ID and original values');
      el('addCourtButton').click();el('courtDate').value='2099-10-17';el('courtNumber').value='1';el('courtCode').value='002345';
      window.loseAckOnce=true;el('courtForm').requestSubmit();await new Promise(resolve=>setTimeout(resolve,150));
      check(el('courtDialog').open && el('courtFields').disabled && !el('saveCourtButton').disabled && el('courtError').textContent.includes('not confirmed'), 'uncertain save freezes details while allowing reconciliation');
      const unknownId=window.EarlyBirdsStore.getRecovery().action.court.id;
      window.failShared=false;el('courtForm').requestSubmit();await new Promise(resolve=>setTimeout(resolve,100));
      check(!el('courtDialog').open && window.EarlyBirdsStore.getSnapshot().state.courts.filter(c=>c.id===unknownId).length===1, 'uncertain booking reconciles without a duplicate');
      window.mockFiles['data/current.json']=await(await fetch('data/current.json')).text();await window.EarlyBirdsStore.refresh();
      window.allowWrites = true; window.denySave = true;
      const intent = {type:'court.add',court:{id:'browser-retry-court',date:'2099-10-14',time:'08:00',courtNumber:1,code:'012345',bookedBy:'mike-ertl'}};
      const saving = window.EarlyBirdsStore.mutate(intent);
      const completed = saving.catch(() => {});
      await wait();
      check(el('saveStatus').textContent === '' || !el('saveStatus').textContent.includes('saved'), 'no premature saved message');
      await completed;
      check(el('saveError').textContent.includes('not saved') && !el('retrySaveButton').hidden, 'failed save keeps intent and offers retry');
      intent.court.code = '999999';
      check(window.EarlyBirdsStore.getRecovery().action.court.code === '012345', 'stored retry intent preserves original input');
      el('refreshButton').click(); await wait();
      check(el('saveError').textContent.includes('not saved'), 'refresh does not erase failed-save outcome');
      window.denySave = false; el('retrySaveButton').click();
      await new Promise(resolve => setTimeout(resolve, 150));
      check(el('saveStatus').textContent.includes('saved') && el('saveError').textContent === '' && el('retrySaveButton').hidden, 'retry button confirms save and clears recovery');
      check(window.EarlyBirdsStore.getSnapshot().state.courts[0].code === '012345', 'retry saves original values');
      window.allowWrites = false;
      check(el('profileToken').value === '' && localStorage.getItem(keys.token) === 'test-valid', 'token saved locally and cleared from form');
      check(code.textContent === '*012345', 'signed-in code preserves zero and star');
      check(auth.requireWrite() && !auth.requireWrite({admin:true}), 'Admin-only change guard');
      await submit('', 'akiko', true);
      check(auth.getSession().userId === 'akiko' && auth.getSession().token === 'test-valid' && !el('adminTabButton').hidden, 'profile changes name/admin; blank keeps token');
      el('profileButton').click(); await submit('test-invalid');
      check(auth.getSession().userId === 'akiko', 'failed update preserves existing profile');
      el('cancelProfileButton').click(); await wait();
      el('profileButton').click(); await submit('', 'akiko', false);
      check(el('adminTabButton').hidden, 'profile can disable Admin');
      el('profileButton').click(); await submit('test-valid', 'akiko', true);
      el('adminTabButton').click(); el('signOutButton').click();
      check([...document.querySelectorAll('.game-code')].every(code=>code.textContent.includes('Sign in')), 'sign-out immediately remasks existing card codes');
      await wait();
      check(!auth.getSession() && el('adminTabButton').hidden && !el('gamesPanel').hidden, 'sign-out leaves Admin');
      check(localStorage.getItem(keys.token) === 'test-valid' && !localStorage.getItem(keys.userId) && !localStorage.getItem(keys.adminMode), 'sign-out retains token while clearing player/admin');
      check(code.textContent.includes('Sign in') && !code.outerHTML.includes('012345'), 'sign-out remasks code');
      check(localStorage.getItem('longbourn-user-id') === 'unrelated', 'Longbourn storage untouched');
      el('signInButton').click();
      check(el('profileToken').value === '' && !el('profileToken').required && el('tokenHelp').textContent.includes('saved'), 'saved token is reusable without exposing it in the input');
      await submit('', 'akiko');
      check(auth.getSession().token === 'test-valid', 'sign back in without pasting token');
      el('profileButton').click(); el('forgetTokenButton').click(); await wait();
      check(!auth.getSession() && !localStorage.getItem(keys.token), 'forget token signs out and removes credential');
      el('signInButton').click(); check(el('profileToken').required, 'forget token requires a new paste');
      el('cancelProfileButton').click(); await wait();
      el('signInButton').click();
      await submit('test-slow'); el('cancelProfileButton').click();
      await new Promise(resolve => setTimeout(resolve, 350));
      check(!auth.getSession(), 'cancel prevents late sign-in');
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function () { throw new DOMException('Blocked', 'SecurityError'); };
      el('signInButton').click(); await submit('test-valid');
      check(auth.getSession() && el('authStatus').textContent.includes('visit only'), 'storage failure permits visit-only session with warning');
      Storage.prototype.setItem = originalSet;
      el('signOutButton').click(); await wait();
      el('signInButton').click(); await submit('test-valid');
      const directory = await (await fetch('data/users.json')).json();
      directory.users.find(u => u.id === 'mike-ertl').active = false;
      auth.setUsers(directory);
      check(!auth.getSession() && ![...el('profileUser').options].some(o=>o.value==='mike-ertl'), 'deactivation signs out and removes choice');
      auth.setUsers(await (await fetch('data/users.json')).json());
      el('signInButton').click(); await submit('test-valid', 'akiko', true);
      return checks;
    })()`);
    console.log(checks.join('\n'));
    await cdp('Page.reload');
    for (let n = 0; n < 100; n++) {
      if (await evaluate('Boolean(window.EarlyBirdsAuth && window.EarlyBirdsAuth.getSession())')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await evaluate('window.EarlyBirdsAuth.getSession().userId'), 'akiko');
    assert.equal(await evaluate('document.getElementById("adminTabButton").hidden'), false);
    assert.equal(await evaluate('window.tokenChecks'), 1);
    console.log('Reload restores profile after checking token again');
    await evaluate(`localStorage.removeItem(window.EarlyBirdsConfig.storageKeys.userId); window.dispatchEvent(new StorageEvent('storage', {key: window.EarlyBirdsConfig.storageKeys.userId}));`);
    assert.equal(await evaluate('window.EarlyBirdsAuth.getSession()'), null);
    console.log('Cross-tab sign-out clears active session');
    await cdp('Page.reload');
    for (let n = 0; n < 100; n++) {
      if (await evaluate('Boolean(window.EarlyBirdsAuth && document.getElementById("profileUser").options.length === 10)')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await evaluate('window.EarlyBirdsAuth.getSession()'), null);
    assert.equal(await evaluate('localStorage.getItem(window.EarlyBirdsConfig.storageKeys.token)'), 'test-valid');
    console.log('Signed-out reload keeps token without restoring a player session');
    await evaluate('document.getElementById("signInButton").click()');
    for (const width of [320, 390, 768, 1280]) {
      await cdp('Emulation.setDeviceMetricsOverride', {width, height:850, deviceScaleFactor:1, mobile:width<540});
      assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      assert(await evaluate('document.getElementById("profileDialog").scrollWidth <= document.getElementById("profileDialog").clientWidth'));
      console.log(`Page and profile dialog fit ${width}px width`);
    }
    await evaluate(`(async()=>{
      document.getElementById('cancelProfileButton').click();await new Promise(r=>setTimeout(r,30));
      document.getElementById('signInButton').click();document.getElementById('profileUser').value='mike-ertl';
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      document.getElementById('addCourtButton').click();
    })()`);
    for (const width of [320, 390, 768, 1280]) {
      await cdp('Emulation.setDeviceMetricsOverride', {width, height:850, deviceScaleFactor:1, mobile:width<540});
      assert(await evaluate('document.getElementById("courtDialog").open'));
      assert(await evaluate('document.getElementById("courtDialog").scrollWidth <= document.getElementById("courtDialog").clientWidth'));
      assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      console.log(`Add Court dialog fits ${width}px width`);
      if (width===390 && process.env.TEST_SCREENSHOT_PATH) {
        const shot=await cdp('Page.captureScreenshot',{format:'png'});
        await fs.writeFile(process.env.TEST_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
      }
    }
    await evaluate(`(async()=>{
      document.getElementById('closeCourtButton').click();
      window.fixtureState={...window.EarlyBirdsStore.getSnapshot().state,courts:window.gameFixtures?window.gameFixtures():[
        {id:'layout-a',date:'2099-10-14',time:'08:00',durationMinutes:60,courtNumber:1,code:'012345',bookedBy:'mike-ertl',green:['mike-ertl','akiko'],reserved:['arda'],createdAt:'2026-10-15T08:00:00Z',createdBy:'mike-ertl'},
        {id:'layout-b',date:'2099-10-14',time:'08:00',durationMinutes:60,courtNumber:2,code:'654321',bookedBy:'ellen',green:['ellen'],reserved:[],createdAt:'2026-10-15T08:00:00Z',createdBy:'ellen'}
      ]};
      await window.EarlyBirdsStore.refresh();
      document.getElementById('signOutButton').click();await new Promise(r=>setTimeout(r,50));
      await window.EarlyBirdsStore.refresh();
    })()`);
    for (const width of [320, 390, 768, 1280]) {
      await cdp('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      assert(await evaluate(`(()=>{const card=document.querySelector('.game-card');const details=card.querySelector('.game-details').getBoundingClientRect();const players=card.querySelector('.game-players').getBoundingClientRect();return ${width}<620?players.top>=details.bottom:players.left>=details.right;})()`));
      console.log(`Game cards fit ${width}px; players ${width<620?'below details':'to the right'}`);
      if (process.env.TEST_GAMES_SCREENSHOT_PATH && width===390) {
        const shot=await cdp('Page.captureScreenshot',{format:'png'});
        await fs.writeFile(process.env.TEST_GAMES_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
      }
    }
    await evaluate(`(async()=>{
      document.getElementById('signInButton').click();document.getElementById('profileUser').value='mike-ertl';
      document.getElementById('profileAdmin').checked=true;document.getElementById('profileForm').requestSubmit();
      await new Promise(r=>setTimeout(r,150));
      document.getElementById('adminTabButton').click();
    })()`);
    for (const action of ['edit','delete']) {
      await evaluate(`document.querySelector('#adminCourtsList [data-court-management="${action}"]').click()`);
      for (const width of [320,390,768,1280]) {
        await cdp('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<540});
        assert(await evaluate('document.getElementById("courtDialog").open'));
        assert(await evaluate('document.getElementById("courtDialog").scrollWidth <= document.getElementById("courtDialog").clientWidth && document.documentElement.scrollWidth <= window.innerWidth'));
        console.log(`${action} court dialog fits ${width}px width`);
        if(action==='edit' && width===390 && process.env.TEST_MANAGEMENT_SCREENSHOT_PATH) {
          const shot=await cdp('Page.captureScreenshot',{format:'png'});
          await fs.writeFile(process.env.TEST_MANAGEMENT_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
        }
      }
      await evaluate('document.getElementById("closeCourtButton").click()');
    }
    const expiryState=await evaluate(`(()=>{
      const base={durationMinutes:60,time:'08:00',courtNumber:1,code:'012345',bookedBy:'mike-ertl',green:['mike-ertl'],reserved:[],createdAt:'2026-10-14T08:00:00Z',createdBy:'mike-ertl'};
      return {...window.EarlyBirdsStore.getSnapshot().state,courts:[
        {...base,id:'expiry-old',date:'2026-10-14'}, {...base,id:'expiry-today',date:'2026-10-15'}, {...base,id:'expiry-future',date:'2026-10-16'}
      ],bagels:[{id:'expiry-history',sourceCourtId:'expiry-old',date:'2026-10-14',winners:[{userId:'mike-ertl',name:'Mike before rename'}],losers:[{userId:'akiko',name:'Akiko before rename'}],createdAt:'2026-10-14T10:00:00Z',createdBy:'mike-ertl'}]};
    })()`);
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
      if(!sessionStorage.getItem('expiry-tests-started')) {
        localStorage.removeItem('early-birds-user-id');localStorage.removeItem('early-birds-admin-mode');
        sessionStorage.setItem('expiry-tests-started','yes');
      }
      const ClockDate=window.Date;
      window.expiryNow='2026-10-15T22:59:59.900Z';
      window.Date=class extends ClockDate {
        constructor(...args){super(...(args.length?args:[window.expiryNow]));}
        static now(){return new ClockDate(window.expiryNow).getTime();}
      };
      window.fixtureState=${JSON.stringify(expiryState)};
      window.allowWrites=Boolean(localStorage.getItem('early-birds-user-id'));
    `});
    async function reloadExpiry() {
      await cdp('Page.reload');await new Promise(r=>setTimeout(r,200));
      for(let n=0;n<60;n++) {
        if(await evaluate('Boolean(window.EarlyBirdsStore && window.EarlyBirdsStore.getSnapshot() && !document.getElementById("refreshButton").disabled)')) return;
        await new Promise(r=>setTimeout(r,50));
      }
      throw new Error('Expiry fixture did not finish loading');
    }
    await reloadExpiry();
    assert(await evaluate(`!document.querySelector('[data-court-id="expiry-old"]') && Boolean(document.querySelector('[data-court-id="expiry-today"]')) && window.mockWriteAttempts===0 && window.EarlyBirdsStore.getSnapshot().state.courts.length===3`));
    console.log('Visitor hides yesterday and keeps today completed, without writing');
    await evaluate(`window.expiryNow='2026-10-15T23:00:00.000Z'`);
    await new Promise(r=>setTimeout(r,250));
    assert(await evaluate(`!document.querySelector('[data-court-id="expiry-today"]') && Boolean(document.querySelector('[data-court-id="expiry-future"]')) && window.mockWriteAttempts===0 && window.EarlyBirdsStore.getSnapshot().state.bagels.length===1`));
    console.log('Open visitor page hides expired court at London midnight via timer, retaining bagels');
    await evaluate(`(async()=>{
      window.allowWrites=true;window.denySave=true;
      document.getElementById('signInButton').click();document.getElementById('profileUser').value='mike-ertl';document.getElementById('profileAdmin').checked=true;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,200));
    })()`);
    assert(await evaluate(`document.getElementById('cleanupNotice').textContent.includes('could not be saved') && document.getElementById('saveError').textContent==='' && !window.EarlyBirdsStore.getRecovery() && document.getElementById('adminCourtsList').children.length===1 && document.getElementById('gamesList').children.length===1`));
    console.log('Denied cleanup keeps expired courts hidden in Games/Admin and shows separate maintenance error');
    await evaluate(`(async()=>{window.denySave=false;window.loseAckOnce=true;document.getElementById('refreshButton').click();await new Promise(r=>setTimeout(r,200));})()`);
    assert(await evaluate(`document.getElementById('cleanupNotice').textContent.includes('not confirmed') && !window.EarlyBirdsStore.getRecovery()`));
    const cleanupWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{window.failShared=false;document.getElementById('refreshButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert.equal(await evaluate('window.mockWriteAttempts'),cleanupWrites);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.length===1 && window.EarlyBirdsStore.getSnapshot().state.bagels[0].winners[0].name==='Mike before rename' && document.getElementById('cleanupNotice').textContent===''`));
    console.log('Refresh reconciles unknown cleanup acknowledgement without another write or lost history');
    await reloadExpiry();
    assert.equal(await evaluate('window.EarlyBirdsStore.getSnapshot().state.courts.length'),2);
    await evaluate(`window.expiryNow='2026-10-15T23:00:00.000Z'`);await new Promise(r=>setTimeout(r,350));
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.length===1 && window.EarlyBirdsStore.getSnapshot().state.bagels.length===1 && document.getElementById('adminCourtsList').children.length===1`));
    console.log('Open signed-in page persists London midnight cleanup and preserves future court/history');
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.expiryNow='2026-10-15T07:59:59.900Z';
      window.fixtureState.courts.find(c=>c.id==='expiry-today').green=['mike-ertl','akiko'];
    `});
    await reloadExpiry();
    const gameBagel='#gamesList [data-bagel-court="expiry-today"]';
    const adminBagel='#adminCourtsList [data-bagel-court="expiry-today"]';
    assert(await evaluate(`!document.querySelector('${gameBagel}') && !document.querySelector('${adminBagel}') && !document.getElementById('historicalBagelButton').hidden`));
    console.log('Bagel action absent before game end; historical entry remains in Admin');
    await evaluate(`window.expiryNow='2026-10-15T08:00:00.000Z'`);await new Promise(r=>setTimeout(r,250));
    assert(await evaluate(`Boolean(document.querySelector('${gameBagel}') && document.querySelector('${adminBagel}'))`));
    console.log('Bagel action appears at one-hour end via local timer, including two-player singles');
    const bagelWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{document.querySelector('${gameBagel}').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('bagelDialog').open && document.getElementById('bagelEligibility').textContent.includes('Eligible') && !document.getElementById('bagelFields').disabled`));
    assert.equal(await evaluate('window.mockWriteAttempts'),bagelWrites);
    console.log('Bagel action rechecks shared data and opens the reporting form, without writing');
    for(const width of [320,390,768,1280]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate('document.getElementById("bagelDialog").scrollWidth <= document.getElementById("bagelDialog").clientWidth && document.documentElement.scrollWidth <= window.innerWidth'));
    }
    await evaluate(`(()=>{
      document.getElementById('closeBagelButton').click();
      const state=JSON.parse(window.mockFiles['data/current.json']);const court=state.courts.find(c=>c.id==='expiry-today');
      court.green=['akiko'];court.reserved=['mike-ertl'];window.mockFiles['data/current.json']=JSON.stringify(state);
    })()`);
    await evaluate(`(async()=>{document.querySelector('${gameBagel}').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('bagelEligibility').textContent.includes('no longer eligible') && document.getElementById('bagelFields').disabled && !document.querySelector('${gameBagel}') && Boolean(document.querySelector('${adminBagel}'))`));
    console.log('Stale Bagel action rejects changed green membership; Admin reporting stays in Admin');
    await evaluate(`(async()=>{
      document.getElementById('closeBagelButton').click();document.getElementById('adminTabButton').click();
      document.getElementById('historicalBagelButton').click();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`document.getElementById('bagelContext').textContent.includes('Historical entry') && document.getElementById('bagelEligibility').textContent.includes('Eligible')`));
    console.log('Admin historical action works without selecting a live court');
    await evaluate(`(async()=>{
      document.getElementById('closeBagelButton').click();document.getElementById('profileButton').click();
      document.getElementById('profileAdmin').checked=false;document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
      const state=JSON.parse(window.mockFiles['data/current.json']);state.courts.find(c=>c.id==='expiry-today').green=['mike-ertl','akiko'];state.courts.find(c=>c.id==='expiry-today').reserved=[];
      window.mockFiles['data/current.json']=JSON.stringify(state);await window.EarlyBirdsStore.refresh();
      window.failShared=true;document.querySelector('${gameBagel}').click();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`document.getElementById('bagelEligibility').textContent.includes('Could not check eligibility') && document.getElementById('bagelFields').disabled && document.getElementById('historicalBagelButton').hidden`));
    console.log('Failed eligibility refresh gives an error and never reports stale permission as confirmed');
    await evaluate(`(async()=>{
      window.failShared=false;document.getElementById('closeBagelButton').click();document.querySelector('${gameBagel}').click();await new Promise(r=>setTimeout(r,100));
      window.expiryNow='2026-10-15T23:00:00.000Z';window.dispatchEvent(new Event('focus'));await new Promise(r=>setTimeout(r,50));
    })()`);
    assert(await evaluate(`document.getElementById('bagelDialog').open && document.getElementById('bagelEligibility').textContent.includes('no longer eligible') && !document.querySelector('${gameBagel}')`));
    console.log('Open Bagel dialog and Games action expire at London midnight');
    await evaluate(`document.getElementById('signOutButton').click()`);
    assert(await evaluate(`!document.getElementById('bagelDialog').open && !document.querySelector('#gamesList [data-bagel-court]') && document.getElementById('historicalBagelButton').hidden`));
    console.log('Sign-out closes Bagel dialog and removes player/Admin entry actions');
    await evaluate(`(async()=>{
      window.expiryNow='2026-10-16T10:00:00.000Z';document.getElementById('signInButton').click();
      document.getElementById('profileUser').value='mike-ertl';document.getElementById('profileAdmin').checked=true;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,200));
      document.getElementById('adminTabButton').click();document.getElementById('adminAddCourtButton').click();
    })()`);
    assert(await evaluate(`document.getElementById('courtDialog').open && document.getElementById('courtDate').value==='2026-10-16' && document.getElementById('courtTime').value==='08:00' && !document.getElementById('courtBookerSelect').hidden`));
    console.log('Admin Add Court defaults to today at 08:00 and offers a booker selector');
    const missedWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{
      document.getElementById('courtNumber').value='2';document.getElementById('courtCode').value='001234';document.getElementById('courtBookerSelect').value='akiko';
      document.getElementById('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert.equal(await evaluate('window.mockWriteAttempts'),missedWrites+1);
    assert(await evaluate(`!document.getElementById('courtDialog').open && !document.getElementById('adminPanel').hidden && window.EarlyBirdsStore.getSnapshot().state.courts.some(c=>c.date==='2026-10-16' && c.time==='08:00' && c.courtNumber===2 && c.bookedBy==='akiko' && c.green.join(',')==='akiko')`));
    console.log('Admin saves an earlier-today court and enrols the selected booker');
    await evaluate(`(async()=>{
      const court=window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.courtNumber===2);
      document.querySelector('#adminCourtsList [data-court-id="'+court.id+'"] [data-court-management="edit"]').click();
      document.getElementById('courtCode').value='002345';document.getElementById('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      document.getElementById('gamesTabButton').click();document.getElementById('addCourtButton').click();
      document.getElementById('courtDate').value='2026-10-16';document.getElementById('courtNumber').value='3';document.getElementById('courtCode').value='003456';
      document.getElementById('courtForm').requestSubmit();await new Promise(r=>setTimeout(r,50));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.courtNumber===2).code==='002345' && document.getElementById('courtDialog').open && document.getElementById('courtError').textContent.includes('future')`));
    console.log('Admin can edit a missed court; regular Games booking still requires a future start');
    await evaluate(`document.getElementById('closeCourtButton').click();document.getElementById('adminTabButton').click();document.getElementById('adminAddCourtButton').click();document.getElementById('courtDate').value='2026-10-15'`);
    assert(await evaluate(`document.getElementById('courtDate').min==='2026-10-16' && !document.getElementById('courtDate').checkValidity()`));
    console.log('Admin backdating stops at today, preserving daily cleanup');
    await evaluate(`(async()=>{
      document.getElementById('closeCourtButton').click();document.getElementById('profileButton').click();document.getElementById('profileAdmin').checked=false;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
      const state=JSON.parse(window.mockFiles['data/current.json']);state.courts.forEach(c=>{c.green=c.id==='expiry-future'?['mike-ertl','akiko']:[];c.reserved=[];});
      window.mockFiles['data/current.json']=JSON.stringify(state);await window.EarlyBirdsStore.refresh();
      document.querySelector('#gamesList [data-bagel-court="expiry-future"]').click();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`!document.getElementById('bagelFields').disabled && document.getElementById('bagelFormat').value==='singles' && document.getElementById('bagelWinner1').options.length===3`));
    console.log('Two green players can report singles and selections exclude other players');
    await evaluate(`(()=>{document.getElementById('bagelWinner1').value='mike-ertl';document.getElementById('bagelLoser1').value='mike-ertl';document.getElementById('bagelForm').requestSubmit();})()`);
    assert(await evaluate(`document.getElementById('bagelError').textContent.includes('different player')`));
    const setsBefore=await evaluate('window.EarlyBirdsStore.getSnapshot().state.bagels.length');
    await evaluate(`(async()=>{document.getElementById('bagelLoser1').value='akiko';document.getElementById('bagelForm').requestSubmit();document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,150));})()`);
    assert.equal(await evaluate('window.EarlyBirdsStore.getSnapshot().state.bagels.length'),setsBefore+1);
    assert(await evaluate(`document.getElementById('bagelStatus').textContent.includes('Bagel saved') && document.getElementById('saveBagelButton').hidden && !document.getElementById('existingBagels').hidden`));
    console.log('Singles double-submit creates one durable set and switches to recorded-set review');
    await evaluate(`(async()=>{document.getElementById('closeBagelButton').click();document.querySelector('#gamesList [data-bagel-court="expiry-future"]').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('saveBagelButton').hidden && !document.getElementById('anotherBagelButton').hidden`));
    await evaluate(`(async()=>{
      document.getElementById('anotherBagelButton').click();document.getElementById('bagelWinner1').value='mike-ertl';document.getElementById('bagelLoser1').value='akiko';
      document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert.equal(await evaluate('window.EarlyBirdsStore.getSnapshot().state.bagels.length'),setsBefore+2);
    console.log('Explicit additional set permits identical teams with a new record ID');
    await evaluate(`(async()=>{
      document.getElementById('anotherBagelButton').click();document.getElementById('bagelWinner1').value='akiko';document.getElementById('bagelLoser1').value='mike-ertl';
      window.denySave=true;document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
    })()`);
    const deniedSetId=await evaluate('window.EarlyBirdsStore.getRecovery().action.bagel.id');
    await evaluate(`(async()=>{document.getElementById('closeBagelButton').click();document.querySelector('#gamesList [data-bagel-court="expiry-future"]').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('bagelWinner1').value==='akiko' && document.getElementById('saveBagelButton').textContent==='Retry save'`));
    await evaluate(`(async()=>{window.denySave=false;document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,150));})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels.filter(b=>b.id===${JSON.stringify(deniedSetId)}).length===1`));
    console.log('Rejected Bagel preserves selections across close/reopen and retries the same ID');
    await evaluate(`(async()=>{
      document.getElementById('anotherBagelButton').click();document.getElementById('bagelWinner1').value='mike-ertl';document.getElementById('bagelLoser1').value='akiko';
      window.loseAckOnce=true;document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getRecovery().outcome==='uncertain' && document.getElementById('bagelFields').disabled && !document.getElementById('saveBagelButton').disabled && document.getElementById('anotherBagelButton').disabled`));
    const uncertainSetId=await evaluate('window.EarlyBirdsStore.getRecovery().action.bagel.id');
    await evaluate(`(async()=>{window.failShared=false;document.getElementById('retrySaveButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels.filter(b=>b.id===${JSON.stringify(uncertainSetId)}).length===1 && document.getElementById('bagelStatus').textContent.includes('Bagel saved')`));
    console.log('Unknown Bagel acknowledgement locks details and global retry confirms one set');
    await evaluate(`(async()=>{
      const state=JSON.parse(window.mockFiles['data/current.json']);state.courts.find(c=>c.id==='expiry-future').green=['mike-ertl','akiko','arda','ellen'];window.mockFiles['data/current.json']=JSON.stringify(state);
      document.getElementById('refreshBagelButton').click();await new Promise(r=>setTimeout(r,100));document.getElementById('anotherBagelButton').click();
      document.getElementById('bagelFormat').value='doubles';document.getElementById('bagelFormat').dispatchEvent(new Event('change'));
      document.getElementById('bagelWinner1').value='mike-ertl';document.getElementById('bagelWinner2').value='akiko';document.getElementById('bagelLoser1').value='arda';document.getElementById('bagelLoser2').value='ellen';
      document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels.some(b=>b.sourceCourtId==='expiry-future' && b.winners.length===2 && b.losers.length===2 && b.date==='2026-10-16')`));
    console.log('Doubles records four distinct green players in equal teams with game date/source');
    await evaluate(`(async()=>{
      document.getElementById('closeBagelButton').click();document.getElementById('profileButton').click();document.getElementById('profileAdmin').checked=true;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));document.getElementById('adminTabButton').click();
      document.getElementById('historicalBagelButton').click();await new Promise(r=>setTimeout(r,100));
      document.getElementById('bagelDate').value='2026-10-17';
    })()`);
    assert(await evaluate(`!document.getElementById('bagelDate').checkValidity()`));
    await evaluate(`(async()=>{
      document.getElementById('bagelDate').value='2026-10-14';document.getElementById('bagelDate').dispatchEvent(new Event('change'));
      document.getElementById('bagelWinner1').value='ellen';document.getElementById('bagelLoser1').value='dimitar';document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels.some(b=>b.sourceCourtId===null && b.date==='2026-10-14' && b.winners[0].userId==='ellen' && b.losers[0].userId==='dimitar')`));
    console.log('Admin historical entry saves a past-date result with registered players and no court');
    await evaluate(`document.getElementById('anotherBagelButton').click()`);
    for(const width of [320,390,768,1280]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate('document.getElementById("bagelDialog").scrollWidth <= document.getElementById("bagelDialog").clientWidth && document.documentElement.scrollWidth <= window.innerWidth'));
    }
    console.log('Complete Bagel reporting form fits phone and desktop widths');
    if(process.env.TEST_BAGEL_SCREENSHOT_PATH) {
      await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
      const shot=await cdp('Page.captureScreenshot',{format:'png'});
      await fs.writeFile(process.env.TEST_BAGEL_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
    }
    await evaluate(`(async()=>{
      document.getElementById('closeBagelButton').click();document.getElementById('profileButton').click();document.getElementById('profileUser').value='akiko';document.getElementById('profileAdmin').checked=false;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
      document.querySelector('#gamesList [data-bagel-court="expiry-future"]').click();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`document.getElementById('bagelFields').hidden && document.getElementById('existingBagelsList').children.length>=5 && !document.getElementById('anotherBagelButton').disabled`));
    console.log('Another reporter sees existing sets and must explicitly start an additional set');
    const staleSetWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{
      document.getElementById('anotherBagelButton').click();document.getElementById('bagelWinner1').value='akiko';document.getElementById('bagelLoser1').value='mike-ertl';
      const state=JSON.parse(window.mockFiles['data/current.json']);state.courts.find(c=>c.id==='expiry-future').green=['mike-ertl','arda','ellen'];state.courts.find(c=>c.id==='expiry-future').reserved=['akiko'];
      window.mockFiles['data/current.json']=JSON.stringify(state);document.getElementById('bagelForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert.equal(await evaluate('window.mockWriteAttempts'),staleSetWrites);
    assert(await evaluate(`document.getElementById('bagelError').textContent.includes('green player') && document.getElementById('bagelWinner1').value==='akiko'`));
    await evaluate(`(async()=>{document.getElementById('refreshBagelButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('bagelFields').disabled && document.getElementById('bagelWinner1').value==='akiko' && document.getElementById('bagelEligibility').textContent.includes('no longer eligible')`));
    console.log('Bagel save rejects newly changed membership without writing or losing selections');
    const listWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{
      document.getElementById('closeBagelButton').click();
      const snapshot=window.EarlyBirdsStore.getSnapshot();
      const make=(id,date,createdAt,winners,losers)=>({id,date,createdAt,createdBy:'mike-ertl',sourceCourtId:'deleted-source',winners,losers});
      const mike={userId:'mike-ertl',name:'Mike historical'},akiko={userId:'akiko',name:'Akiko 鳥'},arda={userId:'arda',name:'Arda historical'},ellen={userId:'ellen',name:'Ellen before rename'};
      window.fixtureState={...snapshot.state,courts:[],bagels:[
        make('old-date','2026-10-13','2026-10-16T11:00:00Z',[mike],[akiko]),
        make('new-b','2026-10-16','2026-10-16T10:00:00.500Z',[mike,akiko],[arda,ellen]),
        make('new-zero','2026-10-16','2026-10-16T10:00:00Z',[akiko],[mike]),
        make('new-a','2026-10-16','2026-10-16T10:00:00.500Z',[{...mike,name:'Mike <img src=x onerror=alert(1)>'}],[akiko])
      ]};
      window.mockFiles['data/current.json']=JSON.stringify(window.fixtureState);
      const users={...snapshot.users,users:snapshot.users.users.map(u=>u.id==='ellen'?{...u,name:'Ellen current <img src=x onerror=alert(1)>',active:false}:u)};
      window.mockFiles['data/users.json']=JSON.stringify(users);
      await window.EarlyBirdsStore.refresh();document.getElementById('bagelsTabButton').click();
    })()`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#bagelsList > .bagel-card')].map(c=>c.dataset.bagelId)`),['new-a','new-b','new-zero','old-date']);
    assert.deepEqual(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels.map(b=>b.id)`),['old-date','new-b','new-zero','new-a']);
    console.log('Bagels sort newest game date first, then precise creation time and stable ID, without mutating shared order');
    assert(await evaluate(`!document.querySelector('#bagelsList').textContent.includes('Mike historical') && !document.querySelector('#bagelsList img') && !document.querySelector('#bagelsList').textContent.includes('Ellen before rename') && document.querySelector('#bagelsList').textContent.includes('Ellen current <img src=x onerror=alert(1)>') && window.EarlyBirdsStore.getSnapshot().state.bagels[1].losers[1].name==='Ellen before rename'`));
    console.log('Bagels display literal current names, including inactive/renamed players, while preserving saved names and deleted-court history');
    assert(await evaluate(`document.querySelector('[data-bagel-id="new-b"] .bagel-score').textContent==='6–0 · Doubles' && document.querySelector('[data-bagel-id="new-a"] .bagel-score').textContent==='6–0 · Singles' && document.querySelector('[data-bagel-id="new-b"] .bagel-winners').getAttribute('aria-label')==='Winners' && document.querySelector('[data-bagel-id="new-b"] .bagel-losers').getAttribute('aria-label')==='Losers' && document.querySelector('#bagelsList .bagel-icon').getAttribute('aria-hidden')==='true' && document.querySelector('#bagelsList .bagel-winners .bagel-face').textContent==='🙂' && document.querySelector('#bagelsList .bagel-losers .bagel-face').textContent==='🙁'`));
    assert(await evaluate(`getComputedStyle(document.querySelector('#bagelsList .bagel-winners .player-chip')).color!==getComputedStyle(document.querySelector('#bagelsList .bagel-losers .player-chip')).color`));
    console.log('Singles/doubles cards show bagel/date/score and labelled green winners with smiles and red losers with sad faces');
    await cdp('Emulation.setTimezoneOverride',{timezoneId:'Pacific/Kiritimati'});
    await evaluate('window.EarlyBirdsStore.refresh().then(()=>true)');
    assert(await evaluate(`document.querySelector('#bagelsList time').dateTime==='2026-10-16' && document.querySelector('#bagelsList time').textContent==='Fri 16 Oct 2026'`));
    console.log('Bagel calendar dates stay correct in a device timezone far from London');
    await evaluate(`(async()=>{window.failShared=true;document.getElementById('refreshButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.querySelectorAll('#bagelsList > .bagel-card').length===4 && !document.getElementById('staleNotice').hidden && document.getElementById('dataError').textContent!==''`));
    await evaluate(`(async()=>{window.failShared=false;document.getElementById('refreshButton').click();await new Promise(r=>setTimeout(r,100));document.getElementById('signOutButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`!window.EarlyBirdsAuth.getSession() && !document.getElementById('bagelsPanel').hidden && document.querySelectorAll('#bagelsList > .bagel-card').length===4`));
    console.log('Failed refresh retains last good Bagels list; visitors can view all retained results after sign-out');
    await evaluate(`(async()=>{
      window.fixtureState.bagels.find(b=>b.id==='new-a').winners[0].name='Mike historical';await window.EarlyBirdsStore.refresh();
    })()`);
    for(const width of [320,390,768,1280]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      assert(await evaluate(`(()=>{const card=document.querySelector('[data-bagel-id="new-b"]');const winners=card.querySelector('.bagel-winners').getBoundingClientRect();const losers=card.querySelector('.bagel-losers').getBoundingClientRect();return ${width}<=620?losers.top>=winners.bottom:losers.left>=winners.right;})()`));
      if(width===390 && process.env.TEST_BAGELS_SCREENSHOT_PATH) {
        const shot=await cdp('Page.captureScreenshot',{format:'png'});
        await fs.writeFile(process.env.TEST_BAGELS_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
      }
    }
    assert.equal(await evaluate('window.mockWriteAttempts'),listWrites);
    console.log('Bagels list fits phone and desktop widths; rendering, refreshing and visiting do not write');
    await evaluate(`(async()=>{window.fixtureState.bagels=[];await window.EarlyBirdsStore.refresh();})()`);
    assert(await evaluate(`document.getElementById('bagelsPanel').dataset.state==='empty' && document.getElementById('bagelsList').hidden && document.getElementById('bagelsList').children.length===0 && document.querySelector('#bagelsPanel [data-state-title]').textContent==='No bagels to show yet'`));
    console.log('Empty Bagels refresh removes old cards and shows the labelled empty state');
    assert(await evaluate(`document.getElementById('adminPlayersList').children.length===0 && document.getElementById('addPlayerButton').hidden`));
    await evaluate(`(async()=>{
      document.getElementById('signInButton').click();document.getElementById('profileUser').value='mike-ertl';document.getElementById('profileAdmin').checked=true;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,150));document.getElementById('adminTabButton').click();
    })()`);
    assert(await evaluate(`window.EarlyBirdsAuth.getSession().isAdmin && document.getElementById('adminPlayersList').children.length===9 && !document.getElementById('addPlayerButton').hidden`));
    console.log('Initial active player can choose Admin and manage active/inactive users; visitors have no controls');
    assert(await evaluate(`!document.getElementById('adminPlayersDetails').open && document.getElementById('adminPlayersTitle').textContent.includes('active players')`));
    await evaluate(`document.getElementById('adminPlayersTitle').click()`);
    assert(await evaluate(`document.getElementById('adminPlayersDetails').open`));
    console.log('Admin Players starts collapsed with active count and expands on demand');
    const usersBefore=await evaluate('window.EarlyBirdsStore.getSnapshot().users.users.length');
    await evaluate(`(async()=>{
      document.getElementById('addPlayerButton').click();document.getElementById('playerName').value='  Test Player 鳥  ';
      document.getElementById('playerForm').requestSubmit();document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    const playerId=await evaluate(`window.EarlyBirdsStore.getSnapshot().users.users.find(u=>u.name==='Test Player 鳥').id`);
    assert.equal(await evaluate('window.EarlyBirdsStore.getSnapshot().users.users.length'),usersBefore+1);
    assert(await evaluate(`!document.getElementById('playerDialog').open && [...document.getElementById('profileUser').options].some(o=>o.value===${JSON.stringify(playerId)})`));
    console.log('Admin creation trims Unicode name, generates one stable player and updates sign-in choices');
    await evaluate(`(async()=>{
      const state=JSON.parse(window.mockFiles['data/current.json']);state.courts=[{id:'management-court',date:'2026-10-16',time:'13:00',durationMinutes:60,courtNumber:1,code:'012345',bookedBy:${JSON.stringify(playerId)},green:[${JSON.stringify(playerId)}],reserved:['ellen'],createdAt:'2026-10-16T10:00:00Z',createdBy:'mike-ertl'}];
      state.bagels=[{id:'management-history',sourceCourtId:'management-court',date:'2026-10-15',winners:[{userId:${JSON.stringify(playerId)},name:'Test Player 鳥'}],losers:[{userId:'akiko',name:'Akiko historical'}],createdAt:'2026-10-15T10:00:00Z',createdBy:'mike-ertl'}];
      window.mockFiles['data/current.json']=JSON.stringify(state);await window.EarlyBirdsStore.refresh();
      document.querySelector('#adminPlayersList [data-player-id="${playerId}"] [data-player-action="edit"]').click();document.getElementById('playerName').value='Renamed Player 鳥';
      document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts[0].bookedBy===${JSON.stringify(playerId)} && document.querySelector('#gamesList .game-booker').textContent==='Renamed Player 鳥' && document.getElementById('bagelsList').textContent.includes('Renamed Player 鳥') && !document.getElementById('bagelsList').textContent.includes('Test Player 鳥') && window.EarlyBirdsStore.getSnapshot().state.bagels[0].winners[0].name==='Test Player 鳥'`));
    await evaluate(`(async()=>{document.getElementById('adminBagelsDetails').open=true;document.getElementById('manageBagelsButton').click();await new Promise(r=>setTimeout(r,100));document.getElementById('bagelSearch').value='Renamed Player';document.getElementById('bagelSearch').dispatchEvent(new Event('input'));})()`);
    assert(await evaluate(`document.querySelector('#bagelSearchResults button').textContent.includes('Renamed Player 鳥') && !document.querySelector('#bagelSearchResults button').textContent.includes('Test Player 鳥')`));
    await evaluate(`document.querySelector('#bagelSearchResults button').click()`);
    assert(await evaluate(`document.getElementById('bagelDeleteDescription').textContent.includes('Renamed Player 鳥')`));
    await evaluate(`document.getElementById('backToBagelsButton').click();document.getElementById('bagelSearch').value='';document.getElementById('closeManageBagelsButton').click()`);
    console.log('Rename updates booking, Bagels and Admin search/review immediately, preserving stable references and saved names');
    await evaluate(`(async()=>{
      document.querySelector('#adminPlayersList [data-player-id="${playerId}"] [data-player-action="toggle"]').click();document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
      document.getElementById('adminAddCourtButton').click();
    })()`);
    assert(await evaluate(`!window.EarlyBirdsStore.getSnapshot().users.users.find(u=>u.id===${JSON.stringify(playerId)}).active && ![...document.getElementById('profileUser').options].some(o=>o.value===${JSON.stringify(playerId)}) && ![...document.getElementById('courtBookerSelect').options].some(o=>o.value===${JSON.stringify(playerId)}) && window.EarlyBirdsStore.getSnapshot().state.courts[0].green.includes(${JSON.stringify(playerId)})`));
    console.log('Deactivation excludes new sign-in/booker choices while retaining existing participation');
    await evaluate(`(async()=>{
      document.getElementById('closeCourtButton').click();document.querySelector('#adminPlayersList [data-player-id="${playerId}"] [data-player-action="toggle"]').click();
      document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().users.users.find(u=>u.id===${JSON.stringify(playerId)}).active && [...document.getElementById('profileUser').options].some(o=>o.value===${JSON.stringify(playerId)})`));
    console.log('Reactivation restores eligibility under the same player ID');
    const playerWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{
      document.getElementById('addPlayerButton').click();document.getElementById('playerName').value=' renamed player 鳥 ';document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`document.getElementById('playerError').textContent.includes('already used')`));
    assert.equal(await evaluate('window.mockWriteAttempts'),playerWrites);
    await evaluate(`(async()=>{
      document.getElementById('playerName').value='Retry Player';window.denySave=true;document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
    })()`);
    const retryPlayerId=await evaluate('window.EarlyBirdsStore.getRecovery().action.user.id');
    await evaluate(`document.getElementById('closePlayerButton').click();document.getElementById('addPlayerButton').click()`);
    assert(await evaluate(`document.getElementById('playerName').value==='Retry Player' && document.getElementById('savePlayerButton').textContent==='Retry save'`));
    await evaluate(`(async()=>{window.denySave=false;document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().users.users.filter(u=>u.id===${JSON.stringify(retryPlayerId)}).length===1`));
    console.log('Duplicate names are rejected; failed creation keeps its draft and retries one stable ID');
    await evaluate(`(async()=>{
      document.querySelector('#adminPlayersList [data-player-id="${retryPlayerId}"] [data-player-action="edit"]').click();document.getElementById('playerName').value='Retry Player renamed';
      window.loseAckOnce=true;document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getRecovery().outcome==='uncertain' && document.getElementById('playerFields').disabled && !document.getElementById('savePlayerButton').disabled && document.getElementById('addPlayerButton').disabled`));
    await evaluate(`(async()=>{window.failShared=false;document.getElementById('retrySaveButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`!document.getElementById('playerDialog').open && window.EarlyBirdsStore.getSnapshot().users.users.find(u=>u.id===${JSON.stringify(retryPlayerId)}).name==='Retry Player renamed'`));
    console.log('Unknown directory acknowledgement locks inputs and global retry confirms the rename');
    await evaluate(`(async()=>{
      document.querySelector('#adminPlayersList [data-player-id="${retryPlayerId}"] [data-player-action="edit"]').click();document.getElementById('playerName').value='My draft';
      const users=JSON.parse(window.mockFiles['data/users.json']);users.users.find(u=>u.id===${JSON.stringify(retryPlayerId)}).name='Other Admin rename';window.mockFiles['data/users.json']=JSON.stringify(users);
      document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`document.getElementById('playerName').value==='My draft' && document.getElementById('playerError').textContent.includes('edited by someone else') && !document.getElementById('reloadPlayerButton').hidden`));
    await evaluate(`(async()=>{document.getElementById('reloadPlayerButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('playerName').value==='Other Admin rename' && document.getElementById('playerError').textContent===''`));
    for(const width of [320,390,768,1280]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth && document.getElementById("playerDialog").scrollWidth <= document.getElementById("playerDialog").clientWidth'));
    }
    console.log('Conflicting rename keeps input for explicit review; player management/dialog fit phone and desktop');
    await evaluate(`document.getElementById('closePlayerButton').click()`);
    if(process.env.TEST_USERS_SCREENSHOT_PATH) {
      await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
      const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.TEST_USERS_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
    }
    await evaluate(`(async()=>{
      document.querySelector('#adminPlayersList [data-player-id="mike-ertl"] [data-player-action="toggle"]').click();
    })()`);
    assert(await evaluate(`document.getElementById('playerDescription').textContent.includes('sign you out')`));
    await evaluate(`(async()=>{
      document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,200));
      // Sign-out uses local preview files on localhost. Mirror the simulated
      // shared directory there so this check represents a published read too.
      window.fixtureUsers=JSON.parse(window.mockFiles['data/users.json']);window.fixtureState=JSON.parse(window.mockFiles['data/current.json']);
      await window.EarlyBirdsStore.refresh();
    })()`);
    assert(await evaluate(`!window.EarlyBirdsAuth.getSession() && document.getElementById('adminTabButton').hidden && document.getElementById('adminPlayersList').children.length===0 && ![...document.getElementById('profileUser').options].some(o=>o.value==='mike-ertl')`));
    await evaluate(`(async()=>{
      document.getElementById('signInButton').click();document.getElementById('profileUser').value='akiko';document.getElementById('profileAdmin').checked=true;
      document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,150));document.getElementById('adminTabButton').click();
      document.querySelector('#adminPlayersList [data-player-id="mike-ertl"] [data-player-action="toggle"]').click();document.getElementById('playerForm').requestSubmit();await new Promise(r=>setTimeout(r,150));
    })()`);
    assert(await evaluate(`window.EarlyBirdsAuth.getSession().userId==='akiko' && window.EarlyBirdsStore.getSnapshot().users.users.find(u=>u.id==='mike-ertl').active`));
    console.log('Self-deactivation signs out; another active player chooses Admin and reactivates the same account');
    await evaluate(`(async()=>{
      document.getElementById('profileButton').click();document.getElementById('profileAdmin').checked=false;document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
    })()`);
    assert(await evaluate(`document.getElementById('adminPlayersList').children.length===0 && document.getElementById('addPlayerButton').hidden`));
    console.log('Leaving Admin clears all user-management controls');
    await evaluate(`(async()=>{
      document.getElementById('profileButton').click();document.getElementById('profileAdmin').checked=true;document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));
      const users=JSON.parse(window.mockFiles['data/users.json']);users.users.find(u=>u.id==='ellen').active=false;window.mockFiles['data/users.json']=JSON.stringify(users);
      const base={date:'2026-10-16',time:'08:00',durationMinutes:60,code:'012345',createdAt:'2026-10-16T06:00:00Z',createdBy:'mike-ertl'};
      const state={...window.EarlyBirdsStore.getSnapshot().state,courts:[{...base,id:'admin-a',courtNumber:1,bookedBy:'mike-ertl',green:['mike-ertl','ellen'],reserved:['arda']},{...base,id:'admin-b',courtNumber:2,bookedBy:'akiko',green:['akiko'],reserved:[]}],bagels:[{id:'admin-kept-history',sourceCourtId:'admin-a',date:'2026-10-16',winners:[{userId:'mike-ertl',name:'Mike recorded'}],losers:[{userId:'ellen',name:'Ellen recorded'}],createdAt:'2026-10-16T09:00:00Z',createdBy:'mike-ertl'}]};
      window.mockFiles['data/current.json']=JSON.stringify(state);await window.EarlyBirdsStore.refresh();document.getElementById('adminTabButton').click();
      window.adminCourt=id=>document.querySelector('#adminCourtsList [data-court-id="'+id+'"]');
      window.adminMember=(id,user,status)=>[...window.adminCourt(id).querySelectorAll('.admin-member [data-admin-participation]')].find(b=>b.dataset.userId===user && b.dataset.adminParticipation===status);
      window.adminPlace=async(id,user,status)=>{const button=window.adminMember(id,user,status);if(!button || button.disabled)throw new Error('Expected enabled Admin membership action');button.click();await new Promise(r=>setTimeout(r,150));};
      window.adminPick=(id,user)=>{const select=window.adminCourt(id).querySelector('[data-admin-player-select]');select.value=user;select.dispatchEvent(new Event('change'));};
      window.adminAdd=async(id,user,status)=>{window.adminPick(id,user);const button=window.adminCourt(id).querySelector('.admin-add-player [data-admin-participation="'+status+'"]');if(button.disabled)throw new Error('Expected enabled Admin add action');button.click();await new Promise(r=>setTimeout(r,150));};
    })()`);
    assert(await evaluate(`!document.querySelector('#gamesList [data-admin-participation]') && window.adminCourt('admin-a').querySelectorAll('.admin-member').length===3 && window.adminMember('admin-a','ellen','reserved').disabled && !window.adminMember('admin-a','ellen','none').disabled && ![...window.adminCourt('admin-a').querySelector('select').options].some(o=>o.value==='ellen')`));
    console.log('Court-player controls live only in Admin; existing inactive members can be removed but not newly assigned');
    await evaluate(`(async()=>{await window.adminPlace('admin-a','arda','green');await window.adminAdd('admin-a','dimitar','green');await window.adminAdd('admin-a','ivan','green');})()`);
    assert(await evaluate(`(()=>{const c=window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a');return c.green.length===4 && c.reserved.includes('ivan') && window.adminCourt('admin-a').querySelector('.admin-participation-status').textContent.includes('Court full');})()`));
    console.log('Admin promotes a reserve and adds players to completed court; fifth player becomes reserve with explanation');
    await evaluate(`(async()=>{await window.adminPlace('admin-a','ellen','none');})()`);
    assert(await evaluate(`(()=>{const c=window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a');return c.green.length===3 && c.reserved.includes('ivan') && !c.green.includes('ivan');})()`));
    await evaluate(`(async()=>{
      await window.adminPlace('admin-a','ivan','green');await window.adminAdd('admin-a','rob','reserved');await window.adminPlace('admin-a','mike-ertl','reserved');
      await window.adminPlace('admin-a','rob','green');await window.adminPlace('admin-a','mike-ertl','none');await window.adminPlace('admin-a','dimitar','none');window.adminPick('admin-a','akiko');
    })()`);
    assert(await evaluate(`window.adminCourt('admin-a').querySelector('.admin-add-player [data-admin-participation="green"]').disabled && !window.adminCourt('admin-a').querySelector('.admin-add-player [data-admin-participation="reserved"]').disabled`));
    console.log('Admin moves and removes green/reserve players without auto-promotion; overlapping green assignment is disabled');
    await evaluate(`(async()=>{await window.adminAdd('admin-a','akiko','reserved');})()`);
    assert(await evaluate(`window.adminMember('admin-a','akiko','green').disabled`));
    await evaluate(`(async()=>{await window.adminPlace('admin-b','akiko','none');await window.adminPlace('admin-a','akiko','green');await window.adminAdd('admin-a','tim','reserved');await window.adminPlace('admin-a','akiko','none');})()`);
    await evaluate(`(async()=>{
      window.racingState=JSON.parse(window.mockFiles['data/current.json']);window.racingState.courts.find(c=>c.id==='admin-a').green.push('susan');
      await window.adminPlace('admin-a','tim','green');
    })()`);
    assert(await evaluate(`(()=>{const c=window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a');return c.green.length===4 && c.green.includes('susan') && c.reserved.includes('tim') && window.adminCourt('admin-a').querySelector('.admin-participation-status').textContent.includes('Court full');})()`));
    console.log('Admin last-place SHA conflict preserves the competing join and keeps requested player reserved');
    await evaluate(`(async()=>{window.denySave=true;await window.adminPlace('admin-a','rob','none');})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a').green.includes('rob') && window.adminCourt('admin-a').querySelector('.admin-participation-error').textContent.includes('denied')`));
    await evaluate(`(async()=>{window.denySave=false;document.getElementById('retrySaveButton').click();await new Promise(r=>setTimeout(r,150));})()`);
    assert(await evaluate(`!window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a').green.includes('rob') && window.adminCourt('admin-a').querySelector('.admin-participation-status').textContent.includes('removed')`));
    console.log('Rejected Admin assignment keeps membership unchanged and global retry updates Admin feedback');
    await evaluate(`(async()=>{window.loseAckOnce=true;await window.adminAdd('admin-a','dimitar','green');})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getRecovery().outcome==='uncertain' && [...document.querySelectorAll('[data-admin-participation],[data-admin-player-select]')].every(control=>control.disabled)`));
    await evaluate(`(async()=>{window.failShared=false;document.getElementById('retrySaveButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a').green.filter(id=>id==='dimitar').length===1 && window.adminCourt('admin-a').querySelector('.admin-participation-status').textContent.includes('playing')`));
    console.log('Uncertain Admin assignment freezes controls and reconciles one membership');
    await evaluate(`(async()=>{
      await window.adminPlace('admin-a','ivan','none');window.adminPick('admin-a','akiko');
      const state=JSON.parse(window.mockFiles['data/current.json']);state.courts.find(c=>c.id==='admin-b').green=['akiko'];window.mockFiles['data/current.json']=JSON.stringify(state);
    })()`);
    const staleAdminWrites=await evaluate('window.mockWriteAttempts');
    await evaluate(`(async()=>{await window.adminAdd('admin-a','akiko','green');})()`);
    assert.equal(await evaluate('window.mockWriteAttempts'),staleAdminWrites);
    assert(await evaluate(`window.adminCourt('admin-a').querySelector('.admin-add-player [data-admin-participation="green"]').disabled && window.adminCourt('admin-a').querySelector('.admin-participation-error').textContent.includes('Choose Reserve')`));
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels[0].winners[0].name==='Mike recorded' && window.EarlyBirdsStore.getSnapshot().state.courts.find(c=>c.id==='admin-a').bookedBy==='mike-ertl'`));
    console.log('Fresh overlap validation rejects stale Admin intent, refreshes controls and preserves bagel history/ownership');
    for(const width of [320,390,768,1280]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
    }
    if(process.env.TEST_ADMIN_COURT_SCREENSHOT_PATH) {
      await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});
      await evaluate(`window.adminCourt('admin-a').scrollIntoView()`);
      const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.env.TEST_ADMIN_COURT_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));
    }
    await evaluate(`(async()=>{
      const state=JSON.parse(window.mockFiles['data/current.json']),base=state.bagels[0];
      state.bagels=Array.from({length:65},(_,i)=>({...base,id:'archive-'+i,date:new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10),winners:[{userId:'mike-ertl',name:'Archive '+i}]}));
      window.mockFiles['data/current.json']=JSON.stringify(state);await window.EarlyBirdsStore.refresh();
      document.getElementById('adminPlayersDetails').open=false;
      document.getElementById('adminBagelsDetails').open=false;
    })()`);
    assert(await evaluate(`!document.getElementById('adminBagelsDetails').open && document.getElementById('adminBagelCount').textContent==='65 recorded' && !document.querySelector('#bagelsList [data-delete-bagel-id]')`));
    await evaluate(`(async()=>{document.querySelector('#adminBagelsDetails summary').click();document.getElementById('manageBagelsButton').click();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`document.getElementById('manageBagelsDialog').open && document.querySelectorAll('[data-delete-bagel-id]').length===50 && document.getElementById('bagelSearchCount').textContent.includes('Refine')`));
    for(const width of [320,390,768,1280]) {
      await cdp('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<540});
      assert(await evaluate(`(()=>{const list=document.getElementById('bagelSearchResults'),close=document.getElementById('closeManageBagelsButton');list.scrollTop=list.scrollHeight;return list.scrollHeight>list.clientHeight && close.getBoundingClientRect().top>=0 && close.getBoundingClientRect().bottom<innerHeight && document.documentElement.scrollWidth<=innerWidth;})()`));
    }
    const beforeCancel=await evaluate('window.mockWriteAttempts');
    await evaluate(`document.getElementById('bagelSearch').value='2026-03-06';document.getElementById('bagelSearch').dispatchEvent(new Event('input'));document.querySelector('[data-delete-bagel-id="archive-64"]').click()`);
    assert(await evaluate(`document.getElementById('bagelDeleteDescription').textContent.includes('2026-03-06') && !document.getElementById('bagelDeleteDescription').textContent.includes('Archive 64') && !document.getElementById('bagelDeleteReview').hidden`));
    await evaluate(`document.getElementById('closeManageBagelsButton').click()`);
    assert.equal(await evaluate('window.mockWriteAttempts'),beforeCancel);
    await evaluate(`(async()=>{document.getElementById('manageBagelsButton').click();await new Promise(r=>setTimeout(r,100));window.denySave=true;document.getElementById('confirmBagelDeleteButton').click();await new Promise(r=>setTimeout(r,150));})()`);
    assert(await evaluate(`window.EarlyBirdsStore.getSnapshot().state.bagels.length===65 && document.getElementById('bagelDeleteError').textContent.includes('denied') && document.getElementById('confirmBagelDeleteButton').textContent==='Retry deletion'`));
    await evaluate(`(async()=>{
      window.denySave=false;window.racingState=JSON.parse(window.mockFiles['data/current.json']);window.racingState.bagels.push({...window.racingState.bagels[0],id:'concurrent-set'});
      document.getElementById('confirmBagelDeleteButton').click();await new Promise(r=>setTimeout(r,200));
    })()`);
    assert(await evaluate(`(()=>{const s=window.EarlyBirdsStore.getSnapshot().state;return s.bagels.length===65 && !s.bagels.some(b=>b.id==='archive-64') && s.bagels.some(b=>b.id==='concurrent-set') && s.courts.length===2 && document.getElementById('bagelDeleteStatus').textContent.includes('deleted') && !document.querySelector('#bagelsList [data-bagel-id="archive-64"]');})()`));
    console.log('Collapsed Admin Bagels opens bounded searchable popup, cancels safely and confirms deletion; failed retry preserves concurrent sets and courts');
    await evaluate(`(async()=>{
      document.getElementById('backToBagelsButton').click();document.getElementById('bagelSearch').value='2026-03-05';document.getElementById('bagelSearch').dispatchEvent(new Event('input'));document.querySelector('[data-delete-bagel-id="archive-63"]').click();
      window.loseAckOnce=true;document.getElementById('confirmBagelDeleteButton').click();await new Promise(r=>setTimeout(r,200));
    })()`);
    assert(await evaluate(`window.EarlyBirdsStore.getRecovery().outcome==='uncertain' && document.getElementById('backToBagelsButton').disabled && !document.getElementById('closeManageBagelsButton').disabled`));
    await evaluate(`(async()=>{document.getElementById('closeManageBagelsButton').click();document.getElementById('manageBagelsButton').click();window.failShared=false;document.getElementById('retrySaveButton').click();await new Promise(r=>setTimeout(r,200));})()`);
    assert(await evaluate(`document.getElementById('bagelDeleteStatus').textContent.includes('deleted') && !window.EarlyBirdsStore.getSnapshot().state.bagels.some(b=>b.id==='archive-63')`));
    await evaluate(`document.getElementById('backToBagelsButton').click();document.getElementById('bagelSearch').value='no-such-player';document.getElementById('bagelSearch').dispatchEvent(new Event('input'))`);
    assert(await evaluate(`document.getElementById('bagelSearchCount').textContent==='0 matching bagels'`));
    await evaluate(`document.getElementById('closeManageBagelsButton').click();document.querySelector('#adminBagelsDetails summary').click()`);
    assert(await evaluate(`!document.getElementById('adminBagelsDetails').open`));
    console.log('Uncertain deletion retains selection across close/reopen, global retry reconciles and search handles no matches; layouts keep Close visible');
    await evaluate(`document.getElementById('adminBagelsDetails').open=true;document.getElementById('manageBagelsButton').click()`);
    await evaluate(`(async()=>{document.getElementById('manageBagelsDialog').close();document.getElementById('profileButton').click();document.getElementById('profileAdmin').checked=false;document.getElementById('profileForm').requestSubmit();await new Promise(r=>setTimeout(r,100));})()`);
    assert(await evaluate(`!document.querySelector('[data-admin-participation]') && document.getElementById('adminTabButton').hidden`));
    console.log('Court-player controls fit phone/desktop layouts and disappear when Admin mode ends');
    assert.deepEqual(errors, []);
    console.log('No uncaught browser errors. All checks passed.');
  } finally {
    if (ws) ws.close();
    if (chrome.exitCode === null && !launchError) {
      chrome.kill('SIGTERM');
      await new Promise(resolve => chrome.once('exit', resolve));
    }
    await fs.rm(profile, {recursive:true, force:true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
