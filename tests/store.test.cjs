const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const createModel = require('../model.js');
const createStore = require('../store.js');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../config.js'), 'utf8'), context);
const config = context.window.EarlyBirdsConfig;
const model = createModel(config);
const seedUsers = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/users.json'), 'utf8'));
const seedState = { ...JSON.parse(fs.readFileSync(path.join(__dirname, '../data/current.json'), 'utf8')), courts: [], bagels: [] };
const now = '2026-10-14T10:00:00Z';
const clone = value => JSON.parse(JSON.stringify(value));
function court(id = 'court-a', extra = {}) {
  return Object.assign({ id, date:'2026-10-14', time:'08:00', durationMinutes:60, courtNumber:1,
    code:'012345', bookedBy:'mike-ertl', green:['mike-ertl'], reserved:[], createdAt:now, createdBy:'mike-ertl' }, extra);
}
function server(initial = {}) {
  const documents = { 'data/users.json':clone(seedUsers), 'data/current.json':clone(seedState), ...clone(initial) };
  const revisions = { 'data/users.json':1, 'data/current.json':1 };
  let puts = 0;
  let conflicts = 0;
  let beforePut;
  let loseAck = false;
  let failure;
  let localReads = 0;
  async function fetch(url, options = {}) {
    const file = String(url).includes('users.json') ? 'data/users.json' : 'data/current.json';
    const api = String(url).startsWith('https://api.github.com/');
    if (!api) { localReads++; return new Response(JSON.stringify(documents[file])); }
    assert(String(url).includes('/repos/mikeertl/early-birds/contents/'));
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    if (failure) return new Response('{}', {status:failure});
    if (options.method !== 'PUT') {
      assert(String(url).includes('ref=main'));
      return new Response(JSON.stringify({type:'file', encoding:'base64', sha:String(revisions[file]), content:Buffer.from(JSON.stringify(documents[file])).toString('base64')}));
    }
    puts++;
    if (beforePut) { const hook = beforePut; beforePut = null; hook(documents, revisions, file); }
    const body = JSON.parse(options.body);
    assert.equal(body.branch, 'main');
    if (body.sha !== String(revisions[file])) { conflicts++; return new Response('{}', {status:409}); }
    documents[file] = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    revisions[file]++;
    if (loseAck) { loseAck=false; throw new TypeError('sensitive transport details must not escape'); }
    return new Response(JSON.stringify({content:{sha:String(revisions[file])}}));
  }
  return {documents, revisions, fetch, get puts(){return puts;}, get conflicts(){return conflicts;}, get localReads(){return localReads;},
    set beforePut(value){beforePut=value;}, set loseAck(value){loseAck=value;}, set failure(value){failure=value;} };
}
function client(remote, userId='mike-ertl', isAdmin=false, options={}) {
  let actor = userId ? {userId, isAdmin, token:'synthetic-token'} : null;
  const store = createStore({config, model, fetch:remote.fetch, getSession:()=>actor, requireWrite:()=>Boolean(actor), now:()=>new Date(now), ...options});
  return {store, setActor(value){actor=value;}};
}
test('initial documents validate and reads do not save', async () => {
  const remote=server(); const {store}=client(remote);
  const snapshot=await store.refresh();
  assert.equal(snapshot.users.users.length, 9); assert.equal(snapshot.state.courts.length,0); assert.equal(remote.puts,0);
  snapshot.users.users[0].name='Not shared'; assert.notEqual(store.getSnapshot().users.users[0].name,'Not shared');
});
test('local visitor reads local JSON; visitors cannot mutate', async () => {
  const remote=server(); const {store}=client(remote,null,false,{isLocal:true});
  await store.refresh(); assert.equal(remote.localReads,2);
  await assert.rejects(store.mutate({type:'courts.cleanup'}), /Sign in/); assert.equal(remote.puts,0);
});
test('two clients taking last green place preserve all members and reserve overflow', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a',{green:['mike-ertl','akiko','arda']})];
  const a=client(remote,'dimitar').store, b=client(remote,'ellen').store;
  await Promise.all([a.refresh(),b.refresh()]);
  await Promise.all([a.mutate({type:'participation.set',courtId:'a',status:'green'}),b.mutate({type:'participation.set',courtId:'a',status:'green'})]);
  const result=remote.documents['data/current.json'].courts[0];
  assert.equal(result.green.length,4); assert.equal(result.reserved.length,1);
  assert([...result.green,...result.reserved].includes('dimitar')); assert([...result.green,...result.reserved].includes('ellen'));
  assert(remote.conflicts>0);
});
test('independent court edits merge; same-field edits demand review', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a',{date:'2026-10-15'})];
  const a=client(remote).store, b=client(remote).store;
  await Promise.all([
    a.mutate({type:'court.patch',courtId:'a',expected:{code:'012345'},changes:{code:'654321'}}),
    b.mutate({type:'court.patch',courtId:'a',expected:{courtNumber:1},changes:{courtNumber:2}}),
  ]);
  assert.equal(remote.documents['data/current.json'].courts[0].code,'654321');
  assert.equal(remote.documents['data/current.json'].courts[0].courtNumber,2);
  await assert.rejects(a.mutate({type:'court.patch',courtId:'a',expected:{code:'012345'},changes:{code:'111111'}}), /edited by someone else/);
  assert.equal(remote.documents['data/current.json'].courts[0].code,'654321');
});
test('conflicting cleanup preserves another booking and retained bagels', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('expired',{date:'2026-10-13'}),court('today')];
  const {store}=client(remote);
  await store.mutate({type:'bagel.add',bagel:{id:'retained',sourceCourtId:'today',date:'2026-10-14',winnerIds:['mike-ertl'],loserIds:['mike-ertl']}}).then(()=>assert.fail('duplicate player accepted'),()=>{});
  remote.documents['data/current.json'].bagels=[{id:'retained',sourceCourtId:'expired',date:'2026-10-13',
    winners:[{userId:'mike-ertl',name:'Mike Ertl'}],losers:[{userId:'akiko',name:'Akiko'}],createdAt:now,createdBy:'mike-ertl'}];
  remote.beforePut=(docs,revisions,file)=>{docs[file].courts.push(court('new',{date:'2026-10-15',courtNumber:2}));revisions[file]++;};
  await store.mutate({type:'courts.cleanup'});
  assert.deepEqual(remote.documents['data/current.json'].courts.map(c=>c.id),['today','new']);
  assert.equal(remote.documents['data/current.json'].bagels[0].id,'retained');
});
test('lost acknowledgement confirms the same bagel once, with Unicode snapshots', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a',{green:['mike-ertl','akiko']})];
  remote.documents['data/users.json'].users.find(u=>u.id==='akiko').name='Akiko 鳥';
  remote.loseAck=true;
  const {store}=client(remote);
  const intent={type:'bagel.add',bagel:{id:'set-1',sourceCourtId:'a',date:'2026-10-14',winnerIds:['mike-ertl'],loserIds:['akiko']}};
  await store.mutate(intent); await store.mutate(intent);
  assert.equal(remote.puts,1); assert.equal(remote.documents['data/current.json'].bagels.length,1);
  assert.equal(remote.documents['data/current.json'].bagels[0].losers[0].name,'Akiko 鳥');
  await store.mutate({...intent,bagel:{...intent.bagel,id:'set-2'}});
  assert.equal(remote.documents['data/current.json'].bagels.length,2);
});
test('different clients submitting different bagels retain both', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a',{green:['mike-ertl','akiko']})];
  const a=client(remote).store,b=client(remote,'akiko').store;
  await Promise.all([a,b].map((store,index)=>store.mutate({type:'bagel.add',bagel:{id:`set-${index}`,sourceCourtId:'a',date:'2026-10-14',winnerIds:['mike-ertl'],loserIds:['akiko']}})));
  assert.equal(remote.documents['data/current.json'].bagels.length,2);
});
test('fresh directory changes block deactivated writers', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
  let reads=0; const realFetch=remote.fetch;
  const {store}=client(remote,'mike-ertl',false,{fetch:async(url,options)=>{
    if(String(url).includes('users.json') && !options.method && ++reads===2){
      remote.documents['data/users.json'].users.find(u=>u.id==='mike-ertl').active=false;remote.revisions['data/users.json']++;
    }
    return realFetch(url,options);
  }});
  await assert.rejects(store.mutate({type:'participation.set',courtId:'a',status:'reserved'}),/not active/);
  assert.equal(remote.puts,0);
});
test('queued changes stop when sign-in changes before PUT', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
  let reads=0; const realFetch=remote.fetch; let app;
  app=client(remote,'mike-ertl',false,{fetch:async(url,options)=>{
    if(String(url).includes('users.json') && !options.method && ++reads===2) app.setActor(null);
    return realFetch(url,options);
  }});
  await assert.rejects(app.store.mutate({type:'participation.set',courtId:'a',status:'reserved'}),/Sign-in changed/);
  assert.equal(remote.puts,0);
});
test('directory edits preserve other users, stable references and historical names', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
  const a=client(remote,'mike-ertl',true).store,b=client(remote,'akiko',true).store;
  await Promise.all([
    a.mutate({type:'user.patch',userId:'arda',expected:{name:'Arda'},changes:{name:'Arda Updated'}}),
    b.mutate({type:'user.patch',userId:'ivan',expected:{active:true},changes:{active:false}}),
  ]);
  assert.equal(remote.documents['data/users.json'].users.find(u=>u.id==='arda').name,'Arda Updated');
  assert.equal(remote.documents['data/users.json'].users.find(u=>u.id==='ivan').active,false);
  assert.equal(remote.documents['data/current.json'].courts[0].bookedBy,'mike-ertl');
});
test('malformed/newer data, invalid capacity and overlaps are rejected without saving', async () => {
  for (const corrupt of [state=>state.version=2,state=>state.courts=[court('a',{code:'123'})],
    state=>state.courts=[court('a',{green:['mike-ertl','akiko','arda','dimitar','ellen']})],
    state=>state.courts=[court('a'),court('b',{courtNumber:2})],
    state=>state.token='synthetic-token']) {
    const remote=server(); corrupt(remote.documents['data/current.json']);
    const {store}=client(remote);
    await assert.rejects(store.refresh());
    await assert.rejects(store.mutate({type:'courts.cleanup'}));
    assert.equal(remote.puts,0);
  }
});
test('permission errors preserve last good snapshot; later refresh recovers', async () => {
  const remote=server(); const {store}=client(remote);
  const before=await store.refresh(); remote.failure=403;
  await assert.rejects(store.mutate({type:'courts.cleanup'}),/denied/);
  assert.deepEqual(store.getSnapshot(),before); assert.equal(remote.puts,0);
  remote.failure=null; await store.refresh();
});
test('London calendar date and hour are independent of device timezone', () => {
  assert.deepEqual(model.londonClock('2026-10-14T23:30:00Z'),{date:'2026-10-15',minutes:30});
  assert.deepEqual(model.londonClock('2026-10-25T01:30:00Z'),{date:'2026-10-25',minutes:90});
});
test('pending and saved status require a confirmed result', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
  const {store}=client(remote); const events=[]; store.subscribe(event=>events.push(event.status));
  await store.mutate({type:'participation.set',courtId:'a',status:'reserved'});
  assert.equal(events[0].save.outcome,'pending');
  assert.equal(events.at(-1).save.outcome,'saved');
  assert.equal(store.getRecovery(),null);
});
test('denied PUT preserves intent; refresh does not claim it was saved; retry recovers', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
  let denied=true; const realFetch=remote.fetch; const events=[];
  const {store}=client(remote,'mike-ertl',false,{fetch:(url,options)=>
    options.method==='PUT' && denied ? Promise.resolve(new Response('{}',{status:403})) : realFetch(url,options)});
  store.subscribe(event=>events.push(event.status)); await store.refresh();
  const intent={type:'participation.set',courtId:'a',status:'reserved'};
  await assert.rejects(store.mutate(intent),error=>error.outcome==='failed');
  assert.equal(events.at(-1).save.outcome,'failed'); assert.equal(events.at(-1).stale,true);
  assert.deepEqual(store.getRecovery().action,intent);
  intent.status='none'; assert.equal(store.getRecovery().action.status,'reserved');
  await store.refresh(); assert.equal(events.at(-1).save.outcome,'failed'); assert.equal(events.at(-1).stale,false);
  denied=false; await store.retry();
  assert.equal(events.at(-1).save.outcome,'saved'); assert.equal(store.getRecovery(),null);
  assert.deepEqual(remote.documents['data/current.json'].courts[0].reserved,['mike-ertl']);
});
test('unknown acknowledgement remains uncertain across failed retry and refresh, then confirms once', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a',{green:['mike-ertl','akiko']})];
  const realFetch=remote.fetch; remote.loseAck=true; const events=[];
  const {store}=client(remote,'mike-ertl',false,{fetch:async(url,options)=>{
    try{return await realFetch(url,options);}catch(error){remote.failure=503;throw error;}
  }});
  store.subscribe(event=>events.push(event.status)); await store.refresh();
  const intent={type:'bagel.add',bagel:{id:'uncertain-set',sourceCourtId:'a',date:'2026-10-14',winnerIds:['mike-ertl'],loserIds:['akiko']}};
  await assert.rejects(store.mutate(intent),error=>error.outcome==='uncertain');
  await assert.rejects(store.retry(),error=>error.outcome==='uncertain');
  assert.equal(events.at(-1).save.outcome,'uncertain');
  remote.failure=null; await store.refresh(); assert.equal(events.at(-1).save.outcome,'uncertain');
  await store.retry(); assert.equal(events.at(-1).save.outcome,'saved');
  assert.equal(remote.puts,1); assert.equal(remote.documents['data/current.json'].bagels.length,1);
});
test('expired token and rate limits retain failed input without exposing transport details', async () => {
  for(const status of [401,429]) {
    const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
    const {store}=client(remote); const events=[]; store.subscribe(event=>events.push(event.status));
    await store.refresh(); remote.failure=status;
    await assert.rejects(store.mutate({type:'participation.set',courtId:'a',status:'reserved'}),error=>error.outcome==='failed');
    assert.equal(events.at(-1).save.outcome,'failed'); assert(store.getRecovery());
    assert(!events.at(-1).message.includes('synthetic-token')); assert.equal(remote.puts,0);
  }
});
test('malformed response marks existing snapshot stale without replacing it', async () => {
  const remote=server(); let malformed=false; const realFetch=remote.fetch;
  const {store}=client(remote,'mike-ertl',false,{fetch:(url,options)=>malformed ? Promise.resolve(new Response('broken JSON')) : realFetch(url,options)});
  const events=[]; store.subscribe(event=>events.push(event.status));
  const before=await store.refresh(); malformed=true;
  await assert.rejects(store.refresh(),/valid JSON/);
  assert.deepEqual(store.getSnapshot(),before); assert.equal(events.at(-1).stale,true);
});
test('recovery cannot be replayed as another player', async () => {
  const remote=server(); remote.failure=403; const app=client(remote);
  await assert.rejects(app.store.mutate({type:'courts.cleanup'}));
  app.setActor({userId:'akiko',token:'synthetic-token',isAdmin:false});
  await assert.rejects(app.store.retry(),/original player/);
  assert(app.store.getRecovery()); assert.equal(remote.puts,0);
});
test('acknowledged save after sign-out is reported as saved, not failed or replayable', async () => {
  const remote=server(); remote.documents['data/current.json'].courts=[court('a')];
  const realFetch=remote.fetch; let app; const events=[];
  app=client(remote,'mike-ertl',false,{fetch:async(url,options)=>{
    const response=await realFetch(url,options);
    if(options.method==='PUT') app.setActor(null);
    return response;
  }});
  app.store.subscribe(event=>events.push(event.status)); await app.store.refresh();
  await assert.rejects(app.store.mutate({type:'participation.set',courtId:'a',status:'reserved'}),error=>error.outcome==='saved');
  assert.equal(events.at(-1).save.outcome,'saved'); assert(events.at(-1).save.message.includes('before sign-in changed'));
  assert.equal(app.store.getRecovery(),null); assert.equal(remote.puts,1);
});
test('new court enrols its booker once and preserves independent simultaneous courts', async () => {
  const remote=server(); const mike=client(remote).store,akiko=client(remote,'akiko').store;
  const intent={type:'court.add',court:{id:'new-a',date:'2099-10-15',time:'08:00',courtNumber:1,code:'012345',bookedBy:'mike-ertl'}};
  await mike.mutate(intent);await mike.mutate(intent);
  await akiko.mutate({type:'court.add',court:{...intent.court,id:'new-b',courtNumber:2,bookedBy:'akiko'}});
  const courts=remote.documents['data/current.json'].courts;
  assert.equal(courts.length,2);assert.deepEqual(courts[0].green,['mike-ertl']);assert.deepEqual(courts[1].green,['akiko']);
  assert.equal(courts[0].durationMinutes,60);assert.equal(courts[0].code,'012345');assert.equal(remote.puts,2);
  await assert.rejects(mike.mutate({type:'court.add',court:{...intent.court,id:'new-c',courtNumber:3}}),/overlapping/);
  await assert.rejects(akiko.mutate({type:'court.add',court:{...intent.court,id:'new-d',bookedBy:'akiko'}}),/already booked/);
  assert.equal(remote.puts,2);
});
test('court creation rejects invalid or past details and booking for another player', async () => {
  const remote=server();const {store}=client(remote);
  const valid={id:'invalid-court',date:'2099-10-15',time:'08:00',courtNumber:1,code:'012345',bookedBy:'mike-ertl'};
  for(const changes of [{date:'2020-01-01'},{time:'06:00'},{time:'08:30'},{courtNumber:7},{code:'12345'},{bookedBy:'akiko'}]) {
    await assert.rejects(store.mutate({type:'court.add',court:{...valid,...changes}}));
  }
  assert.equal(remote.puts,0);
});
test('participation transitions preserve disjoint membership and never automatically promote reserves', async () => {
  const remote=server();remote.documents['data/current.json'].courts=[court('a',{green:['mike-ertl','akiko','arda','ellen'],reserved:['dimitar']})];
  const mike=client(remote).store,dimitar=client(remote,'dimitar').store;
  await mike.mutate({type:'participation.set',courtId:'a',status:'reserved'});
  let current=remote.documents['data/current.json'].courts[0];
  assert.equal(current.green.length,3);assert.deepEqual(current.reserved,['dimitar','mike-ertl']);
  await dimitar.mutate({type:'participation.set',courtId:'a',status:'green'});
  current=remote.documents['data/current.json'].courts[0];assert.equal(current.green.length,4);assert(!current.reserved.includes('dimitar'));
  await mike.mutate({type:'participation.set',courtId:'a',status:'none'});
  assert(!remote.documents['data/current.json'].courts[0].reserved.includes('mike-ertl'));
});
test('Admin assignments enforce the same capacity and overlap rules; ordinary players cannot change others', async () => {
  const remote=server();remote.documents['data/current.json'].courts=[court('a',{green:['mike-ertl','arda','ellen','ivan']}),court('b',{courtNumber:2,bookedBy:'akiko',green:['akiko']})];
  const ordinary=client(remote).store,admin=client(remote,'mike-ertl',true).store;
  await assert.rejects(ordinary.mutate({type:'participation.set',courtId:'a',userId:'dimitar',status:'green'}),/Admin/);
  await admin.mutate({type:'participation.set',courtId:'a',userId:'dimitar',status:'green'});
  assert.equal(remote.documents['data/current.json'].courts[0].green.length,4);
  assert(remote.documents['data/current.json'].courts[0].reserved.includes('dimitar'));
  await assert.rejects(admin.mutate({type:'participation.set',courtId:'b',userId:'ivan',status:'green'}),/overlapping/);
  await admin.mutate({type:'participation.set',courtId:'b',userId:'ivan',status:'reserved'});
  assert(remote.documents['data/current.json'].courts[1].reserved.includes('ivan'));
});
test('court edits enforce ownership and validation, including every green player overlap', async () => {
  const remote=server();remote.documents['data/current.json'].courts=[
    court('a',{date:'2099-10-15',green:['mike-ertl','ellen'],reserved:['arda']}),
    court('b',{date:'2099-10-15',time:'09:00',courtNumber:2,bookedBy:'akiko',green:['ellen']})];
  const owner=client(remote).store, other=client(remote,'akiko').store, admin=client(remote,'akiko',true).store;
  const patch=(changes,expected)=>({type:'court.patch',courtId:'a',changes,expected});
  await assert.rejects(other.mutate(patch({code:'111111'},{code:'012345'})),/booker or Admin/);
  await assert.rejects(other.mutate({type:'court.remove',courtId:'a'}),/booker or Admin/);
  await assert.rejects(owner.mutate(patch({bookedBy:'akiko'},{bookedBy:'mike-ertl'})),/Admin/);
  for(const changes of [{time:'06:00'},{time:'21:30'},{courtNumber:7},{code:'12345'},{code:'abcdef'},{date:'2020-01-01'}]) {
    const expected=Object.fromEntries(Object.keys(changes).map(key=>[key,remote.documents['data/current.json'].courts[0][key]]));
    await assert.rejects(owner.mutate(patch(changes,expected)));
  }
  await assert.rejects(owner.mutate(patch({time:'09:00'},{time:'08:00'})),/overlapping/);
  await assert.rejects(admin.mutate(patch({time:'09:00'},{time:'08:00'})),/overlapping/);
  await assert.rejects(owner.mutate(patch({time:'09:00',courtNumber:2},{time:'08:00',courtNumber:1})),/already booked/);
  assert.equal(remote.puts,0);
  await admin.mutate(patch({bookedBy:'akiko'},{bookedBy:'mike-ertl'}));
  let changed=remote.documents['data/current.json'].courts[0];
  assert.deepEqual(changed.green,['mike-ertl','ellen']);assert.deepEqual(changed.reserved,['arda']);
  assert.equal(changed.bookedBy,'akiko');assert.equal(changed.createdBy,'mike-ertl');
  await assert.rejects(owner.mutate(patch({code:'111111'},{code:'012345'})),/booker or Admin/);
  await other.mutate(patch({time:'10:00'},{time:'08:00'}));
  assert.equal(remote.documents['data/current.json'].courts[0].time,'10:00');
});
test('confirmed deletion rejects changed details, preserves bagels and reconciles lost acknowledgement', async () => {
  const remote=server();const original=court('a',{date:'2099-10-15',green:['mike-ertl','ellen'],reserved:['arda']});
  remote.documents['data/current.json'].courts=[original];
  const history={id:'history',sourceCourtId:'a',date:'2026-10-13',winners:[{userId:'mike-ertl',name:'Mike Ertl'}],losers:[{userId:'akiko',name:'Akiko'}],createdAt:now,createdBy:'mike-ertl'};
  remote.documents['data/current.json'].bagels=[history];
  const owner=client(remote).store;
  const expected=Object.fromEntries(['date','time','courtNumber','code','bookedBy'].map(key=>[key,original[key]]));
  remote.beforePut=(docs,revisions,file)=>{docs[file].courts[0].time='09:00';revisions[file]++;};
  await assert.rejects(owner.mutate({type:'court.remove',courtId:'a',expected}),/confirm deletion again/);
  assert.equal(remote.documents['data/current.json'].courts.length,1);
  expected.time='09:00';
  remote.beforePut=(docs,revisions,file)=>{docs[file].courts[0].reserved.push('dimitar');revisions[file]++;};
  remote.loseAck=true;
  await owner.mutate({type:'court.remove',courtId:'a',expected});
  assert.equal(remote.documents['data/current.json'].courts.length,0);
  assert.deepEqual(remote.documents['data/current.json'].bagels,[history]);
  assert.equal(owner.getRecovery(),null);
  await owner.mutate({type:'court.remove',courtId:'a',expected});
  await assert.rejects(owner.mutate({type:'court.patch',courtId:'a',changes:{code:'111111'},expected:{code:'012345'}}),/no longer exists/);
});
