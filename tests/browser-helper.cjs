const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function launchBrowser(options) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'early-birds-live-'));
  const child = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank',
  ], {stdio:'ignore'});
  let launchError;
  child.on('error', error=>{launchError=error;});
  let ws;
  async function close() {
    if(ws) ws.close();
    if(child.exitCode===null && !launchError) {child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    await fs.rm(profile,{recursive:true,force:true});
  }
  try {
    let lines;
    for(let n=0;n<150;n++) {
      if(launchError) throw new Error('Chrome could not start. Set CHROME_BIN to its executable.');
      try {lines=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break;}
      catch {await new Promise(resolve=>setTimeout(resolve,100));}
    }
    if(!lines) throw new Error('Chrome did not start in time.');
    ws=new WebSocket('ws://127.0.0.1:'+lines[0]+lines[1]);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',()=>reject(new Error('Chrome connection failed.')),{once:true});});
    let sequence=0; const pending=new Map();
    ws.addEventListener('message',event=>{
      const message=JSON.parse(event.data); const callback=pending.get(message.id);
      if(callback) {pending.delete(message.id);message.error?callback.reject(new Error('Chrome command failed.')):callback.resolve(message.result);}
    });
    function cdp(method,params={},sessionId) {
      return new Promise((resolve,reject)=>{
        const id=++sequence;
        const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Chrome check timed out.'));},60000);
        pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
        ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
      });
    }
    async function page() {
      const {browserContextId}=await cdp('Target.createBrowserContext');
      const {targetId}=await cdp('Target.createTarget',{url:'about:blank',browserContextId});
      const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
      async function evaluate(expression) {
        const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
        // Never print exceptionDetails: Chrome may include evaluated credential text.
        if(result.exceptionDetails) throw new Error('A browser check failed. Check test-repository access or rerun.');
        return result.result.value;
      }
      await cdp('Page.enable',{},sessionId);
      await cdp('Page.addScriptToEvaluateOnNewDocument',{source:options.source || `
        const actualFetch=window.fetch.bind(window);
        window.liveConflicts=0; window.holdNextWrite=false; window.failNextWrite=false;
        window.fetch=async (url, options={})=>{
          if(options.method==='PUT') {
            if(window.failNextWrite){window.failNextWrite=false;return new Response('{}',{status:403});}
            if(window.holdNextWrite){window.holdNextWrite=false;await actualFetch('/barrier',{method:'POST'});}
          }
          const response=await actualFetch(url,options);
          if(response.status===409) window.liveConflicts++;
          return response;
        };
      `},sessionId);
      await cdp('Page.navigate',{url:options.url},sessionId);
      for(let n=0;n<100;n++) {
        if(await evaluate('Boolean(window.EarlyBirdsAuth && window.EarlyBirdsStore && window.EarlyBirdsStore.getSnapshot() && document.getElementById("profileUser").options.length===window.EarlyBirdsStore.getSnapshot().users.users.filter(user=>user.active).length+1)')) return {evaluate};
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error('The test app did not load the player directory.');
    }
    return {page,close};
  } catch(error) {await close();throw error;}
}
module.exports = { launchBrowser };
