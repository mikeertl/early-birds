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
      window.fetch = async (url, options = {}) => {
        if (!String(url).startsWith('https://api.github.com/')) return realFetch(url, options);
        if (options.method && options.method !== 'GET') throw new Error('Unexpected write');
        if (String(url).includes('/contents/')) {
          if (window.failShared) return new Response('{}', {status:503});
          const file = String(url).includes('users.json') ? 'data/users.json' : 'data/current.json';
          const data = await (await realFetch(file)).text();
          return new Response(JSON.stringify({ type:'file', encoding:'base64', content:btoa(data), sha:'test-sha' }));
        }
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
      check(auth.requireWrite() === false && el('profileDialog').open && el('profileError').textContent.includes('Sign in'), 'visitor write guard');
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
      window.failShared = false; el('refreshButton').click(); await wait();
      check(el('dataError').textContent === '' && el('dataStatus').textContent.includes('refreshed'), 'refresh retry recovers');
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
