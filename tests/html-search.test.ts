import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createService, ServiceError } from '../src/service.ts';
import { parseHtmlSearch, HtmlSearchError } from '../src/html-search.ts';

const ua = 'off-html-test/0.1.0 (test@example.org)';
// Real HTML captured via connected Firecrawl MCP on 2026-10-06; source URL in SOURCES.md.
const real = readFileSync(new URL('../fixtures/search-category-page1.real.html', import.meta.url), 'utf8');
const realUrl = 'https://world.openfoodfacts.org/cgi/search.pl?action=process&tagtype_0=categories&tag_contains_0=contains&tag_0=en%3Achocolates&page_size=1&page=1';
const code = '3046920029759';
const hit = (extra: Record<string,unknown> = {}) => ({ code:'1234',product_display_name:'A &amp; B',url:'https://world-fr.openfoodfacts.org/produit/1234/a',image_front_small_url:'https://images.openfoodfacts.org/images/products/123/4/front.jpg',...extra });
function synthetic(url: URL, products: unknown[] = [hit()], opts: {count?:number;empty?:boolean;page?:number;canonical?:string;script?:string;noPager?:boolean} = {}) {
  const count = opts.count ?? products.length, page = opts.page ?? Number(url.searchParams.get('page') ?? 1);
  const canonical = (opts.canonical ?? url.toString()).replaceAll('&','&amp;');
  const pager = opts.noPager ? '' : `<ul id="pages"><li class="current"><a>${page}</a></li><li class="unavailable">(${url.searchParams.get('page_size')} products per page)</li></ul>`;
  return `<html><head><link rel="canonical" href="${canonical}"></head><body><span class="filterProducts__results"><span>search</span>${count} products</span></div>${opts.empty?'<p>No products.</p>':''}${pager}<script>var page_type = "products"; var products = ${opts.script ?? JSON.stringify(products)};</script></body></html>`;
}
function fixture(respond: (u:URL,init:RequestInit)=>Response|Promise<Response>, config: Record<string,unknown> = {}) {
  const seen: {url:URL;init:RequestInit}[]=[];
  const service=createService({userAgent:ua,...config,fetch:async (input,init)=>{const url=new URL(String(input));seen.push({url,init:init??{}});return respond(url,init??{});}});
  return {service,seen};
}
const html = (body:string,status=200,headers:Record<string,string>={})=>new Response(body,{status,headers:{'Content-Type':'text/html',...headers}});
async function rejectsCode(p:Promise<unknown>,code:string) { await assert.rejects(p,(e:unknown)=>e instanceof ServiceError && e.code===code); }

