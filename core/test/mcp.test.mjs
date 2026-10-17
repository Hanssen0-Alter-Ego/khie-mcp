import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable, PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { KhieService } from '../src/service.mjs';
import { createOfflineFixture } from '../src/adapter.mjs';
import { McpHandler, runStdio, TOOLS } from '../src/mcp.mjs';
const msg=(id,method,params)=>({jsonrpc:'2.0',id,method,...(params?{params}:{})});
const init=msg(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture-test',version:'1'}});
async function setup(t) { const s=new KhieService({transportFactory:createOfflineFixture}),h=new McpHandler(s);t.after(()=>s.shutdown());await h.handle(init);await h.handle({jsonrpc:'2.0',method:'notifications/initialized'});return {s,h}; }
const call=(h,name,args={})=>h.handle(msg(2,'tools/call',{name,arguments:args}));
test('initialization negotiates version and requires initialized notification',async t=>{const s=new KhieService({transportFactory:createOfflineFixture});t.after(()=>s.shutdown());const h=new McpHandler(s);assert.equal((await h.handle(msg(2,'tools/list'))).error.code,-32002);const x=await h.handle({...init,params:{...init.params,protocolVersion:'unknown'}});assert.equal(x.result.protocolVersion,'2025-11-25');assert.equal((await h.handle(msg(2,'tools/list'))).error.code,-32002);await h.handle({jsonrpc:'2.0',method:'notifications/initialized'});assert.equal((await h.handle(msg(2,'tools/list'))).result.tools.length,7);});
test('invalid initialization does not advance phase',async t=>{const {s}=await setup(t),h=new McpHandler(s);assert.equal((await h.handle(msg(1,'initialize',{}))).error.code,-32602);assert.equal(h.phase,'new');assert.ok((await h.handle(init)).result);});
test('duplicate initialize is refused and ping works',async t=>{const {h}=await setup(t);assert.equal((await h.handle(init)).error.code,-32600);assert.deepEqual((await h.handle(msg('ping','ping'))).result,{});});
test('MCP request surface cannot enable signing or transmit approval',async t=>{const {h}=await setup(t);for(const args of [{approved:true},{enableSigning:true}])assert.equal((await call(h,'khie_session_open',args)).result.isError,true);assert.equal((await call(h,'khie_request',{sessionId:'x',requestId:'r',method:'sign_message',params:[]})).result.structuredContent.error.code,'METHOD_DISABLED');});
test('unexpected prototype-like argument is rejected',async t=>{const {h}=await setup(t);const args=JSON.parse('{"__proto__": {"approved": true}}');assert.equal((await call(h,'khie_session_open',args)).result.isError,true);});
test('missing and incorrectly typed arguments return tool errors',async t=>{const {h}=await setup(t);for(const args of [{},{sessionId:1},{sessionId:'s',requestId:'r',recover:'yes'}])assert.equal((await call(h,'khie_result',args)).result.isError,true);});
test('schemas enumerate exactly the implemented new tool contract',async t=>{const {h}=await setup(t);const tools=(await h.handle(msg(3,'tools/list'))).result.tools;assert.deepEqual(tools,TOOLS);assert.ok(tools.every(x=>x.inputSchema.additionalProperties===false));assert.equal(tools.find(t=>t.name==='khie_request').inputSchema.properties.method.enum.includes('sign_transaction'),false);});
test('notifications are not answered',async t=>{const {h}=await setup(t);assert.equal(await h.handle({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:9}}),undefined);});
test('unknown method and unknown tool have JSON-RPC errors',async t=>{const {h}=await setup(t);assert.equal((await h.handle(msg(3,'unknown'))).error.code,-32601);assert.equal((await call(h,'unknown')).error.code,-32602);});
test('invalid request forms are rejected',async t=>{const {h}=await setup(t);for(const m of [[],null,{},msg(null,'ping'),msg({},'ping'),{...msg(1,'ping'),params:[]},msg('x'.repeat(129),'ping')])assert.equal((await h.handle(m)).error.code,-32600);});
test('open/status/request/result/close/shutdown tools work end-to-end',async t=>{const {h,s}=await setup(t);const id=(await call(h,'khie_session_open')).result.structuredContent.sessionId;await s.ready(id);assert.equal((await call(h,'khie_session_status',{sessionId:id})).result.structuredContent.state,'ready');await call(h,'khie_request',{sessionId:id,requestId:'r',method:'get_info'});await new Promise(r=>setImmediate(r));const result=(await call(h,'khie_result',{sessionId:id,requestId:'r',recover:true})).result.structuredContent;assert.equal(result.result.fixture,true);assert.equal((await call(h,'khie_session_close',{sessionId:id})).result.structuredContent.state,'closed');assert.equal((await call(h,'khie_shutdown')).result.structuredContent.state,'stopped');});
async function stream(t, chunks, maxLineBytes=1024*1024) {const {h}=await setup(t);let data='';const output=new Writable({write(chunk,enc,cb){data+=chunk.toString();cb();}});await runStdio({input:Readable.from(chunks),output,handler:h,maxLineBytes});return data.trim().split('\n').filter(Boolean).map(JSON.parse);}
test('stdio decodes split UTF-8 frames and emits only JSON lines',async t=>{const raw=Buffer.from(JSON.stringify(msg('漢','ping'))+'\n');const lines=await stream(t,[raw.subarray(0,27),raw.subarray(27)]);assert.equal(lines[0].id,'漢');});
test('malformed UTF-8 and JSON get parse errors, later frames work',async t=>{const lines=await stream(t,[Buffer.from([0xff,10]),Buffer.from('oops\n'+JSON.stringify(msg(3,'ping'))+'\n')]);assert.deepEqual(lines.map(x=>x.error?.code??'ok'),[-32700,-32700,'ok']);});
test('oversized fragmented line is discarded and parser recovers at newline',async t=>{const lines=await stream(t,['x'.repeat(100),'y'.repeat(100),'\n'+JSON.stringify(msg(3,'ping'))+'\n'],64);assert.equal(lines.length,2);assert.equal(lines[0].error.code,-32600);assert.deepEqual(lines[1].result,{});});
test('unterminated final frame is not executed',async t=>{const lines=await stream(t,[JSON.stringify(msg(3,'ping'))]);assert.equal(lines[0].error.message,'Incomplete final frame');});
test('output failure closes service',async t=>{const {h,s}=await setup(t);await assert.rejects(runStdio({input:Readable.from([JSON.stringify(msg(1,'ping'))+'\n']),output:new Writable({write(c,e,cb){cb(Error('broken pipe'));}}),handler:h}));assert.equal(s.capabilities().state,'stopped');});
test('real CLI subprocess completes stdio initialize and shuts down on EOF',async t=>{const child=spawn(process.execPath,['src/cli.mjs'],{cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());const lines=[];const reader=createInterface({input:child.stdout});reader.on('line',line=>lines.push(JSON.parse(line)));let stderr='';child.stderr.on('data',x=>stderr+=x);const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});child.stdin.end(JSON.stringify(init)+'\n'+JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'+JSON.stringify(msg(2,'tools/list'))+'\n');assert.equal((await exited).code,0);assert.equal(lines.length,2);assert.equal(lines[1].result.tools.length,7);assert.equal(stderr,'');});
test('explicit null tool arguments are rejected without creating a session',async t=>{const {h,s}=await setup(t);const response=await h.handle(msg(8,'tools/call',{name:'khie_session_open',arguments:null}));assert.equal(response.result.isError,true);assert.equal(response.result.structuredContent.error.code,'INVALID_ARGUMENT');assert.equal((await s.shutdown()).sessionsClosed,0);});
test('older batch-requiring MCP version is not falsely advertised',async t=>{const {s}=await setup(t);const h=new McpHandler(s);const result=await h.handle({...init,params:{...init.params,protocolVersion:'2025-03-26'}});assert.equal(result.result.protocolVersion,'2025-11-25');});
test('saturated nonblocking recoveries leave stdio close, ping, cached reads and shutdown responsive',async t=>{
  let reads=0,aborted=0;
  const s=new KhieService({maxConcurrent:2,requestTimeoutMs:100,transportFactory:()=>({
    request:({requestId})=>requestId==='cached'?'cached-result':new Promise(()=>{}),
    recover:(_, {signal})=>{reads++;signal.addEventListener('abort',()=>aborted++,{once:true});return new Promise(()=>{});},close(){}
  })});t.after(()=>s.shutdown());const h=new McpHandler(s);await h.handle(init);await h.handle({jsonrpc:'2.0',method:'notifications/initialized'});
  const ids=[s.open().sessionId,s.open().sessionId,s.open().sessionId];await Promise.all(ids.map(id=>s.ready(id)));
  s.request({sessionId:ids[0],requestId:'cached',method:'get_info'});await new Promise(r=>setImmediate(r));
  for(const sessionId of ids)s.request({sessionId,requestId:'hung',method:'get_info'});
  for(let n=0;n<300&&ids.some(id=>s.result({sessionId:id,requestId:'hung'}).status!=='timed_out');n++)await new Promise(r=>setTimeout(r,2));
  assert.ok(ids.every(id=>s.result({sessionId:id,requestId:'hung'}).status==='timed_out'));
  const input=new PassThrough(),lines=[];const output=new Writable({write(chunk,_,cb){lines.push(JSON.parse(chunk.toString()));cb();}});
  const running=runStdio({input,output,handler:h});
  const requests=ids.map((sessionId,n)=>msg(10+n,'tools/call',{name:'khie_result',arguments:{sessionId,requestId:'hung',recover:true}}));
  requests.push(msg(20,'tools/call',{name:'khie_session_close',arguments:{sessionId:ids[0]}}),msg(21,'ping'),msg(22,'tools/call',{name:'khie_result',arguments:{sessionId:ids[0],requestId:'cached'}}),msg(23,'tools/call',{name:'khie_shutdown',arguments:{}}));
  input.write(requests.map(JSON.stringify).join('\n')+'\n');await new Promise(r=>setTimeout(r,20));
  assert.equal(lines.length,7);assert.equal(lines.find(x=>x.id===12).result.structuredContent.recovery.status,'busy');
  assert.equal(lines.find(x=>x.id===20).result.structuredContent.state,'closed');assert.equal(lines.find(x=>x.id===22).result.structuredContent.result,'cached-result');
  assert.equal(s.capabilities().state,'stopped');assert.equal(reads,2);assert.equal(aborted,2);input.end();await running;
});
for(const signal of ['SIGINT','SIGTERM'])test(`CLI ${signal} after a successful ping is a clean intentional shutdown`,{timeout:3000},async t=>{
  const child=spawn(process.execPath,['src/cli.mjs'],{cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const reader=createInterface({input:child.stdout});
  const replied=new Promise((resolve,reject)=>{reader.once('line',line=>{try{resolve(JSON.parse(line));}catch(error){reject(error);}});child.once('error',reject);});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  child.stdin.write(JSON.stringify(msg(1,'ping'))+'\n');assert.deepEqual((await replied).result,{});child.kill(signal);
  assert.deepEqual(await exited,{code:0,signal:null});assert.equal(stderr,'');
});
