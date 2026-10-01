import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, ServiceError } from '../src/service.ts';

const ua='off-mcp/0.1.0 (dev@example.org)';
const product=(code='1234', opts: Record<string,unknown>={})=>({status:'success',product:{code,product_name:'Example',nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{proteins:{value:2,unit:'mg'},salt:{value:0,unit:'g'}}},input_sets:[{per:'100g',preparation:'as_sold',source:'packaging',nutrients:{proteins:{value:2000,unit:'mg'}}}]},...opts}});
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers});
function fixture(respond:(url:URL,init:RequestInit)=>Response|Promise<Response>, clock?:()=>number){const urls:URL[]=[];const service=createService({userAgent:ua,now:clock,fetch:async(input,init)=>{const url=new URL(String(input));urls.push(url);return respond(url,init ?? {});}});return {service,urls};}
async function rejectsCode(p:Promise<unknown>,code:string){await assert.rejects(p,(e:unknown)=>e instanceof ServiceError && e.code===code);}

test('product v3 preserves barcode, normalized value and original unit, tags source, missing fields',async()=>{
  const {service,urls}=fixture((url,init)=>{assert.equal(init.method,'GET');assert.equal((init.headers as Record<string,string>)['User-Agent'],ua);return json(product('001234',{tags_sources:{foo:'bar'}}));});
  const out=await service.getProduct({barcode:'001234',language:'fr'});
  assert.equal((out.data as any).code,'001234');assert.equal((out.data as any).nutrition.aggregated_set.nutrients.proteins.value,2);
  assert.equal((out.data as any).nutrition.aggregated_set.nutrients.proteins.normalized_unit,'g');assert.equal((out.data as any).nutrition.aggregated_set.nutrients.proteins.entered_unit,'mg');
  assert.equal((out.data as any).nutrition.aggregated_set.nutrients.salt.value,0);
  assert.equal((out.data as any).nutrition.aggregated_set.nutrients.fat.value,null);
  assert.deepEqual((out.data as any).tags_sources,{foo:'bar'});
  assert.ok(out.missing_fields.includes('ingredients_text'));assert.ok(out.missing_fields.includes('allergens_tags'));assert.equal((out.data as any).allergens_tags,null);assert.equal(urls[0].searchParams.get('lc'),'fr');assert.ok(urls[0].searchParams.get('fields')?.includes('nutrition'));
});
test('v3 metadata and energy units follow the documented schema',async()=>{
  const {service}=fixture(()=>json(product('1234',{schema_version:1004,environmental_score_grade:'b',nutrition:{aggregated_set:{per:'100g',preparation:'as_sold',nutrients:{'energy-kj':{value:400,unit:'kcal'},'energy-kcal':{value:95,unit:'kJ'}}}}})));
  const data=(await service.getProduct({barcode:'1234'})).data as any;
  assert.equal(data.schema_version,1004);assert.equal(data.environmental_score_grade,'b');
  assert.equal(data.nutrition.aggregated_set.nutrients['energy-kj'].normalized_unit,'kJ');
  assert.equal(data.nutrition.aggregated_set.nutrients['energy-kcal'].normalized_unit,'kcal');
});
test('cache TTL and inflight dedup retain retrieval time; expiry spends request',async()=>{
  let t=1000,n=0,resolve!:()=>void;const gate=new Promise<void>(r=>resolve=r);
  const {service}=fixture(async()=>{n++;await gate;return json(product());},()=>t);
  const a=service.getProduct({barcode:'1234'}),b=service.getProduct({barcode:'1234'});resolve();
  const [one,two]=await Promise.all([a,b]);assert.equal(n,1);assert.equal(one.retrieved_at,two.retrieved_at);
  t+=1000;const hit=await service.getProduct({barcode:'1234'});assert.equal(hit.cache_hit,true);assert.equal(hit.retrieved_at,one.retrieved_at);
  t+=5*60_000;const fresh=await service.getProduct({barcode:'1234'});assert.equal(n,2);assert.equal(fresh.cache_hit,false);
});
test('product failure, HTTP 404, 429 cooldown, 5xx and invalid JSON have distinct errors',async()=>{
  await rejectsCode(fixture(()=>json({status:'failure'})).service.getProduct({barcode:'1234'}),'NOT_FOUND');
  await rejectsCode(fixture(()=>json({status:'success',product:{}})).service.getProduct({barcode:'1234'}),'UPSTREAM_SCHEMA');
  await rejectsCode(fixture(()=>new Response(null,{status:404})).service.getProduct({barcode:'1234'}),'NOT_FOUND');
  await rejectsCode(fixture(()=>new Response(null,{status:503})).service.getProduct({barcode:'1234'}),'UPSTREAM');
  await rejectsCode(fixture(()=>new Response('{', {status:200})).service.getProduct({barcode:'1234'}),'INVALID_JSON');
  let count=0;const {service}=fixture(()=>{count++;return new Response(null,{status:429,headers:{'Retry-After':'30'}});});
  await rejectsCode(service.getProduct({barcode:'1234'}),'RATE_LIMITED');await rejectsCode(service.getProduct({barcode:'1234'}),'RATE_LIMITED');assert.equal(count,1);
});
test('HTTP-date Retry-After and redirects are respected',async()=>{
  let t=Date.parse('2026-10-01T00:00:00Z'), count=0;
  const {service}=fixture(()=>{count++;return new Response(null,{status:429,headers:{'Retry-After':'Thu, 01 Oct 2026 00:02:00 GMT'}});},()=>t);
  await assert.rejects(service.getProduct({barcode:'1234'}),(e:unknown)=>e instanceof ServiceError && e.code==='RATE_LIMITED' && e.retry_after_seconds===120);
  await rejectsCode(service.getProduct({barcode:'1234'}),'RATE_LIMITED');assert.equal(count,1);
  const redir=fixture((_url,init)=>{assert.equal(init.redirect,'error');return new Response(null,{status:302,headers:{Location:'https://evil.test/'}});});
  await rejectsCode(redir.service.getProduct({barcode:'1234'}),'REDIRECT');
});
test('timeout, oversized body, UA validation and shared product budget',async()=>{
  await rejectsCode(fixture(()=>{throw new DOMException('Timeout','TimeoutError');}).service.getProduct({barcode:'1234'}),'TIMEOUT');
  const svc=createService({userAgent:ua,maxBodyBytes:10,fetch:async()=>json(product())});await rejectsCode(svc.getProduct({barcode:'1234'}),'BODY_TOO_LARGE');
  assert.throws(()=>createService({userAgent:'bad\nheader'}),ServiceError);
  const {service}=fixture((url)=>json(product(url.pathname.split('/').at(-1))));
  for(let i=0;i<15;i++) await service.getProduct({barcode:String(1000+i)});
  await rejectsCode(service.getProduct({barcode:'2000'}),'LOCAL_RATE_LIMIT');
});
test('v2 search pagination empty and allowlisted filters',async()=>{
  const {service,urls}=fixture(()=>json({products:[],count:0}));
  const out=await service.searchProducts({country:'fr',category:'en:snacks',nutriscore:'a',page_size:20});
  assert.deepEqual((out.data as any).products,[]);assert.equal((out.data as any).page_count,0);assert.equal((out.data as any).total_pages,0);
  assert.equal(urls[0].pathname,'/api/v2/search');assert.equal(urls[0].searchParams.get('countries_tags'),'fr');assert.equal(urls[0].searchParams.get('categories_tags'),'en:snacks');assert.equal(out.source.api_version,'v2');
  await rejectsCode(service.searchProducts({country:'https://evil.test'}),'INVALID_ARGUMENT');
});
test('unexpected search and autocomplete JSON is an upstream schema error',async()=>{
  const {service}=fixture(()=>json({message:'upstream changed'}));
  await rejectsCode(service.searchProducts({}),'UPSTREAM_SCHEMA');
  await rejectsCode(service.searchText({query:'apple'}),'UPSTREAM_SCHEMA');
  await rejectsCode(service.getTaxonomy({query:'apple',taxonomy:'categories'}),'UPSTREAM_SCHEMA');
});
test('search text and taxonomy encode query and bound results',async()=>{
  const {service,urls}=fixture(url=>url.pathname==='/search'?json({hits:[{code:'1234',product_name:'A'}],count:1,is_count_exact:true}):json({results:[{id:'en:apple'}]}));
  const a=await service.searchText({query:'crème & chocolat',language:'fr'});assert.equal((a.data as any).page_count,1);assert.equal(urls[0].searchParams.get('q'),'crème & chocolat');assert.equal(urls[0].searchParams.get('page_size'),'10');assert.equal(urls[0].searchParams.has('size'),false);
  const b=await service.getTaxonomy({query:'pom &',taxonomy:'categories',language:'fr',limit:2});assert.equal((b.data as any).suggestions.length,1);assert.equal(urls[1].searchParams.get('taxonomy_names'),'categories');
});
test('comparison refuses incompatible bases and prepared products, preserves per-product source',async()=>{
  const {service}=fixture(url=>json(product(url.pathname.split('/').at(-1),{nutrition:{aggregated_set:{per:url.pathname.endsWith('1111')?'100g':'100ml',preparation:'as_sold',nutrients:{proteins:{value:1}}}}})));
  const out=await service.compareProducts({barcodes:['1111','2222']});assert.equal((out.data as any).comparison,null);assert.equal((out.data as any).products.length,2);assert.equal((out.data as any).products[0].source.api_version,'v3.6');
  const prepared=fixture(url=>json(product(url.pathname.split('/').at(-1),{nutrition:{aggregated_set:{per:'100g',preparation:'prepared',nutrients:{}}}})));
  assert.equal((await prepared.service.compareProducts({barcodes:['1111','2222']})).data instanceof Object,true);
  assert.equal(((await prepared.service.compareProducts({barcodes:['1111','2222']})).data as any).comparison,null);
});
