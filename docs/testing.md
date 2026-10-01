# Testing and validation

The project uses Node.js 22.23 or newer, the Node.js test runner, TypeScript, and the official MCP SDK.

## Run the checks

After installing dependencies as described in the [README](../README.md), run:

```sh
npm run typecheck
npm test
```

Tests use synthetic Open Food Facts responses. They require no API key and do not contact the public API.

## Coverage

The service tests cover product nutrition and units, missing values, cache expiration and concurrent request deduplication, local request limits, HTTP errors and Retry-After, timeouts, response size limits, search pagination, taxonomy suggestions, and incompatible nutrition comparison bases.

The protocol tests use the official SDK in two ways:

- In-memory transports initialize a client and server, list the five tools, and call each tool with a simulated upstream service.
- The stdio test starts the real entry point as a child process, initializes an SDK client, lists the tools, and checks that an invalid barcode is rejected before any network request.

The stdio test needs permission to start child processes. A restricted execution environment can prevent this independently of the MCP implementation.

## Initial validation

On October 1, 2026, TypeScript checking passed and all 12 tests passed using Node.js 22.23.2. The stdio test ran in an authorized environment that permitted child processes.

These results establish local behavior against the tested fixtures and MCP client. They do not establish current availability or correctness of the live Open Food Facts services. A live API smoke test and hosted CI execution have not yet been completed.

See [architecture.md](architecture.md) for endpoint contracts, nutrition comparison rules, and limits. The English documentation is in [README.md](../README.md); the French documentation is in [README.fr.md](../README.fr.md).
