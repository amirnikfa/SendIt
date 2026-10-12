# Postman research

Research date: 2026-10-11. Official documentation currently labels the default version **v12**. Research was completed before application implementation. ApiWorkbench is an independent local client with original branding; it does not embed Postman code or graphical assets.

## Interface observations

The [official navigation guide](https://learning.postman.com/docs/getting-started/basics/navigating-postman/) and its [annotated interface screenshot](https://assets.postman.com/postman-docs/v12/workspace-diagram-02-28-26-v2.png) were examined. The screenshot shows a compact header, hierarchical collection sidebar, horizontal request tabs, environment selection, request address bar, configuration tabs, and lower response pane. An optional right pane holds auxiliary tools. The footer exposes the console and layout controls. Rows use subtle borders, muted secondary text, colored method labels and a prominent Send action. Tab changes have a dot indicator; drag reorders tabs; closing edited tabs asks about saving. Keyboard shortcuts include Ctrl+T and Ctrl+K.

Design inference: keep dense editing surfaces, a restrained neutral palette, and persistent spatial relationships. ApiWorkbench will use original blue/cyan branding, light/dark tokens, a compact navigation rail, resizable explorer and response split, and native window controls. Research screenshot is reference-only and excluded from application and source release archives.

## Requests and responses

The [request guide](https://learning.postman.com/docs/use/send-requests/create-requests/request-basics) describes entering a method and URL, configuring request details, sending, then naming and saving into a collection. Custom methods are supported. The [body guide](https://learning.postman.com/docs/use/send-requests/create-requests/parameters) documents bidirectional URL/query editing, disabled rows, descriptions, bulk editing, raw language selection, forms, multipart files, binary data and GraphQL. Content type normally follows body mode, with explicit headers overriding defaults.

The [response guide](https://learning.postman.com/docs/use/send-requests/response-data/responses) exposes status, time, size, body, headers, cookies and test results, plus syntax views, search, previews and response saving. It also documents SSE. Local implementation will use bounded response buffers and an explicit size error rather than silently truncating a response.

The [desktop agent documentation](https://learning.postman.com/docs/getting-started/basics/about-postman-agent) explains why native requests avoid browser CORS restrictions. Requests here will originate in Electron's main process using Node networking.

## Collections, workspaces, import and execution

[Collections](https://learning.postman.com/docs/use/use-collections/create-collections) group requests, nested folders, variables, authorization and scripts. Our local workspace is the isolation boundary for collections, environments and history. The normal workflow is create collection → create/open request → edit → save → reopen → execute with selected environment.

[Export documentation](https://learning.postman.com/docs/getting-started/importing-and-exporting/exporting-data/) describes portable JSON collection/environment data. Collection v2.1 will be the interchange format; common folders, methods, structured/raw URLs, headers, bodies, authentication, variables and script events must survive round trips. Unsupported import fields should produce warnings.

[Collection Runner](https://learning.postman.com/docs/tests-and-scripts/running-collections/intro-to-collection-runs/) executes ordered requests, supports iterations, data and delay, and shows results. Local sequential execution with cancellation and test summaries is a useful account-free alternative; hosted scheduling is distinct.

## Variables, secrets and authentication

[Variable scopes](https://learning.postman.com/docs/use/send-requests/variables/variables/) resolve from broad to narrow: global, collection, environment, iteration data, local. Strings use double-brace substitution. ApiWorkbench will implement global → collection → environment → request/local, and apply interpolation to URL, headers, body and authentication. Missing or cyclic values must be actionable errors. Secret rows should be masked, and logs must redact credentials.

[Authentication](https://learning.postman.com/docs/use/send-requests/authorization/authorization/) allows parent inheritance and request-level overrides. [OAuth 2.0](https://learning.postman.com/docs/use/send-requests/authorization/oauth-20) has several grant types and token retrieval; an auth dropdown alone is insufficient. Initial implementation will prioritize no auth, API key, bearer, basic, Digest and working OAuth client credentials/refresh. Authorization code/PKCE requires a separate redirect lifecycle and is tracked independently.

## Scripts and tests

The [sandbox overview](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview) describes the pm object and broader APIs. [Assertions](https://learning.postman.com/latest-v-12/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect) use named tests and Chai-style chains. [Response test workflows](https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts) place results under the response. Implement a documented synchronous subset with variables, response access, console and assertions in a bounded QuickJS WASM runtime. Do not use Node vm as a security boundary or expose filesystem/network primitives to scripts.

## Protocol inventory and cloud boundary

[Product overview](https://www.postman.com/product/) and [request documentation](https://learning.postman.com/docs/use/send-requests/create-requests/request-basics) describe HTTP, GraphQL, gRPC, WebSocket, MQTT, MCP and AI requests. These require different protocol engines; HTTP body support does not imply native gRPC support. HTTP and GraphQL-over-HTTP are essential here. Other protocols will only appear if end-to-end implemented.

Cloud sync, accounts, workspace invitations, comments, public/private API networks, hosted monitors, hosted mocks, shared vault and AI services depend on infrastructure. Equivalent proprietary services cannot be recreated from the client. Local alternatives are SQLite workspaces, explicit JSON exchange/backup, a manual collection runner and local API descriptions. No cloud service is fabricated. The [offline client documentation](https://learning.postman.com/latest-v-12/docs/getting-started/basics/using-api-client) distinguishes Postman's lightweight offline mode from cloud workspaces; ApiWorkbench deliberately keeps all implemented workflows available without an account.

## Engineering references

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): sandbox, isolation, constrained IPC and navigation controls.
- [Electron context isolation](https://github.com/electron/electron/blob/main/docs/tutorial/context-isolation.md): narrow bridge methods.
- [Windows build target](https://www.electron.build/v26/docs/win/): portable target.
- [Portable options](https://www.electron.build/docs/api/app-builder-lib.interface.portableoptions/): extraction lifecycle; application data must be outside the temporary extraction directory.

## Verification approach

Use deterministic loopback HTTP/TLS fixtures and an actual Electron window. Inspect our screenshots beside the documented spatial layout, without copying proprietary imagery. Verify the built portable launcher separately from development Electron. Record release checksum and exact runtime scope in TEST_REPORT.md.