test('real captured OFF page parses fixed HTML projection and scores from icons, not grades',async()=>{
  const parsed=parseHtmlSearch(real,realUrl,1,1);
  assert.equal(parsed.count_reported,32862);assert.equal(parsed.reported_total_pages,null);assert.equal(parsed.products.length,1);
  const p=parsed.products[0];assert.equal(p.code,code);assert.equal(p.product_display_name,'Extra fine dark chocolate – Lindt – 100g');
  assert.equal(p.nutriscore_grade,'e');assert.equal(p.nova_group,3);assert.equal(p.ecoscore_grade,'e');
  assert.equal(p.product_name,null);assert.equal(p.brands,null);assert.equal(p.legacy_nutriments,null);
  assert.match(String(p.url),/^https:\/\/world\.openfoodfacts\.org\/product\//u);
  const {service,seen}=fixture((_u,init)=>{assert.equal((init.headers as Record<string,string>).Accept,'text/html');assert.equal((init.headers as Record<string,string>)['User-Agent'],ua);assert.equal(init.redirect,'error');return html(real);});
  const out=await service.searchProducts({category:'en:chocolates',page_size:1});
  assert.equal(seen.length,1);assert.equal(out.source.api_version,'html');assert.equal(out.source.service,'Open Food Facts');
  const d=out.data as any;assert.equal(d.page_count,1);assert.equal(d.count,null);assert.equal(d.count_reported,32862);assert.equal(d.is_count_exact,null);assert.equal(d.total_pages,null);
  assert.ok(out.missing_fields.includes('product_name'));
});

test('four filters use contiguous CGI indices, HTML GET, bounded pagination and encoded tags',async()=>{
  const {service,seen}=fixture(u=>html(synthetic(u)));
  const out=await service.searchProducts({country:'en:france',category:'en:chocolates',brand:'nutella',nutriscore:'a',page:2,page_size:5,language:'fr'});
  assert.equal((out.data as any).page,2);assert.equal(seen.length,1);
  const u=seen[0].url;assert.equal(u.pathname,'/cgi/search.pl');assert.equal(u.searchParams.get('action'),'process');assert.equal(u.searchParams.get('page'),'2');assert.equal(u.searchParams.get('page_size'),'5');assert.equal(u.searchParams.get('lc'),'fr');
  for(const [i,type,tag] of [[0,'countries','en:france'],[1,'categories','en:chocolates'],[2,'brands','nutella'],[3,'nutrition_grades','a']] as const){assert.equal(u.searchParams.get(`tagtype_${i}`),type);assert.equal(u.searchParams.get(`tag_contains_${i}`),'contains');assert.equal(u.searchParams.get(`tag_${i}`),tag);}
  assert.equal(u.searchParams.has('tagtype_4'),false);
  await rejectsCode(service.searchProducts({page:11}),'INVALID_ARGUMENT');await rejectsCode(service.searchProducts({page_size:21}),'INVALID_ARGUMENT');await rejectsCode(service.searchProducts({brand:'x OR y'}),'INVALID_ARGUMENT');await rejectsCode(service.searchProducts({country:'https://evil.test'}),'INVALID_ARGUMENT');
  assert.equal(seen.length,1);
});

test('unfiltered query has no tag fields; page two requires matching pager and criteria',async()=>{
  const {service,seen}=fixture(u=>html(synthetic(u)));
  await service.searchProducts({page:2,page_size:1});assert.equal([...seen[0].url.searchParams.keys()].some(k=>k.startsWith('tag')),false);
  const wrong=fixture(u=>html(synthetic(u,[hit()],{page:1})));
  await rejectsCode(wrong.service.searchProducts({page:2,page_size:1}),'HTML_SCHEMA');
  const altered=fixture(u=>{const v=new URL(u);v.searchParams.set('tag_0','en:beef');return html(synthetic(u,[hit()],{canonical:v.toString()}));});
  await rejectsCode(altered.service.searchProducts({category:'en:chocolates',page_size:1}),'HTML_SCHEMA');
});

test('explicit no-products signal permits zero; loader JSON and HTTP 200 error page never become empty success',async()=>{
  const good=fixture(u=>html(synthetic(u,[],{count:0,empty:true,noPager:true})));
  assert.equal((await good.service.searchProducts({})).data instanceof Object,true);
  const loader=fixture(u=>html(synthetic(u,[],{count:0,noPager:true})+'<script>fetch("/api/v2/search")</script>'));
  await rejectsCode(loader.service.searchProducts({}),'HTML_SCHEMA');
  await rejectsCode(fixture(()=>html('<html><h1>Server error</h1></html>')).service.searchProducts({}),'HTML_SCHEMA');
  await rejectsCode(fixture(()=>html('<html><h1>Server error</h1></html>',503)).service.searchProducts({}),'UPSTREAM');
});

test('malformed embedded JSON, duplicate/invalid codes and oversized hit array fail closed',async()=>{
  await rejectsCode(fixture(u=>html(synthetic(u,[],{script:'[{"code":"1234"}' }))).service.searchProducts({}),'HTML_SCHEMA');
  await rejectsCode(fixture(u=>html(synthetic(u,[hit(),hit()],{count:2}))).service.searchProducts({page_size:2}),'HTML_SCHEMA');
  await rejectsCode(fixture(u=>html(synthetic(u,[hit({code:'abc'})]))).service.searchProducts({}),'HTML_SCHEMA');
  await rejectsCode(fixture(u=>html(synthetic(u,[hit(),hit({code:'5678'})]))).service.searchProducts({page_size:1}),'HTML_SCHEMA');
  const noJs=synthetic(new URL(realUrl),[hit({product_display_name:'x ]; alert(1); y'})]);
  assert.equal(parseHtmlSearch(noJs,realUrl,1,1).products[0].product_display_name,'x ]; alert(1); y');
});

test('unknown or unsafe URLs stay null, HTML entities decode once, status controls score extraction',async()=>{
  const attributes=[{attributes:[{id:'nutriscore',status:'unknown',grade:'a',icon_url:'https://static.openfoodfacts.org/images/attributes/dist/nutriscore-a.svg'},{id:'nova',status:'known',grade:'b',icon_url:'https://evil.test/nova-group-2.svg'},{id:'ecoscore',status:'known',grade:'d',icon_url:'https://static.openfoodfacts.org/images/attributes/dist/green-score-e.svg'}]}];
  const u=new URL(realUrl);const p=parseHtmlSearch(synthetic(u,[hit({url:'https://evil.openfoodfacts.org.evil.test/product/1234/a',image_front_small_url:'https://images.openfoodfacts.org@evil.test/images/products/1.jpg',attribute_groups:attributes})]),realUrl,1,1).products[0];
  assert.equal(p.url,null);assert.equal(p.image_front_small_url,null);assert.equal(p.product_display_name,'A & B');assert.equal(p.nutriscore_grade,null);assert.equal(p.nova_group,null);assert.equal(p.ecoscore_grade,'e');
});

test('content type, length/body limit and stalled stream after headers are errors',async()=>{
  await rejectsCode(fixture(()=>new Response('{}',{headers:{'Content-Type':'application/json'}})).service.searchProducts({}),'HTML_SCHEMA');
  await rejectsCode(fixture(()=>html('x',200,{'Content-Length':'1000001'})).service.searchProducts({}),'BODY_TOO_LARGE');
  await rejectsCode(fixture(()=>html('x'.repeat(5000)),{maxBodyBytes:100}).service.searchProducts({}),'BODY_TOO_LARGE');
  const stalled=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('<html>'));}}),{headers:{'Content-Type':'text/html'}}),{timeoutMs:30});
  await rejectsCode(stalled.service.searchProducts({}),'TIMEOUT');
});

