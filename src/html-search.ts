// A bounded parser for the OFF web search page. Nothing in this module executes HTML or JS.
export type HtmlSearchResult = {
  products: Record<string, unknown>[];
  count_reported: number | null;
  reported_total_pages: number | null;
};
export class HtmlSearchError extends Error {
  readonly code = 'HTML_SCHEMA';
  constructor(message: string) { super(message); }
}
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#(?:x[0-9a-fA-F]{1,6}|[0-9]{1,7}));/gu, entity => {
    const named: Record<string, string> = {'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};
    if (named[entity]) return named[entity];
    const hex = entity.startsWith('&#x');
    const cp = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : entity;
  });
}

function scriptProducts(html: string): unknown[] {
  let found: unknown[] | null = null;
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
    const script = match[1];
    if (!/\bvar\s+page_type\s*=\s*["']products["']\s*;/u.test(script)) continue;
    const declaration = /\bvar\s+products\s*=\s*/gu;
    const starts = [...script.matchAll(declaration)];
    if (found || starts.length !== 1) throw new HtmlSearchError('Ambiguous products script');
    const start = starts[0].index! + starts[0][0].length;
    if (script[start] !== '[') throw new HtmlSearchError('Products must be a JSON array');
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = start; i < script.length; i++) {
      const c = script[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth < 0) throw new HtmlSearchError('Unbalanced products JSON'); if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0 || !/^\s*;/u.test(script.slice(end))) throw new HtmlSearchError('Incomplete products JSON');
    let parsed: unknown;
    try { parsed = JSON.parse(script.slice(start, end)); } catch { throw new HtmlSearchError('Invalid products JSON'); }
    if (!Array.isArray(parsed)) throw new HtmlSearchError('Products must be an array');
    found = parsed;
  }
  return found ?? ((): never => { throw new HtmlSearchError('Products script missing'); })();
}

function safeProductUrl(value: unknown, code: string): string | null {
  const raw = text(value); if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^world(?:-[a-z]{2,3})?\.openfoodfacts\.org$/u.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:product|produit|producto|produkt|prodotto|produto)\/([0-9]{4,32})(?:\/|$)/u);
    return m?.[1] === code ? u.toString() : null;
  } catch { return null; }
}
function safeImageUrl(value: unknown): string | null {
  const raw = text(value); if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === 'images.openfoodfacts.org' && !u.username && !u.password && !u.port && u.pathname.startsWith('/images/products/') ? u.toString() : null; }
  catch { return null; }
}
function scores(raw: Record<string, unknown>): {nutriscore_grade:string|null;nova_group:number|null;ecoscore_grade:string|null} {
  const result: {nutriscore_grade:string|null;nova_group:number|null;ecoscore_grade:string|null} = {nutriscore_grade:null,nova_group:null,ecoscore_grade:null};
  if (!Array.isArray(raw.attribute_groups)) return result;
  for (const group of raw.attribute_groups) {
    const attributes = obj(group)?.attributes;
    if (!Array.isArray(attributes)) continue;
    for (const entry of attributes) {
      const a = obj(entry); if (!a || a.status !== 'known') continue;
      const icon = text(a.icon_url); if (!icon) continue;
      if (a.id === 'nutriscore') { const m = icon.match(/^https:\/\/static\.openfoodfacts\.org\/images\/attributes\/dist\/nutriscore-([a-e])(?:-[a-z0-9-]+)?\.svg$/u); if (m) result.nutriscore_grade = m[1]; }
      if (a.id === 'nova') { const m = icon.match(/^https:\/\/static\.openfoodfacts\.org\/images\/attributes\/dist\/nova-group-([1-4])\.svg$/u); if (m) result.nova_group = Number(m[1]); }
      if (a.id === 'ecoscore') { const m = icon.match(/^https:\/\/static\.openfoodfacts\.org\/images\/attributes\/dist\/green-score-([a-e])(?:-[a-z0-9-]+)?\.svg$/u); if (m) result.ecoscore_grade = m[1]; }
    }
  }
  return result;
}

