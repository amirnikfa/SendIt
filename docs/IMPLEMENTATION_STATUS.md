# Implementation report — SendIt! 1.0.0

Research and delivery date: 2026-10-11. This is an independent, account-free Windows API client with original branding. The implemented scope below is functional; it is not complete Postman parity. Acceptance evidence is recorded in [TEST_REPORT.md](TEST_REPORT.md).

## Delivery checklist

- [x] Research current official Postman documentation and inspect the interface reference before implementation.
- [x] Record feature inventory, acceptance criteria, architecture and cloud boundaries.
- [x] Implement typed contracts, secure main/preload/renderer separation and validated IPC.
- [x] Implement native HTTP transport, authentication, variables and bounded scripting.
- [x] Implement SQLite persistence, Windows credential protection and adjacent portable storage.
- [x] Implement the renderer and complete core request/collection/environment workflows.
- [x] Test deterministic HTTP/TLS/proxy, scripts, storage and interchange: 101 passing tests.
- [x] Implement custom CA trust and exact host/port client certificates; seven desktop certificate checks pass, including Windows encryption and backup restoration.
- [x] Test real Electron: 24 acceptance checks and 12 extended interaction checks pass.
- [x] Inspect screenshots in all three themes, at 900 × 640, and for response/tests/live/runner states.
- [x] Fix discovered build, editor-input, accessibility and test synchronization issues.
- [x] Generate the actual Windows x64 portable executable.
- [x] Verify the final portable executable on Windows, including restart persistence, and record size/SHA-256.
- [x] Deliver complete source ZIP, README, research, feature matrix, architecture, compatibility/security notes, screenshots and test reports.

## Fully implemented within the stated scope

| Area                   | Delivered behavior                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop shell          | Original blue branding; custom title/window controls; workspace bar; navigation rail; explorer; tabs; environment selector; response split; console; dialogs, menus, toasts and tooltips; dark/light/pink themes; persistent app zoom and zoom shortcuts |
| Layout/navigation      | Resizable explorer/response panes, collapsible explorer, restored window bounds/tabs, dirty indicators, tab drag reorder, collection/request drag organization, context menus, search, URL history suggestions and shortcuts                             |
| Requests               | Standard/custom HTTP methods; synchronized URL/query rows; enabled/disabled and duplicate headers/params; descriptions, add/delete/reorder and bulk editing; validation/interpolation                                                                    |
| Bodies                 | None; raw JSON/XML/HTML/JavaScript/text; URL-encoded form; multipart text/files; binary picker uploads; GraphQL over HTTP; bundled Monaco editing/search/folding/formatting                                                                              |
| Transport              | Real HTTP/1.1 and HTTPS outside browser CORS; timeout/cancel; bounded redirects; verified TLS default; TLS override and HTTP/HTTPS proxies; cookies; gzip/deflate/Brotli; binary retention; meaningful errors                                            |
| Responses              | Actual status/text, duration and decoded size; headers/cookies; pretty/raw/editor views; scriptless HTML and image preview; JSON folding/search; malformed JSON fallback; copy and native save/download                                                  |
| Workspaces/collections | Create/rename/delete workspaces/collections; nested folders; saved requests, duplication, movement and ordering; descriptions; inherited collection/folder authorization and scripts                                                                     |
| Variables              | Globals, collection, environment and request/local scopes; environment CRUD/selection; secret masking; recursive substitution; missing/cycle errors; supported dynamic variables                                                                         |
| Authentication         | None, Basic, Bearer, header/query API key, custom headers, inherited auth, Digest; real OAuth client-credentials and refresh-token acquisition using HTTP Basic client authentication                                                                    |
| Scripts/tests          | Isolated QuickJS pre/post scripts; common synchronous pm scope/response/assertion APIs; named pass/fail results; errors/resource bounds; persisted global/environment/collection mutations                                                               |
| Runner                 | Sequential requests, iterations, delay, cancellation, inherited scripts, variable chaining, pass/fail summary and result export                                                                                                                          |
| Interchange            | Editable common Postman v2.1 collections/environments; nested structure/scripts/auth; unsupported-field warnings; safe cURL text import; cURL/HTTP snippets; offline Markdown documentation                                                              |
| Productivity           | History/reopen/clear, cookie manager, redacted console, settings, native response saves and explicit complete-state JSON backup/restore                                                                                                                  |
| Live tools             | WebSocket/WSS connect/send/receive/disconnect, subprotocols and binary previews; incremental SSE event/id/multiline and split UTF-8 parsing; authentication/headers/variables/TLS/proxy integration                                                      |
| Persistence            | SQLite WAL transactions/previous-state snapshot; protected recognized credentials/encrypted cookies; draft autosave with save status and close flush; adjacent portable runtime directories                                                              |
| Distribution           | Single portable x64 EXE containing Electron/resources; no installer/account/developer runtime needed; original icon; complete TypeScript source and lockfile                                                                                             |

