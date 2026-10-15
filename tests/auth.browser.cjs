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
        if (!String(url).startsWith('https://api.github.com/')) return realFetch(url, options);
        if (String(url).includes('/contents/')) {
          if (window.failShared) return new Response('{}', {status:503});
          const file = String(url).includes('users.json') ? 'data/users.json' : 'data/current.json';
          if (options.method === 'PUT') {
            window.mockWriteAttempts++;
            if (!window.allowWrites) throw new Error('Unexpected write');
            if (window.denySave) return new Response('{}', {status:403});
            await new Promise(resolve => setTimeout(resolve, 50));
            window.mockFiles[file] = atob(JSON.parse(options.body).content);
            if (window.loseAckOnce) {window.loseAckOnce=false;window.failShared=true;throw new TypeError('Simulated lost response');}
            return new Response(JSON.stringify({content:{sha:'test-sha'}}));
          }
          const data = window.mockFiles[file] || await (await realFetch(file)).text();
          return new Response(JSON.stringify({ type:'file', encoding:'base64', content:btoa(data), sha:'test-sha' }));
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
      el('adminTabButton').click(); el('signOutButton').click(); await wait();
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
