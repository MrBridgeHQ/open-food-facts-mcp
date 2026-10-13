# Architecture and data contract

## Scope

This is a small, read-only MCP adapter that runs over STDIO and calls the public Open Food Facts product, search, and taxonomy services. It does not write product records, upload photos, expose bulk analytics, or provide health claims. It uses `@modelcontextprotocol/server` 2.0.0 with Zod 4. Node.js 22.23 or newer runs its TypeScript entry point with native type stripping.

## Tools and inputs

All optional fields may be omitted.

| Tool | Input | Upstream endpoint |
| --- | --- | --- |
| `get_product` | `barcode` (4–32 digits), `language?` | `/api/v3.6/product/{code}` |
| `search_text` | `query` (1–120 characters), `page?` (1–1000), `page_size?` (1–20), `language?` | Search-a-licious `/search` |
| `get_taxonomy` | `query` (1–100 characters), `taxonomy`, `language?`, `limit?` (1–20) | Search-a-licious `/autocomplete` |
| `compare_products` | `barcodes` (2–5 distinct codes, each 4–32 digits), `language?` | One Product API lookup per barcode |

The taxonomy values accepted by `get_taxonomy` are `categories`, `brands`, `countries`, `ingredients`, `additives`, `allergens`, and `labels`. Page numbering starts at 1. Tag filters accept a taxonomy tag or slug. Inputs are validated before a request is made.

## Response envelope

Successful tools return this common structure:

```json
{
  "source": {
    "service": "Open Food Facts",
    "api_version": "v3.6",
    "url": "https://world.openfoodfacts.org/api/v3.6/product/3017620422003"
  },
  "retrieved_at": "2026-10-01T12:00:00.000Z",
  "cache_hit": false,
  "data": {},
  "missing_fields": [],
  "warnings": []
}
```

`source` identifies the upstream service and API version and includes the request URL. A comparison contains each product's own source envelope because it performs multiple lookups. `retrieved_at` is the retrieval time, `cache_hit` indicates whether this process reused its in-memory result, `missing_fields` lists expected values not supplied by the response, and `warnings` explains notable omissions or transformations. Missing numeric values are not changed to zero. Errors use an MCP error result with a stable code, message, and optional retry delay.

## Retained internal HTML search (not exposed by MCP in 0.6.0)

The following implementation is retained for regression tests. No registered MCP tool calls it.

The internal `searchProducts` service method sends one GET to the OFF web CGI search page. Each nonempty country, category, brand, and Nutri-Score filter becomes a contiguous `tagtype_i`, `tag_contains_i=contains`, `tag_i` triplet, combined by the server. Inputs are taxonomy tags or slugs, not free-text operators. A request includes `page_size`, `page` and optional `lc`; anonymous pages are limited to 1–10. The page is read as HTML, capped at 1 MB and 8 seconds including the body, without redirects or retries. The embedded `products` JSON is parsed as data; no JavaScript runs. The parser verifies search criteria, page indicator, strict thousands-grouped count, requested language through `lc` or a localized `world-<lang>` host, barcode syntax and duplicate codes. Only an explicit OFF no-products marker permits an empty result.

The web projection exposes `code`, combined `product_display_name`, product and small image URLs, and score icons. Separate `product_name`, `brands`, `categories_tags`, `countries_tags`, `legacy_nutriments`, and `last_modified_t` remain `null` and are listed in `missing_fields`; additional absent display fields and scores are listed when an observed hit lacks them. No details are invented. Score values are inferred only from known attribute IDs and trusted icon URLs, never preference `grade`. `count_reported` reflects the web display and may be an estimate. `reported_total_pages`, `count`, `is_count_exact`, and `total_pages` are `null` because pagination links may show only a window. Use `get_product` for individual detail reads; search performs no automatic per-hit lookups. This contract is based on one captured successful page and official web source; other pages need live validation.

## Nutrition and provenance

For a product, `data.nutrition.aggregated_set` exposes the v3 aggregated nutrition set, including its `per` basis, `preparation`, and selected nutrients. Each normalized nutrient carries a value, normalized unit, entered unit, modifier, and available source metadata. The server also retains available `nutrition.input_sets` with their preparation, basis, source, update time, and selected nutrient inputs. Legacy `nutriments` values are kept in a separate `legacy_nutriments` field rather than merged into the v3 set.

The v3.6 schema includes `tags_sources` for taxonomy-tag source tracking. Open Food Facts describes v3.6 as a change to the tags schema; v3 and its product schema are actively developed. Clients should tolerate additional fields and consult the official change log when upgrading.

`compare_products` returns nutrient arrays only when every product has the same supported basis and preparation: currently `100g:as_sold` or `100ml:as_sold`. If a product lacks that basis or the products differ, it returns the product envelopes, sets `comparison` to `null`, lists `comparison` in `missing_fields`, and adds a warning. It does not convert between grams, millilitres, portions, or preparation states.

Nutrition and allergen information is informational. Product records can be incomplete or inaccurate; a missing allergen value does not guarantee absence, and the tools do not make medical or dietary safety determinations.

## Requests, cache, and rate limits

Set `OFF_USER_AGENT` to an identifying value in the form `application/version (contact@example.org)`. The server rejects a missing or malformed value. Read requests do not require an API key.

Current in-process limits are 15 product requests, 10 search requests, and 10 taxonomy requests per rolling minute. Successful results are cached per process for five minutes for product lookups, one minute for searches, and ten minutes for taxonomy suggestions. Concurrent identical requests within a process are coalesced. Counters and caches do not coordinate multiple processes or other clients sharing the same public IP.

Open Food Facts currently documents upstream limits of 15 product reads and 10 search requests per minute per IP. These public limits may change and are shared at the IP level, so local per-process limits cannot guarantee a shared IP stays below the upstream threshold. A 429 response is returned with a retry delay when the service provides one.

## Upstream endpoints and references

- Product reads: `https://world.openfoodfacts.org/api/v3.6/product/{code}`
- Retained internal search, not exposed by MCP: `https://world.openfoodfacts.org/cgi/search.pl?action=process`
- Text search: `https://search.openfoodfacts.org/search`
- Taxonomy autocomplete: `https://search.openfoodfacts.org/autocomplete`
- [Open Food Facts API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/)
- [API and product schema change log](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-api-and-product-schema-change-log/)
- [Open Food Facts data and reuse conditions](https://world.openfoodfacts.org/data)

## Bounded 5xx observation

A received 5xx keeps its exact HTTP status. The server reads at most 8,193 bytes to inspect an 8,192-byte prefix, with a separate 500 ms body deadline. It reports only fixed error phrases and a fixed MIME category (`html`, `json`, `text`, `other`, or `unknown`); it never returns arbitrary body or header text. The canonical phrase `Page temporarily unavailable - Open Food Facts` identifies a page signature, not the reason for the 503. Body truncation and read failure are reported separately. This adds no request, retry, fallback, proxy, or per-product lookup.
