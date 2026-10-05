# Open Food Facts MCP on Apify

Use five read-only MCP tools to look up packaged foods, search products, retrieve taxonomy suggestions, and compare nutrition data. This Actor adapts the [open-source Open Food Facts MCP server](https://github.com/MrBridgeHQ/open-food-facts-mcp) to Apify Standby with a Streamable HTTP endpoint at `/mcp`.

This is an independent project, not an official Open Food Facts service. [Documentation française](README.fr.md).

## Connect

Each user must supply their **own monitored contact email**. In Apify Console:

1. Create a **private task** from this Actor in your account.
2. Fill in the required **Your contact email** (`contactEmail`) field and save the task. There is no default address.
3. Enable Standby for that task and enable input forwarding (`actorStandby.shouldPassActorInput: true`). The Actor owner must allow task-level configuration overrides.
4. Copy the task's **actual Standby URL** from its Endpoints tab. Use the task URL so the run receives your saved input.
5. Configure a compatible remote MCP client with:

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP |
| URL | Your private task's Standby URL followed by `/mcp` |
| Header | `Authorization: Bearer <your Apify API token>` |

Keep your token in your client's secret configuration. Apify's gateway authenticates the request. Incoming authorization and cookie headers are not forwarded to Open Food Facts. Clients should negotiate the protocol through MCP initialization; finite SSE responses are supported for legacy 2025-era clients. Persistent subscriptions and the older separate `/sse` transport are not exposed.

A regular **Start** run reads and validates your input, performs initialization and tool discovery without querying Open Food Facts, then exits. To use the server interactively, connect through **Standby**. Starting a batch run does not produce a dataset or a permanent MCP URL. Standby starts containers on demand; startup time and availability depend on the platform.

## Available tools

| Tool | What it does | Example arguments |
| --- | --- | --- |
| `get_product` | Read one product by barcode | `{"barcode":"3017620422003","language":"en"}` |
| `search_products` | Search with taxonomy filters | `{"country":"en:france","category":"en:chocolates","page_size":5}` |
| `search_text` | Search product text through Search-a-licious | `{"query":"dark chocolate","page_size":5}` |
| `get_taxonomy` | Find category, brand, country, ingredient, additive, allergen, or label tags | `{"query":"chocolate","taxonomy":"categories","limit":5}` |
| `compare_products` | Compare 2–5 distinct barcodes on a matching nutrition basis | `{"barcodes":["3017620422003","3017620425035"]}` |

These are MCP tool arguments, not Actor input fields or REST query parameters. Products in the examples may change or be unavailable. Successful responses contain `source`, `retrieved_at`, `cache_hit`, `data`, `missing_fields`, and `warnings`. Tool failures return `isError: true` with a structured error code and, when available, a retry delay. See the [full data contract](https://github.com/MrBridgeHQ/open-food-facts-mcp/blob/main/docs/architecture.md).

## Deploy your own Actor

Use the repository as the Actor's Git source. The `.actor/actor.json` definition selects the Dockerfile, MCP path, schemas, and this README. Leave the default Actor input without any prefilled email. Every user supplies `contactEmail` through their own private task; the form requires it and runtime validation checks it again.

For a user's task, enable input forwarding in its Standby configuration:

```json
{
  "actorStandby": {
    "isEnabled": true,
    "shouldPassActorInput": true
  }
}
```

This fragment configures a task through the platform; it is not tool-call input or an additional `actor.json` property. The owner must leave task overrides enabled. See [creating tasks](https://docs.apify.com/api/v2/actor-tasks-post) and [Standby task configuration](https://docs.apify.com/actors/running/standby).

On Apify, the server reads the current run's input record from its default key-value store using the platform-provided token. It constructs `open-food-facts-mcp/0.1.0 (<contactEmail>)` in memory. A missing or invalid address prevents startup; there is no fallback to a shared `OFF_USER_AGENT` or developer address. Public Open Food Facts reads do not need an Open Food Facts API key.

The Actor receives its HTTP port and public URLs from Apify's `ACTOR_WEB_SERVER_PORT`, `ACTOR_STANDBY_URL`, and `ACTOR_WEB_SERVER_URL` environment variables. It binds to `0.0.0.0` on Apify and uses the supplied URLs to validate Host and Origin headers.

Enable Standby using the successful build. The definition requests 256 MB as a starting memory allocation; deployment validation should confirm the allocation is adequate. No per-event charging is implemented by this project. Apify infrastructure usage and your account's platform charges still apply. Creating an Actor does not publish it to the public Apify Store.

## Local development

Requires Node.js 22.23 or newer and Python 3. In a **fresh checkout with no `node_modules` directory**, the repository's dependency bootstrap verifies the lockfile's SHA-512 hashes and creates the locked packages without install scripts:

```sh
python3 -B scripts/bootstrap-locked.py
node node_modules/typescript/bin/tsc --project apify/tsconfig.json --noEmit
node --experimental-strip-types --test tests/*.test.ts
```

With dependencies already installed, skip the bootstrap. Start the HTTP server:

```sh
export OFF_CONTACT_EMAIL='your-monitored-contact@example.org'
node --experimental-strip-types apify/main.ts
```

Replace the example with your own address. This HTTP entry point requires `OFF_CONTACT_EMAIL`; the original STDIO entry point keeps its existing `OFF_USER_AGENT` configuration.

The local endpoint is `http://127.0.0.1:4321/mcp`. `GET /` is a readiness check that makes no Open Food Facts request. Optionally set `OFF_LOCAL_BEARER_TOKEN` to require a bearer token locally. This is separate from Apify gateway authentication; normally leave it unset on Apify.

The Dockerfile pins the Node and Python base image digests, verifies locked dependency archives, runs TypeScript checking and offline tests, and starts the final container as an unprivileged user. The MCP client package is required at runtime by the in-memory bridge, so the image retains the locked client dependency.

## Limits and data quality

All HTTP clients in one container share the same backend, cache, in-flight deduplication, and rolling-minute counters: 15 product requests, 10 search requests, and 10 taxonomy requests. Cache durations are five minutes for products, one minute for searches, and ten minutes for taxonomy suggestions. Separate containers and other users of the same outgoing IP do not share these counters; upstream limits can therefore still apply. Use Open Food Facts data exports for bulk work.

The HTTP wrapper accepts request bodies up to 64 KiB and at most 16 concurrent MCP requests, with a 30-second request deadline. Shutdown allows active requests up to 10 seconds before closing connections. New requests receive a retryable error during shutdown or saturation. Rate limits are also reported as MCP tool errors; inspect `isError`, even when HTTP returns 200.

Community product data can be incomplete or inaccurate. Missing nutrition is not zero, and missing allergen data does not guarantee absence. Comparisons require matching supported nutrition bases and preparation states. These tools provide information, not dietary safety or medical assessments.

## Source, licenses, and support

The code is [MIT licensed](https://github.com/MrBridgeHQ/open-food-facts-mcp/blob/main/LICENSE). Open Food Facts data and images have separate reuse terms: ODbL for the database, DbCL for individual contents, and CC BY-SA for images. Read the [Open Food Facts reuse terms](https://world.openfoodfacts.org/terms-of-use) before redistribution.

Report bugs in [GitHub Issues](https://github.com/MrBridgeHQ/open-food-facts-mcp/issues). Platform behavior is documented in [Apify Standby](https://docs.apify.com/actors/development/programming-interface/standby), [Standby access and authentication](https://docs.apify.com/actors/running/standby), and the [Actor definition reference](https://docs.apify.com/actors/development/actor-definition/actor-json).

### Client origin compatibility

Native/server-side clients normally omit `Origin`. If a client sends it, it must exactly match one of the configured server URL origins. Cross-origin browser clients are not enabled by this wrapper; it does not send wildcard CORS headers. Actual gateway routing remains a deployment validation step.

## Contact email handling

The email is stored in your Apify task/run input and sent to Open Food Facts in request headers as the contact for your usage. The application does not log the email or include it in MCP results. Email syntax is checked; mailbox ownership and deliverability are not verified. Use a private task, keep access to it and your API token private, and save a new contact before starting a new run if the address changes.

Apify documents that Standby runs are isolated per user account. This server uses one contact per run; it does not authenticate different people who share the same Apify account, task or token. Do not share a task/token across independently accountable users.
