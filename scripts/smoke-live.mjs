import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const report={started_at:new Date().toISOString(),status:'FAIL',checks:[]};
const userAgent=process.env.OFF_USER_AGENT;
function timeout(promise,ms,label) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(`${label} timed out after ${ms} ms`)),ms);
  })]).finally(()=>clearTimeout(timer));
}
function source(value) {
  assert.equal(typeof value?.service,'string');
  assert.equal(typeof value?.api_version,'string');
  for(const item of value.url.split(' , ')) {
    const url=new URL(item); assert.equal(url.protocol,'https:');
    assert.ok(['world.openfoodfacts.org','search.openfoodfacts.org'].includes(url.hostname));
  }
}
if(!userAgent) {
  report.checks.push({tool:'startup',ok:false,error:'OFF_USER_AGENT is required'});
} else {
  const transport=new StdioClientTransport({
    command:process.execPath,
    args:['--experimental-strip-types',fileURLToPath(new URL('../src/index.ts',import.meta.url))],
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{OFF_USER_AGENT:userAgent},stderr:'pipe',
  });
  const client=new Client({name:'off-live-smoke',version:'0.1.0'});
  let childStderr='';
  transport.stderr?.on('data',chunk=>{childStderr=(childStderr+chunk.toString()).slice(-2000);});
  async function call(tool,args,verify) {
    const entry={tool,args,ok:false};report.checks.push(entry);
    try {
      const result=await timeout(client.callTool({name:tool,arguments:args}),20000,tool);
      if(result.isError) throw new Error(JSON.stringify(result.structuredContent??result.content));
      const envelope=result.structuredContent;
      assert.ok(envelope);
      const text=result.content?.find(block=>block.type==='text');assert.ok(text);
      assert.deepEqual(JSON.parse(text.text),envelope);
      source(envelope.source);
      assert.ok(Number.isFinite(Date.parse(envelope.retrieved_at)));
      assert.equal(typeof envelope.cache_hit,'boolean');
      assert.ok(Array.isArray(envelope.missing_fields)&&Array.isArray(envelope.warnings));
      assert.ok(envelope.data&&typeof envelope.data==='object');
      entry.evidence=verify(envelope.data,envelope);
      Object.assign(entry,{source:envelope.source,retrieved_at:envelope.retrieved_at,cache_hit:envelope.cache_hit,missing_fields:envelope.missing_fields,warnings:envelope.warnings,ok:true});
    } catch(error) {entry.error=error instanceof Error?error.message:String(error);}
  }
  try {
    await timeout(client.connect(transport),20000,'MCP initialize');
    const listed=await timeout(client.listTools(),20000,'tools/list');
    assert.deepEqual(listed.tools.map(t=>t.name).sort(),['compare_products','get_product','get_taxonomy','search_products','search_text']);
    for(const barcode of ['3017620422003','3017620425035']) {
      await call('get_product',{barcode,language:'en'},data=>{
        assert.equal(data.code,barcode);assert.ok(typeof data.product_name==='string'&&data.product_name.length);
        const n=data.nutrition?.aggregated_set;
        assert.equal(n?.per,'100g');assert.equal(n?.preparation,'as_sold');assert.ok(Number.isFinite(n?.nutrients?.proteins?.value));
        return {code:data.code,product_name:data.product_name,basis:`${n.per}:${n.preparation}`,proteins:n.nutrients.proteins.value};
      });
    }
    await call('search_products',{brand:'nutella',page_size:2,language:'en'},data=>{
      assert.ok(Array.isArray(data.products)&&data.products.length>0&&data.products.length<=2);
      assert.equal(data.page_count,data.products.length);assert.ok(data.products.every(p=>typeof p.code==='string'));
      return {page_count:data.page_count,count:data.count,codes:data.products.map(p=>p.code)};
    });
    await call('search_text',{query:'nutella',page_size:2,language:'en'},data=>{
      assert.ok(Array.isArray(data.products)&&data.products.length>0&&data.products.length<=2);
      assert.equal(data.page_count,data.products.length);assert.ok(data.products.some(p=>typeof p.brands==='string'&&p.brands.length>0));
      return {page_count:data.page_count,count:data.count,products:data.products.map(p=>({code:p.code,brands:p.brands}))};
    });
    await call('get_taxonomy',{query:'choc',taxonomy:'categories',language:'en',limit:2},data=>{
      assert.ok(Array.isArray(data.suggestions)&&data.suggestions.length>0&&data.suggestions.length<=2);
      assert.ok(data.suggestions.every(p=>typeof p.id==='string'&&p.id.length>0&&typeof p.text==='string'&&p.text.length>0));
      return {suggestions:data.suggestions.map(({id,text})=>({id,text}))};
    });
    await call('compare_products',{barcodes:['3017620422003','3017620425035'],language:'en'},data=>{
      assert.equal(data.comparison?.basis,'100g:as_sold');assert.equal(data.products?.length,2);
      assert.ok(data.products.every(p=>p.cache_hit===true));for(const p of data.products)source(p.source);
      const proteins=data.comparison.nutrients?.proteins;
      assert.ok(Array.isArray(proteins)&&proteins.length===2&&proteins.every(p=>Number.isFinite(p?.value)));
      return {basis:data.comparison.basis,codes:data.products.map(p=>p.data.code),product_cache_hits:data.products.map(p=>p.cache_hit),proteins:proteins.map(p=>p.value)};
    });
  } catch(error) {report.checks.push({tool:'MCP connection',ok:false,error:error instanceof Error?error.message:String(error)});}
  finally {
    try {await timeout(client.close(),5000,'MCP close');}
    catch(error) {report.checks.push({tool:'MCP close',ok:false,error:error instanceof Error?error.message:String(error)});}
  }
  if(childStderr)report.child_stderr=childStderr;
}
report.status=report.checks.length===6&&report.checks.every(check=>check.ok)?'PASS':'FAIL';
report.finished_at=new Date().toISOString();
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
if(report.status!=='PASS')process.exitCode=1;
