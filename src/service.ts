export type JsonObject = Record<string, unknown>;
export type Kind = 'product' | 'search' | 'taxonomy';
export type Envelope<T = unknown> = {
  source: { service: string; api_version: string; url: string };
  retrieved_at: string;
  cache_hit: boolean;
  data: T;
  missing_fields: string[];
  warnings: string[];
};
export class ServiceError extends Error {
  readonly code: string;
  readonly retry_after_seconds?: number;
  constructor(code: string, message: string, retry_after_seconds?: number) { super(message); this.code=code; this.retry_after_seconds=retry_after_seconds; }
}
export interface Config {
  fetch?: typeof fetch;
  now?: () => number;
  userAgent: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  cacheMax?: number;
}
const PRODUCT_FIELDS = ['code','product_name','product_name_en','brands','brands_tags','categories_tags','countries_tags','ingredients_text','ingredients_text_en','ingredients_analysis_tags','allergens_tags','traces_tags','nutriscore_grade','nova_group','environmental_score_grade','nutrition','nutriments','selected_images','image_url','last_modified_t','schema_version','tags_sources'];
const SEARCH_FIELDS = ['code','product_name','brands','categories_tags','countries_tags','nutriscore_grade','nova_group','ecoscore_grade','nutriments','last_modified_t'];
const BASE = { product: 'https://world.openfoodfacts.org', search: 'https://search.openfoodfacts.org', taxonomy: 'https://search.openfoodfacts.org' } as const;
const LIMIT = { product: 15, search: 10, taxonomy: 10 } as const;
const TTL = { product: 5 * 60_000, search: 60_000, taxonomy: 10 * 60_000 } as const;
const NUTRIENTS = ['energy','energy-kj','energy-kcal','fat','saturated-fat','carbohydrates','sugars','fiber','proteins','salt','sodium'];