## Partial compatibility and deliberate limits

- **Postman compatibility:** common editable v2.1 structures, not lossless storage of every extension. Export places folders before direct requests. Examples/cloud metadata/unsupported fields produce warnings. See [IMPORT_COMPATIBILITY.md](IMPORT_COMPATIBILITY.md).
- **OAuth:** client credentials and refresh-token grants work. Authorization code/PKCE, implicit/password, client-secret-in-body and automatic refresh are absent.
- **Scripts:** a synchronous documented pm/assertion subset, not the full Postman sandbox/Chai. No pm.sendRequest, pm.request mutation, timers, packages, workflow branching or iteration datasets. See [SCRIPT_API.md](SCRIPT_API.md).
- **HTTP settings:** TLS, custom CA trust, timeout, redirects, proxy and response bounds are application settings. Client certificates match exact hostname and port. No SOCKS/PAC, HTTP/2 or system-proxy discovery. See [TLS_CERTIFICATES.md](TLS_CERTIFICATES.md).
- **Responses:** bodies are buffered, not disk-streamed. Text display is a labeled 2 MB preview; saving retains the full bounded response. No JSONPath/XPath filters or custom visualizer templates.
- **Live:** separate from saved HTTP execution/history. No auto-reconnect, redirects, cookie-jar sharing, Digest, scripts or binary sending. Event logs are bounded.
- **Portable credentials:** DPAPI protection requires the original Windows account. Cross-account/machine migration uses a plaintext backup exported on the original account and restored to fresh data. Upload files remain external and may need reselecting.
- **Logging:** real status and redacted script output; no complete wire trace/HAR/developer debugger.
- **Formatting:** Monaco language-provider dependent; JSON formatting/validation is the main tested format. No XML schema validation or GraphQL introspection.
- **Assurance:** unsigned; manually rebuild/update. Verified on the documented Windows 11 host, not a broad Windows matrix or independent security audit.

## Unsupported

AWS SigV4, NTLM, gRPC, MQTT, Socket.IO, MCP, GraphQL subscriptions, saved response examples, hosted documentation, scheduled/background monitors, mock-server hosting, team collaboration/comments, Postman cloud sync, API networks, shared cloud vault and Postman AI. No inert controls advertise these as working. Local workspaces, JSON exchange, backups, Markdown and the manual runner are useful alternatives.

## Resource bounds

| Boundary           | Limit                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| State/IPC document | 32 MB serialized; save failure reported and previous committed state retained                                           |
| Workspaces / tabs  | 100 workspaces, 200 open tabs across workspaces                                                                         |
| Per workspace      | 2,000 collections/environments; 300 retained history entries                                                            |
| Per collection     | 20,000 requests/10,000 folders in validation; total state still limited to 32 MB                                        |
| Import             | 20 MiB text characters; 10,000 items; 40 folder levels; 150,000 JSON values; 100 JSON levels; native file at most 32 MB |
| HTTP               | Eight concurrent requests; 1–600,000 ms timeout; ten redirects; uploads/decoded responses at most 50 MB                 |
| Scripts            | 16 MB memory; 512 KB stack; 500 ms each/2 seconds aggregate; 256 KB source; 5 MB input; 1,000 tests                     |
| Live               | Four connections; 1 MB message/event; 64 KB binary preview                                                              |

History retains full request configurations and counts toward state size. Clear history or export/split large workspaces near the limit. This release is for interactive API development, not unbounded storage or load testing.
