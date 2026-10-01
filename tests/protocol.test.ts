import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpServer } from '../src/server.ts';
import { fileURLToPath } from 'node:url';

test('SDK v2 initializes, lists five read-only tools, and calls one offline',async()=>{
  const server=createMcpServer({userAgent:'off-mcp/0.1.0 (dev@example.org)',fetch:async(input)=>{const path=new URL(String(input)).pathname;return new Response(JSON.stringify(path.includes('/product/')?{status:'success',product:{code:path.split('/').at(-1),product_name:'Fixture'}}:path.includes('autocomplete')?{results:[]}:path.includes('/api/v2/search')?{products:[],count:0}:{hits:[],count:0,is_count_exact:true}));}});
  const client=new Client({name:'offline-test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),['compare_products','get_product','get_taxonomy','search_products','search_text']);
  for(const tool of list.tools){assert.equal(tool.annotations?.readOnlyHint,true);assert.equal(tool.annotations?.destructiveHint,false);}
  try {
    const calls=[['get_product',{barcode:'1234'}],['search_products',{}],['search_text',{query:'fixture'}],['get_taxonomy',{query:'fixture',taxonomy:'categories'}],['compare_products',{barcodes:['1234','5678']}]] as const;
    for(const [name,args] of calls){const response=await client.callTool({name,arguments:args});assert.equal(response.isError,undefined,name);assert.deepEqual(response.structuredContent,JSON.parse((response.content[0] as any).text),name);}
  } finally {await client.close();await server.close();}
});
test('stdio CLI initializes and rejects invalid barcode before any network call',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:['--experimental-strip-types',fileURLToPath(new URL('../src/index.ts',import.meta.url))],cwd:fileURLToPath(new URL('..',import.meta.url)),stderr:'pipe',env:{OFF_USER_AGENT:'off-mcp/0.1.0 (dev@example.org)'}});
  const client=new Client({name:'stdio-offline-test',version:'1.0.0'});
  let childError=''; transport.stderr?.on('data',(chunk:Buffer)=>{childError+=chunk.toString();});
  try {await client.connect(transport);assert.equal((await client.listTools()).tools.length,5);const response=await client.callTool({name:'get_product',arguments:{barcode:'bad'}});assert.equal(response.isError,true);}
  catch(e) { throw new Error(`${(e as Error).message}; child stderr: ${childError}`); }
  finally {await client.close();}
});