test('search cache TTL and local budget remain shared with text search',async()=>{
  let now=1000;const {service,seen}=fixture(u=>u.pathname==='/cgi/search.pl'?html(synthetic(u)):new Response(JSON.stringify({hits:[],count:0,is_count_exact:true})),{now:()=>now});
  await service.searchProducts({page_size:1});assert.equal((await service.searchProducts({page_size:1})).cache_hit,true);assert.equal(seen.length,1);
  now+=60_001;await service.searchProducts({page_size:1});assert.equal(seen.length,2);
  for(let i=0;i<9;i++) await service.searchText({query:'query'+i});
  await rejectsCode(service.searchProducts({page_size:2}),'LOCAL_RATE_LIMIT');assert.equal(seen.length,11);
});


test('displayed counts accept strict thousands groups and reject decimals or abbreviations',async()=>{
  const u=new URL(realUrl);
  for(const count of ['1,234','1.234','1 234','1\u00a0234','1\u202f234']) {
    const page=synthetic(u,[hit()],{count:1234}).replace('1234 products',`${count} products`);
    assert.equal(parseHtmlSearch(page,realUrl,1,1).count_reported,1234);
  }
  for(const count of ['1.2','1.2k','1,23','1,234.56','1 23']) {
    const page=synthetic(u,[hit()],{count:1234}).replace('1234 products',`${count} products`);
    assert.throws(()=>parseHtmlSearch(page,realUrl,1,1),HtmlSearchError,count);
  }
});

test('language echo requires exact lc or matching localized world host',async()=>{
  const u=new URL(realUrl);u.searchParams.set('lc','fr');
  const withoutLc=new URL(u);withoutLc.searchParams.delete('lc');
  const bad=synthetic(u,[hit()],{canonical:withoutLc.toString()});
  assert.throws(()=>parseHtmlSearch(bad,u.toString(),1,1),HtmlSearchError);
  withoutLc.hostname='world-fr.openfoodfacts.org';
  const good=synthetic(u,[hit()],{canonical:withoutLc.toString()});
  assert.equal(parseHtmlSearch(good,u.toString(),1,1).products.length,1);
  const explicit=synthetic(u,[hit()]);
  assert.equal(parseHtmlSearch(explicit,u.toString(),1,1).products.length,1);
});

test('missing_fields lists absent optional HTML values without inventing them',async()=>{
  const {service}=fixture(u=>html(synthetic(u,[hit({product_display_name:'',url:'https://evil.test/product/1234',image_front_small_url:null})])));
  const result=await service.searchProducts({page_size:1});
  for(const field of ['product_name','brands','categories_tags','countries_tags','legacy_nutriments','last_modified_t','product_display_name','url','image_front_small_url','nutriscore_grade','nova_group','ecoscore_grade']) assert.ok(result.missing_fields.includes(field),field);
});
