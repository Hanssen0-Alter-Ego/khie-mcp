import test from 'node:test';
import assert from 'node:assert/strict';
import { SignerJsonRpcProviderSession } from '@ckb-ccc/core';
import { Libp2p } from '@ckb-ccc/libp2p';
import { KhieRpcAdapter } from '../src/adapter.mjs';

test('new adapter interoperates with pinned real CCC provider using only fake wallet methods',async t=>{
  // Upstream cache uses 120-second timers; fake the clock so the fixture cannot leave timer handles.
  t.mock.timers.enable({apis:['setTimeout']});
  let identityReads=0;const confirmations=[];
  const fake={type:'CKB',signType:'CKB',client:{addressPrefix:'ckt'},async getIdentity(){identityReads++;return 'fixture:identity';}};
  const owner=SignerJsonRpcProviderSession.open({getSigner:()=>fake,connect:async()=>fake,confirmRequest:async action=>{confirmations.push(action.method);return action.method==='connect';}});
  const transport={async request(p){try{return {jsonrpc:'2.0',id:p.id,result:await owner.value.handle(p)};}catch(e){return {jsonrpc:'2.0',id:p.id,error:{code:e.code??-32000,message:'fixture provider error'}};}}};
  try {
    const info=(await transport.request({jsonrpc:'2.0',id:'setup-info',method:'get_info',params:[{request_id:'setup-info'}]})).result;
    // This is an explicit fake-wallet confirmation in a fixture, not any real wallet operation.
    await transport.request({jsonrpc:'2.0',id:'setup-connect',method:'connect',params:[{request_id:'setup-connect',session_id:info.session_id},'ckb-testnet']});
    const a=new KhieRpcAdapter({transport,providerSessionId:info.session_id});
    const options={signal:new AbortController().signal};await a.ready(options);
    assert.equal(await a.request({requestId:'identity-1',method:'get_identity',params:[]},options),'fixture:identity');
    assert.deepEqual(await a.recover({requestId:'identity-1'},options),{status:'completed',result:'fixture:identity'});
    await assert.rejects(a.request({requestId:'identity-1',method:'get_identity',params:[]},options),e=>e.code==='DUPLICATE_REMOTE_REQUEST');
    assert.equal(identityReads,1);assert.deepEqual(confirmations,['connect']);await a.close();
  } finally {await owner.dispose();t.mock.timers.tick(120_001);t.mock.timers.reset();}
});
test('pinned pairing codec rejects incompatible role and malformed public fixture',async()=>{
  await assert.rejects(Libp2p.decodePairingEndpoint('https://example.invalid/#connect?role=connector&addresses=eA&secret=public-fixture','provider'),e=>e instanceof Libp2p.PairingEndpointRoleError);
  await assert.rejects(Libp2p.decodePairingEndpoint('https://example.invalid/#connect?role=provider&addresses=invalid&secret=public-fixture','provider'),e=>e instanceof Libp2p.PairingEndpointError);
});
