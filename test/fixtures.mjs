import { Libp2p } from '@ckb-ccc/libp2p';
import { multiaddr } from '@multiformats/multiaddr';
export const RELAY = '/dns4/relay.ckbccc.com/tcp/443/wss';
export const RELAY_ID = '12D3KooWJ8vVZk6QpxCdu6iBqfQBvNqkgTZJgVn1NwQpPmyTn9zX';
export const PROVIDER_ID = '12D3KooWJ8vVZk6QpxCdu6iBqfQBvNqkgTZJgVn1NwQpPmyTn9zY';
export const ROUTE = `${RELAY}/p2p/${RELAY_ID}/p2p-circuit/p2p/${PROVIDER_ID}`;
export const config = (extra={}) => ({ enabled:true, relayAddress:RELAY,relayAllowlist:[RELAY],...extra });
export const endpoint = (addresses=[ROUTE],role='provider')=>Libp2p.encodePairingEndpoint('https://example.org/#pair',addresses.map(multiaddr),'public-fixture-not-a-real-pairing-secret',role);
export const defer = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export const tick=()=>new Promise(r=>setImmediate(r));
export function fakeRuntime({ createGate, relayGate, connectError, wrongPeer, changedInfo, stopError }={}) {
  const events=[],requests=[],signals=[];let unpaired;let infoCount=0;
  const node={async start(){events.push('start');},async stop(){events.push('node_stop');if(stopError)throw Error('fixture stop error');},services:{pairing:{async pair(target,{signal}){events.push('pair');signals.push(signal);return {toString:()=>wrongPeer??PROVIDER_ID};},onUnpaired(fn){unpaired=fn;return ()=>{events.push('unsubscribe');unpaired=undefined;};}}}};
  const runtime={async createNode(options){events.push('create_node');runtime.options=options;return createGate?await createGate.promise:node;},
    createRelay(){events.push('create_relay');return {async connect(){events.push('relay_connect');if(relayGate)await relayGate.promise;},async stop(){events.push('relay_stop');relayGate?.reject(Error('stopped fixture relay'));}};},
    createTransport(_,peer,{signal}){events.push('create_transport');signals.push(signal);return {async request(p,{signal}){requests.push(p);events.push(p.method);signals.push(signal);if(p.method==='connect'&&connectError)return {jsonrpc:'2.0',id:p.id,error:{code:-32003,message:'public fixture declined'}};return {jsonrpc:'2.0',id:p.id,result:p.method==='get_info'?{session_id:changedInfo&&++infoCount>1?'changed':'fixture-provider-session',name:'public fake wallet'}:p.method==='connect'?null:p.method==='get_scripts'?[]:p.method==='get_result'?{status:'completed',result:'public-recovered'}:'public-fixture-result'};}};}
  };
  return {runtime,node,events,requests,signals,emitUnpair:()=>unpaired?.({toString:()=>PROVIDER_ID})};
}
