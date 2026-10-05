# Apify Actor validation — 2026-10-05

## Scope

Adds an Apify Standby HTTP adapter to the existing open-source MCP server. The five tool implementations, locked dependencies, STDIO entry point, and existing tests are unchanged. Actor files are additive; the root READMEs have an appended link to the Actor documentation.

## Executed checks

Environment: Node.js 22.23.2, TypeScript 5.9.3, MCP SDK 2.0.0. Candidate: `apify-candidate-v3-20261005`.

- `node node_modules/typescript/bin/tsc --project apify/tsconfig.json --noEmit`: passed.
- `node --experimental-strip-types --test tests/*.test.ts`: **29 passed, 0 failed**, including the 16 existing tests and 13 Actor tests.
- All five tools called by an SDK client over a real loopback HTTP socket; structured responses preserved; invalid barcode rejected without upstream access.
- Multiple MCP clients shared the same in-flight deduplication, cache and product quota; reconnection reused the cache.
- Host and Origin rejection, malformed JSON, a chunked request exceeding 64 KiB, bearer rejection and acceptance, and removal of authorization/cookie headers verified.
- Legacy 2025 initialization and finite SSE supported; GET streaming and subscriptions/listen refused.
- Shutdown tested with a partial body, incomplete HTTP headers, before listen, and repeated close.
- `main.ts` batch self-check, local HTTP startup, and simulated Apify Standby startup completed; readiness and SIGTERM shutdown passed. Child-process fetch was replaced with a failing hook to detect accidental outbound access.
- SHA-256 comparison confirmed every base source, dependency, license, and existing test file matched the original baseline before integration.

These tests used fixtures or local sockets only: **zero live Open Food Facts requests**. Socket and child-process tests required execution outside the filesystem/network sandbox. A separate reviewer found no static code blocker and requested the socket/runtime tests, which were added and passed.

## Packaging

The Actor definition declares Standby and `/mcp`. The Dockerfile pins Node and Python image digests, verifies SHA-512 dependency archives, runs TypeScript and offline tests during the build, and runs as the unprivileged `node` user. The Docker context allowlist excludes local work artifacts and credentials. English and French Actor documentation are included.

## Deployment validation still required

No Apify Actor has been created by this change at the time of this report. No Docker image build or Apify cloud run was executed. The live gateway Host/Origin routing, actual Standby URL, gateway token authentication, image availability, and 256 MB memory allocation therefore remain unverified. Local simulated Standby tests do not establish cloud deployment success.

The user's MCP-only web-access policy requires an explicit exception for direct Apify API/CLI access because no suitable Actor-management MCP is available. A monitored contact email is also required for `OFF_USER_AGENT`. Once supplied, the intended next step is a private Actor, one build and a bounded Standby smoke test, with no Store publication or commercial pricing configuration.

Official references: [Actor Standby](https://docs.apify.com/actors/development/programming-interface/standby), [Standby access](https://docs.apify.com/actors/running/standby), [Actor definition](https://docs.apify.com/actors/development/actor-definition/actor-json), [MCP SDK HTTP](https://ts.sdk.modelcontextprotocol.io/v2/serving/http).
