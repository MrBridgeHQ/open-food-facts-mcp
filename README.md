# Open Food Facts MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for querying Open Food Facts from MCP clients. This is an independent third-party project and is not affiliated with or endorsed by Open Food Facts.

The server requires Node.js 22.23 or newer, uses TypeScript and `@modelcontextprotocol/server` 2.0.0 with Zod 4, and communicates over MCP STDIO. It reads public product, search, and taxonomy data. It does not edit product records, upload images, or provide health claims.

## Tools

| Tool | Arguments |
| --- | --- |
| `get_product` | `barcode` (4–32 digits), optional `language` |
| `search_products` | Optional `country`, `category`, `brand` taxonomy tags, `nutriscore` (`a`–`e`), `page` (1–1000), `page_size` (1–20), and `language` |
| `search_text` | `query` (1–120 characters), optional `page` (1–1000), `page_size` (1–20), and `language` |
| `get_taxonomy` | `query` (1–100 characters), `taxonomy` (`categories`, `brands`, `countries`, `ingredients`, `additives`, `allergens`, or `labels`), optional `language` and `limit` (1–20) |
| `compare_products` | `barcodes` (2–5 distinct codes, each 4–32 digits), optional `language` |

See [examples/tool-calls.json](examples/tool-calls.json) for argument examples and [docs/architecture.md](docs/architecture.md) for the response contract, endpoints, nutrition handling, and request limits.

## Run locally

This repository is not published as an npm package. Clone it, install dependencies, and run these checks from the checkout:

```sh
npm install
npm run typecheck
npm test
```

Before starting the server, set `OFF_USER_AGENT` to an application name and version followed by a monitored contact email:

```sh
export OFF_USER_AGENT='open-food-facts-mcp/0.1.0 (you@example.org)'
npm start
```

Replace the example address with your contact. Open Food Facts requires a descriptive `User-Agent` that identifies the application and provides contact information. These read operations do not use an API key.

### MCP client configuration

The server uses STDIO. Add an entry like this to your MCP client's configuration, replacing the checkout path and contact address:

```json
{
  "mcpServers": {
    "open-food-facts": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "/absolute/path/to/open-food-facts-mcp/src/index.ts"
      ],
      "env": {
        "OFF_USER_AGENT": "open-food-facts-mcp/0.1.0 (you@example.org)"
      }
    }
  }
}
```

Do not write logs to stdout in an MCP STDIO process; stdout carries protocol messages.

## Data and responsible use

Open Food Facts is a community-built database. Its API documentation notes that product data can be incomplete or inaccurate. A missing field is not zero. An absent allergen entry does not establish that a product is allergen-free. Nutrition values can refer to 100 g, 100 ml, a portion, or a preparation state, so compare values only when their basis and preparation match.

Each successful response includes source URLs, retrieval time, cache status, missing fields, and warnings. Nutrition output keeps the v3 aggregated set and its basis alongside available input sets and provenance; legacy `nutriments` values remain separate. See the architecture notes for comparison behavior and limits.

Open Food Facts currently documents limits of 15 product reads and 10 search requests per minute per IP address. This server also applies in-process request limits and short-lived caches. Separate server processes sharing an IP do not coordinate their counters or caches. Avoid rapid repeated searches. For bulk, analytical, or offline access, follow Open Food Facts' guidance to use its data exports or a suitable local cache instead of repeatedly querying the API.

This software is licensed under MIT; see [LICENSE](LICENSE). Open Food Facts data reuse has separate terms: the database is under ODbL, individual database contents under DbCL, and product images under CC BY-SA. These software and data licenses are independent. Read Open Food Facts' [reuse terms](https://world.openfoodfacts.org/terms-of-use) before redistributing data or images.

## Related projects

Other community projects in this area include [domdomegg/openfoodfacts-mcp](https://github.com/domdomegg/openfoodfacts-mcp), [cyanheads/openfoodfacts-mcp-server](https://github.com/cyanheads/openfoodfacts-mcp-server), and [noot-app/openfoodfacts-mcp-server](https://github.com/noot-app/openfoodfacts-mcp-server). This project's design focus is a compact read-only tool set with explicit v3.6 nutrition bases and provenance.

## References

- [Open Food Facts API documentation](https://openfoodfacts.github.io/openfoodfacts-server/api/)
- [API and product schema change log](https://openfoodfacts.github.io/openfoodfacts-server/api/ref-api-and-product-schema-change-log/)
- [Open Food Facts data and reuse conditions](https://world.openfoodfacts.org/data)

## Apify Actor

An additional Streamable HTTP entry point is available for Apify Standby. See the [Actor setup and English documentation](apify/README.md) for `/mcp`, authentication, deployment, local HTTP use, and operating limits. The original STDIO entry point remains available.
