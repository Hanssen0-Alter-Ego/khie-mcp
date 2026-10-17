import test from 'node:test';
import assert from 'node:assert/strict';
import { SignerJsonRpcProviderSession } from '@ckb-ccc/core';
import { createLiveFactory } from '../src/live.mjs';
import { config,endpoint,fakeRuntime } from './fixtures.mjs';
// Regression contributed by the independent adapter review, using public fake values only.
test('all four live read methods match real pinned CCC provider wire shapes with a wholly fake signer', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 const actions=[], methods=[];
 const fakeSigner={type:'CKB',signType:'CKB',client:{addressPrefix:'ckt'}, async getIdentity(){return 'public-fixture-identity';},async getInternalAddress(){return 'public-fixture-address';},async getAddressObjs(){return [{script:{codeHash:'0x'+'0'.repeat(64),hashType:'type',args:'0x'}}];}};
 const owner=SignerJsonRpcProviderSession.open({getSigner:()=>fakeSigner,connect:async()=>fakeSigner,confirmRequest:async action=>{actions.push(action.method);return action.method==='connect';}});
 const f=fakeRuntime();f.runtime.createTransport=()=>({async request(payload){methods.push(payload.method);try{return {jsonrpc:'2.0',id:payload.id,result:await owner.value.handle(payload)};}catch(e){return {jsonrpc:'2.0',id:payload.id,error:{code:e.code??-32000,message:'redacted-fixture-error'}};}}});
 let adapter;
 try {
 const factory=await createLiveFactory({config:config({connectNetwork:'ckb-testnet'}),endpoint:await endpoint(),runtimeLoader:async()=>f.runtime});adapter=factory.transportFactory();
 await adapter.ready({signal:new AbortController().signal});
 const request=method=>adapter.request({requestId:method,method,params:[]});
 assert.ok((await request('get_info')).session_id);
 assert.deepEqual(await request('get_scripts'),[{code_hash:'0x'+'0'.repeat(64),hash_type:'type',args:'0x'}]);
 assert.equal(await request('get_native_address'),'public-fixture-address');
 assert.equal(await request('get_identity'),'public-fixture-identity');
 assert.deepEqual(await adapter.recover({requestId:'get_identity'}),{status:'completed',result:'public-fixture-identity'});
 assert.deepEqual(actions,['connect']);
 assert.deepEqual(methods,['get_info','connect','get_info','get_scripts','get_native_address','get_identity','get_result']);
 } finally {await adapter?.close();await owner.dispose();t.mock.timers.tick(120001);t.mock.timers.reset();}
});