function validateEcho(html: string, requestedUrl: string, requestedPage: number, requestedSize: number): void {
  const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/iu)?.[1];
  if (!canonical) throw new HtmlSearchError('Canonical search URL missing');
  let actual: URL;
  try { actual = new URL(decodeEntities(canonical)); } catch { throw new HtmlSearchError('Canonical search URL invalid'); }
  const wanted = new URL(requestedUrl);
  if (actual.protocol !== 'https:' || !/^world(?:-[a-z]{2,3})?\.openfoodfacts\.org$/u.test(actual.hostname) || actual.pathname !== '/cgi/search.pl' || actual.username || actual.password || actual.port) throw new HtmlSearchError('Canonical search URL invalid');
  if (actual.searchParams.get('action') !== 'process' || actual.searchParams.get('page_size') !== String(requestedSize)) throw new HtmlSearchError('Search criteria mismatch');
  if (actual.searchParams.has('page') && actual.searchParams.get('page') !== String(requestedPage)) throw new HtmlSearchError('Search page mismatch');
  const requestedLanguage = wanted.searchParams.get('lc');
  if (actual.searchParams.has('lc')) {
    if (actual.searchParams.get('lc') !== requestedLanguage) throw new HtmlSearchError('Search language mismatch');
  } else if (requestedLanguage) {
    const localeHost = `world-${requestedLanguage.split('-')[0]}.openfoodfacts.org`;
    if (actual.hostname !== localeHost && !(requestedLanguage === 'en' && actual.hostname === 'world.openfoodfacts.org')) throw new HtmlSearchError('Search language not evidenced by canonical URL');
  }
  for (const [key, value] of wanted.searchParams) {
    if (/^(?:tagtype|tag_contains|tag)_\d+$/u.test(key) && actual.searchParams.get(key) !== value) throw new HtmlSearchError('Search filters mismatch');
  }
  for (const [key] of actual.searchParams) {
    if (/^(?:tagtype|tag_contains|tag)_\d+$/u.test(key) && !wanted.searchParams.has(key)) throw new HtmlSearchError('Unexpected search filter');
  }
  const pages = html.match(/<ul\s+id=["']pages["'][^>]*>([\s\S]*?)<\/ul>/iu)?.[1];
  if (pages) {
    const current = pages.match(/<li\s+class=["']current["'][^>]*>\s*<a[^>]*>(\d+)<\/a>/iu)?.[1];
    if (current !== String(requestedPage)) throw new HtmlSearchError('Pagination current page mismatch');
    const size = pages.match(/\((\d+)\s+products?\s+per\s+page\)/iu)?.[1];
    if (size && size !== String(requestedSize)) throw new HtmlSearchError('Pagination size mismatch');
  } else if (requestedPage !== 1) throw new HtmlSearchError('Pagination missing for requested page');
}

export function parseHtmlSearch(html: string, requestedUrl: string, page: number, pageSize: number): HtmlSearchResult {
  validateEcho(html, requestedUrl, page, pageSize);
  const raw = scriptProducts(html);
  if (raw.length > pageSize) throw new HtmlSearchError('Page contains more products than requested');
  const codes = new Set<string>();
  const products = raw.map(item => {
    const p = obj(item); if (!p || typeof p.code !== 'string' || !/^[0-9]{4,32}$/u.test(p.code) || codes.has(p.code)) throw new HtmlSearchError('Invalid or duplicate product code');
    const code = p.code; codes.add(code);
    const display = text(p.product_display_name);
    const name = display ? decodeEntities(display).slice(0, 300) : null;
    return {code,product_name:null,product_display_name:name,brands:null,categories_tags:null,countries_tags:null,...scores(p),legacy_nutriments:null,last_modified_t:null,url:safeProductUrl(p.url,code),image_front_small_url:safeImageUrl(p.image_front_small_url)};
  });
  const countBlock = html.match(/<span\s+class=["']filterProducts__results["'][^>]*>([\s\S]{0,300}?)<\/span>\s*<\/div>/iu)?.[1];
  const countText = countBlock?.replace(/<[^>]*>/gu,' ').replace(/[\u00a0\u202f]/gu,' ').trim();
  const numberText = countText?.match(/(?:^|\s)([0-9][0-9., ]*)(?=\s|$)/u)?.[1]?.trim();
  const validNumber = numberText !== undefined && (/^[0-9]+$/u.test(numberText) || /^[1-9][0-9]{0,2}([,. ])[0-9]{3}(?:\1[0-9]{3})*$/u.test(numberText));
  const count = validNumber ? Number(numberText.replace(/[,. ]/gu,'')) : null;
  if (countBlock && (count === null || !Number.isSafeInteger(count))) throw new HtmlSearchError('Invalid displayed count');
  const explicitEmpty = /<(?:h4|p)\b[^>]*>\s*(?:No products\.|Pas de produits\.)\s*<\/(?:h4|p)>/iu.test(html);
  if (products.length === 0 && !explicitEmpty) throw new HtmlSearchError('No explicit empty-results signal');
  if (products.length > 0 && (count === null || !Number.isSafeInteger(count) || count < products.length || explicitEmpty)) throw new HtmlSearchError('Result count missing or contradictory');
  if (products.length === 0 && count !== null && count !== 0) throw new HtmlSearchError('Empty result contradicts count');
  // Pagination links may show only a window, and the web count may be estimated.
  return {products,count_reported:count,reported_total_pages:null};
}