function object(v: unknown): JsonObject { return v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {}; }
function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function brandsText(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (!Array.isArray(v)) return null;
  const names = v.map(str).filter((name): name is string => name !== null);
  return names.length ? names.join(', ') : null;
}
function positiveNumber(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function boundedText(v: unknown, warnings: string[], field: string): string | null {
  const s = str(v); if (!s) return null;
  if (s.length > 2000) { warnings.push(`${field} truncated to 2000 characters`); return s.slice(0, 2000); }
  return s;
}
function requiredString(v: unknown, name: string, max = 100): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/u.test(v)) throw new ServiceError('INVALID_ARGUMENT', `${name} must be a nonempty string of at most ${max} characters`);
  return v.trim();
}
function language(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = requiredString(v, 'language', 10).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/u.test(s)) throw new ServiceError('INVALID_ARGUMENT', 'language must be a language code');
  return s;
}
function page(v: unknown, name: string, fallback: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) throw new ServiceError('INVALID_ARGUMENT', `${name} must be an integer from 1 to ${max}`);
  return v;
}
function barcode(v: unknown): string {
  const s = requiredString(v, 'barcode', 32);
  if (!/^[0-9]{4,32}$/u.test(s)) throw new ServiceError('INVALID_ARGUMENT', 'barcode must contain 4–32 digits');
  return s;
}
function tags(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  const s = requiredString(v, name, 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9:_-]*$/u.test(s)) throw new ServiceError('INVALID_ARGUMENT', `${name} must be a taxonomy tag or slug`);
  return s;
}
function qUrl(path: string, params: Record<string, string | undefined>, kind: Kind): string {
  const u = new URL(path, BASE[kind]);
  for (const [k,v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k,v);
  return u.toString();
}
function source(kind: Kind, url: string) { return { service: url.includes('/cgi/') || url.includes('/api/v2/') ? 'Open Food Facts' : kind === 'product' ? 'Open Food Facts' : 'Open Food Facts Search-a-licious', api_version: url.includes('/api/v2/') ? 'v2' : kind === 'product' ? 'v3.6' : kind === 'search' ? 'search-a-licious' : 'autocomplete', url }; }
function normalizedNutrient(v: unknown, key: string): JsonObject {
  const o = object(v);
  const val = positiveNumber(o.value) ?? positiveNumber(o.value_computed);
  // The v3 aggregated set uses normalized values even if `unit` reflects original entry.
  return { value: val, normalized_unit: key === 'energy' || key === 'energy-kj' ? 'kJ' : key === 'energy-kcal' ? 'kcal' : 'g', entered_unit: str(o.unit), modifier: str(o.modifier), source: str(o.source), source_per: str(o.source_per), value_computed: positiveNumber(o.value_computed) };
}
function selectProduct(raw: unknown, warnings: string[]): JsonObject {
  const p = object(raw), nutrition = object(p.nutrition), agg = object(nutrition.aggregated_set);
  const nutrients = object(agg.nutrients); const selected: JsonObject = {};
  for (const key of NUTRIENTS) selected[key] = normalizedNutrient(nutrients[key], key);
  const inputs = Array.isArray(nutrition.input_sets) ? nutrition.input_sets.slice(0, 12).map((v: unknown) => {
    const s = object(v); const n = object(s.nutrients); const values: JsonObject = {};
    for (const key of NUTRIENTS) if (n[key] !== undefined) values[key] = n[key];
    return { preparation: str(s.preparation), per: str(s.per), per_quantity: positiveNumber(s.per_quantity), per_unit: str(s.per_unit), source: str(s.source), source_description: str(s.source_description), last_updated_t: positiveNumber(s.last_updated_t), nutrients: values };
  }) : [];
  if (Array.isArray(nutrition.input_sets) && nutrition.input_sets.length > 12) warnings.push('nutrition.input_sets truncated to 12 sets');
  return { code: str(p.code), product_name: str(p.product_name) ?? str(p.product_name_en), brands: str(p.brands), categories_tags: Array.isArray(p.categories_tags) ? p.categories_tags.slice(0,30) : [], countries_tags: Array.isArray(p.countries_tags) ? p.countries_tags.slice(0,30) : [], ingredients_text: boundedText(p.ingredients_text ?? p.ingredients_text_en,warnings,'ingredients_text'), ingredients_analysis_tags: Array.isArray(p.ingredients_analysis_tags) ? p.ingredients_analysis_tags.slice(0,30) : [], allergens_tags: Array.isArray(p.allergens_tags) ? p.allergens_tags.slice(0,30) : null, traces_tags: Array.isArray(p.traces_tags) ? p.traces_tags.slice(0,30) : null, nutriscore_grade: str(p.nutriscore_grade), nova_group: positiveNumber(p.nova_group), environmental_score_grade: str(p.environmental_score_grade), nutrition: { aggregated_set: { preparation: str(agg.preparation), per: str(agg.per), nutrients: selected }, input_sets: inputs }, legacy_nutriments: object(p.nutriments), selected_images: object(p.selected_images), image_url: str(p.image_url), last_modified_t: positiveNumber(p.last_modified_t), schema_version: positiveNumber(p.schema_version), tags_sources: p.tags_sources ?? null };
}
function selectSearchProduct(raw: unknown): JsonObject {
  const p=object(raw); return { code: str(p.code), product_name: str(p.product_name), brands: brandsText(p.brands), categories_tags: Array.isArray(p.categories_tags) ? p.categories_tags.slice(0,20) : [], countries_tags: Array.isArray(p.countries_tags) ? p.countries_tags.slice(0,20) : [], nutriscore_grade: str(p.nutriscore_grade), nova_group: positiveNumber(p.nova_group), ecoscore_grade: str(p.ecoscore_grade), legacy_nutriments: object(p.nutriments), last_modified_t: positiveNumber(p.last_modified_t) };
}
type CacheEntry = { until: number; envelope: Envelope };
export function createService(config: Config) {
  if (!/^[^\r\n]{10,200}$/u.test(config.userAgent) || !/\S+\/\S+.*\([^()]+@[^()]+\)/u.test(config.userAgent)) throw new ServiceError('CONFIG', 'OFF_USER_AGENT must identify app/version and contact email');
  const doFetch = config.fetch ?? fetch, now = config.now ?? Date.now;
  const cache = new Map<string,CacheEntry>(), inflight = new Map<string,Promise<Envelope>>();
  const calls: Record<Kind, number[]> = { product: [], search: [], taxonomy: [] };
  const cooldown: Partial<Record<Kind,number>> = {};
  async function request(kind: Kind, url: string, parse: (v: unknown,w: string[])=>{data: unknown; missing_fields: string[]}): Promise<Envelope> {
    const t=now(), cached=cache.get(url);
    if (cached && cached.until > t) return { ...cached.envelope, cache_hit: true };
    const current=inflight.get(url); if (current) return (await current);
    const promise=(async()=>{
      if ((cooldown[kind] ?? 0) > now()) throw new ServiceError('RATE_LIMITED', 'Open Food Facts cooldown active', Math.ceil(((cooldown[kind] ?? 0)-now())/1000));
      calls[kind]=calls[kind].filter(x=>x>now()-60_000);
      if (calls[kind].length >= LIMIT[kind]) throw new ServiceError('LOCAL_RATE_LIMIT', `${kind} request budget exhausted`);
      calls[kind].push(now());
      let response: Response;
      try { response=await doFetch(url,{method:'GET',redirect:'error',headers:{'User-Agent':config.userAgent,'Accept':'application/json'},signal:AbortSignal.timeout(config.timeoutMs ?? 8000)}); }
      catch(e) { if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') throw new ServiceError('TIMEOUT','Open Food Facts request timed out'); throw new ServiceError('NETWORK',`Open Food Facts network error: ${(e as Error).message}`); }
      if (response.status===404) throw new ServiceError('NOT_FOUND','Resource not found');
      if (response.status===429) { const raw=response.headers.get('Retry-After'); const parsed=raw && /^\d+$/u.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw)-now())/1000) : NaN; const seconds=Number.isFinite(parsed)&&parsed>0 ? parsed : 60; cooldown[kind]=now()+seconds*1000; throw new ServiceError('RATE_LIMITED','Open Food Facts rate limit',seconds); }
      if (response.status>=500) throw new ServiceError('UPSTREAM','Open Food Facts server error');
      if (response.status>=300 && response.status<400) throw new ServiceError('REDIRECT','Open Food Facts redirected the request');
      if (!response.ok) throw new ServiceError('HTTP',`Open Food Facts HTTP ${response.status}`);
      const max=config.maxBodyBytes ?? 1_000_000;
      if (Number(response.headers.get('Content-Length'))>max) throw new ServiceError('BODY_TOO_LARGE','Open Food Facts response too large');
      const reader=response.body?.getReader(); let body='';
      if (reader) { const decoder=new TextDecoder(); let bytes=0; try { for (;;) { const chunk=await reader.read(); if (chunk.done) break; bytes+=chunk.value.byteLength; if (bytes>max) { await reader.cancel(); throw new ServiceError('BODY_TOO_LARGE','Open Food Facts response too large'); } body+=decoder.decode(chunk.value,{stream:true}); } body+=decoder.decode(); } catch(e) { if(e instanceof ServiceError) throw e; if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') throw new ServiceError('TIMEOUT','Open Food Facts response timed out'); throw new ServiceError('NETWORK','Open Food Facts response stream failed'); } }
      else { body=await response.text(); if (Buffer.byteLength(body)>max) throw new ServiceError('BODY_TOO_LARGE','Open Food Facts response too large'); }
      let raw: unknown; try { raw=JSON.parse(body); } catch { throw new ServiceError('INVALID_JSON','Open Food Facts returned invalid JSON'); }
      const warnings: string[]=[]; const parsed=parse(raw,warnings);
      const envelope: Envelope={ source: source(kind,url), retrieved_at: new Date(now()).toISOString(), cache_hit:false, data:parsed.data, missing_fields:parsed.missing_fields, warnings };
      cache.set(url,{until:now()+TTL[kind],envelope});
      while(cache.size>(config.cacheMax ?? 200)) cache.delete(cache.keys().next().value!);
      return envelope;
    })();
    inflight.set(url,promise);
    try { return await promise; } finally { inflight.delete(url); }
  }
  async function getProduct(args: {barcode:string;language?:string}): Promise<Envelope> {
    const code=barcode(args.barcode), lc=language(args.language);
    const url=qUrl(`/api/v3.6/product/${code}`,{lc,fields:PRODUCT_FIELDS.join(',')},'product');
    return request('product',url,(raw,warnings)=>{
      const r=object(raw); if (r.status==='failure' || r.status===0) throw new ServiceError('NOT_FOUND',`Product ${code} not found`);
      if (!str(object(r.product).code)) throw new ServiceError('UPSTREAM_SCHEMA','Product response omitted product code');
      const data=selectProduct(r.product,warnings); const missing=['product_name','brands','ingredients_text','allergens_tags','traces_tags','nutrition'].filter(k=> k==='nutrition' ? !object(object(r.product).nutrition).aggregated_set : data[k]===null);
      if (!object(object(r.product).nutrition).aggregated_set) warnings.push('No v3 aggregated nutrition set; legacy nutriments kept separately');
      return {data,missing_fields:missing};
    });
  }
  async function searchProducts(args: {country?:string;category?:string;brand?:string;nutriscore?:string;page?:number;page_size?:number;language?:string}): Promise<Envelope> {
    const p=page(args.page,'page',1,1000), size=page(args.page_size,'page_size',10,20), lc=language(args.language);
    const params: Record<string,string|undefined>={page:String(p),page_size:String(size),fields:SEARCH_FIELDS.join(','),lc,countries_tags:tags(args.country,'country'),categories_tags:tags(args.category,'category'),brands_tags:tags(args.brand,'brand')};
    if(args.nutriscore!==undefined){const v=requiredString(args.nutriscore,'nutriscore',1).toLowerCase();if(!/^[abcde]$/u.test(v)) throw new ServiceError('INVALID_ARGUMENT','nutriscore must be A–E');params.nutrition_grades_tags=v;}
    const url=qUrl('/api/v2/search',params,'product');
    return request('search',url,(raw,warnings)=>{
      const r=object(raw), items=Array.isArray(r.products)?r.products:[];
      if (!Array.isArray(r.products)) throw new ServiceError('UPSTREAM_SCHEMA','Open Food Facts search response omitted products array');
      const count=positiveNumber(r.count); const data={products:items.slice(0,size).map(selectSearchProduct),page:p,page_size:size,page_count:Math.min(items.length,size),count,total_pages:count===null?null:Math.ceil(count/size)};
      return {data,missing_fields:count===null?['count']:[]};
    });
  }
  async function searchText(args: {query:string;page?:number;page_size?:number;language?:string}): Promise<Envelope> {
    const query=requiredString(args.query,'query',120), p=page(args.page,'page',1,1000), size=page(args.page_size,'page_size',10,20), lc=language(args.language);
    const url=qUrl('/search',{q:query,page:String(p),page_size:String(size),langs:lc,fields:SEARCH_FIELDS.join(',')},'search');
    return request('search',url,(raw,warnings)=>{
      const r=object(raw), hits=Array.isArray(r.hits)?r.hits:[];
      if (!Array.isArray(r.hits)) throw new ServiceError('UPSTREAM_SCHEMA','Search-a-licious response omitted hits array');
      const count=positiveNumber(r.count), exact=typeof r.is_count_exact==='boolean'?r.is_count_exact:null;
      return {data:{products:hits.slice(0,size).map(selectSearchProduct),page:p,page_size:size,page_count:Math.min(hits.length,size),count,is_count_exact:exact,total_pages:count===null?null:Math.ceil(count/size)},missing_fields:[...(count===null?['count']:[]),...(exact===null?['is_count_exact']:[])]};
    });
  }
  async function getTaxonomy(args: {query:string;taxonomy:string;language?:string;limit?:number}): Promise<Envelope> {
    const query=requiredString(args.query,'query',100), taxonomy=requiredString(args.taxonomy,'taxonomy',30).toLowerCase();
    if (!['categories','brands','countries','ingredients','additives','allergens','labels'].includes(taxonomy)) throw new ServiceError('INVALID_ARGUMENT','unsupported taxonomy');
    const taxonomyAliases: Record<string, string> = { categories: 'categories,category', brands: 'brands,brand', countries: 'countries,country', ingredients: 'ingredients,ingredient', additives: 'additives,additive', allergens: 'allergens,allergen', labels: 'labels,label' };
    const lc=language(args.language), size=page(args.limit,'limit',10,20);
    const url=qUrl('/autocomplete',{q:query,taxonomy_names:taxonomyAliases[taxonomy],lang:lc,size:String(size)},'taxonomy');
    return request('taxonomy',url,(raw)=>{
      const r=object(raw); const values = Object.hasOwn(r, 'options') ? (Array.isArray(r.options) ? r.options : null) : Array.isArray(raw) ? raw : Array.isArray(r.results) ? r.results : Array.isArray(r.hits) ? r.hits : null;
      if (!values) throw new ServiceError('UPSTREAM_SCHEMA','Autocomplete response omitted suggestions array');
      return {data:{taxonomy,query,suggestions:values.slice(0,size)},missing_fields:[]};
    });
  }
  async function compareProducts(args: {barcodes:string[];language?:string}): Promise<Envelope> {
    if (!Array.isArray(args.barcodes)||args.barcodes.length<2||args.barcodes.length>5) throw new ServiceError('INVALID_ARGUMENT','barcodes must contain 2–5 codes');
    const codes=args.barcodes.map(barcode); if(new Set(codes).size!==codes.length) throw new ServiceError('INVALID_ARGUMENT','barcodes must be distinct');
    const lc=language(args.language), results=await Promise.all(codes.map(code=>getProduct({barcode:code,language:lc})));
    const profiles=results.map(r=>object(object(r.data).nutrition).aggregated_set).map(object);
    const bases=profiles.map(p=>`${p.per ?? '?'}:${p.preparation ?? '?'}`);
    const compatible=bases.every(b=>b===bases[0] && (/^(100g|100ml):as_sold$/u.test(b)));
    const warnings=compatible?[]:['Nutrition comparison unavailable: missing or incompatible per/preparation basis'];
    const data={products:results,comparison:compatible?{basis:bases[0],nutrients:Object.fromEntries(NUTRIENTS.map(k=>[k,profiles.map(p=>object(p.nutrients)[k]??null)]))}:null};
    return {source:{service:'Open Food Facts',api_version:'v3.6',url:results.map(r=>r.source.url).join(' , ')},retrieved_at:new Date(now()).toISOString(),cache_hit:results.every(r=>r.cache_hit),data,missing_fields:compatible?[]:['comparison'],warnings};
  }
  return {getProduct,searchProducts,searchText,getTaxonomy,compareProducts};
}
