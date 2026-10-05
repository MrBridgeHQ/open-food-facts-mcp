import test from 'node:test';
import assert from 'node:assert/strict';
import { createService, ServiceError } from '../src/service.ts';
const userAgent='off-regression/0.1.0 (fixture@example.org)';
function service(body: unknown, inspect?: (url: URL) => void) {
  return createService({userAgent,fetch: async input => {
    inspect?.(new URL(String(input)));
    return new Response(JSON.stringify(body), {status:200});
  }});
}
test('Search-a-licious brand arrays survive normalization', async () => {
  const body={hits:[{code:'0009800800049',product_name:'Nutella & go!',brands:['Nutella']}],count:1,is_count_exact:true};
  const result=await service(body).searchText({query:'nutella',page_size:2});
  assert.equal((result.data as any).products[0].brands,'Nutella');
});
test('live autocomplete options and deployed category alias are supported', async () => {
  const option={id:'en:sprinkles',text:'Chocolat or sugar sprinkles',taxonomy_name:'category'};
  const result=await service({options:[option]}, url => {
    assert.equal(url.searchParams.get('taxonomy_names'),'categories,category');
  }).getTaxonomy({query:'choc',taxonomy:'categories',language:'en',limit:2});
  assert.deepEqual((result.data as any).suggestions,[option]);
});
test('an empty autocomplete options array is a valid empty result', async () => {
  const result=await service({options:[]}).getTaxonomy({query:'no-match',taxonomy:'categories'});
  assert.deepEqual((result.data as any).suggestions,[]);
});
test('malformed options cannot be hidden by a legacy fallback array', async () => {
  for(const options of [null,{},'invalid']) {
    await assert.rejects(service({options,results:[]}).getTaxonomy({query:'choc',taxonomy:'categories'}),
      error => error instanceof ServiceError && error.code==='UPSTREAM_SCHEMA');
  }
});
