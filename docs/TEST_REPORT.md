# Test and release report — SendIt! 1.0.0

Date: 2026-10-12. Final results below refer to the delivered source and portable executable. Requests use deterministic local HTTP/TLS/WebSocket/SSE fixtures; no response is simulated inside the application.

## Release artifact and actual Windows verification

| Property   | Recorded value                                                                       |
| ---------- | ------------------------------------------------------------------------------------ |
| Artifact   | `dist/SendIt-Portable-Win-x64.exe`                                                   |
| File size  | **104,912,457 bytes** (100.05 MiB)                                                   |
| SHA-256    | `ce0bf3bdf9e3ce83a8bd37fab64b15fc75e9d183b8dfeb115adfb9a952b098c3`                   |
| Format     | electron-builder single Windows x64 portable launcher; no installation wizard        |
| Signing    | **Unsigned**; independently checked with Get-AuthenticodeSignature                   |
| Test host  | **Windows 11 Pro, 10.0.26200, x64**                                                  |
| Runtime    | Electron 44.7.0; Chromium 152.0.7977.130; bundled Node 24.21.0; native SQLite 3.53.4 |
| Windows 10 | Targeted, **not individually runtime-tested**                                        |

`tests/release-smoke.mjs` copied the actual EXE to a fresh directory and started that launcher directly with `child_process.spawn`. The app loaded its renderer from packaged `app.asar`. The test removed developer Electron/Node/data override variables, connected automation to Chromium, and verified all **ten release checks**:

1. Direct launch using the runtime bundled in the portable EXE.
2. Creation of `SendIt-data/workbench.sqlite` beside the launcher, not the temporary extraction directory.
3. Real native HTTP request and displayed JSON/status.
4. Real assertion execution using the packaged QuickJS WASM dependency.
5. Renderer has no Node `require` or `process` globals.
6. Clean window close and launcher exit.
7. Launch again with the same portable data, restore the saved collection/request, and successfully resend.
8. Show all seven methods in the packaged dropdown, select POST, verify the server receives POST, then select and resend GET.
9. Apply the pink theme and 125% app zoom through the packaged settings controls.
10. Restore pink and 125% zoom after restart, then reset zoom with Ctrl+0.

No development server, installed Electron, Python or external Node executable was launched by the application. Node/Playwright drive the test harness only. The host has development tools installed, so this is not a pristine VM certification. A debug port is supplied only by the test launcher; ordinary launch does not enable it.

Machine-readable evidence: [PORTABLE_VERIFICATION.json](PORTABLE_VERIFICATION.json), also copied to `dist/RELEASE.json`. [Portable screenshot](screenshots/portable-release.png) was captured from the restarted packaged application.

## Automated unit and integration tests

**89 passed, 0 failed, 0 skipped**, across five files. TypeScript checking and the production build also pass. Raw results: [UNIT_TEST_RESULTS.json](UNIT_TEST_RESULTS.json).

| Suite                 | Passed | Important coverage                                                                                                                                                                                                                                      |
| --------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interchange           |     48 | v2.1 common-structure round trips, nested folders, bodies/auth/scripts, environment metadata, cURL quoting/rejection, file-path clearing, import bounds, safe snippets/docs                                                                             |
| HTTP engine           |     18 | GET/JSON/headers/params, scopes/scripts, Basic/Bearer/API key/Digest, OAuth grants, forms/multipart/binary/GraphQL, compression, cookies, redirects and credential stripping, proxy/CONNECT, default TLS verification, cancellation/timeout/size/errors |
| Live protocols        |     10 | WS messages/fragmentation/binary/subprotocols, auth/variables, disconnect/limits, incremental SSE UTF-8/BOM/CRLF/multiline, MIME/redirect rejection, timeout, TLS/proxy                                                                                 |
| Scripts and variables |      7 | Assertions/scope APIs, no host capabilities, infinite-loop/memory bounds, async-test rejection, syntax errors/isolation, recursive scope precedence and missing/cyclic references                                                                       |
| Storage               |      6 | SQLite reopen persistence, secret-codec boundary, protected cookie persistence, rejected invalid writes/previous snapshot, cyclic-folder rejection, legacy zoom defaults and pink/zoom persistence                                                      |

Storage unit tests inject a deterministic test codec to exercise serialization. Real Electron QA uses Windows DPAPI and reopens a workspace containing a marked secret. This does not replace cryptographic or penetration testing.

## Mandatory desktop acceptance scenarios

All requested scenarios were exercised. The full desktop suite uses real Electron/React/Monaco, IPC, native transport and SQLite. Native open/save dialogs return deterministic fixture paths; file bytes and persistence remain real. Collection export validates the real export bridge and output file. The full suite ran against the built application in development Electron; the separately packaged EXE has the eight checks above.

| Requested scenarios                                     | Result/evidence                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1–4 Launch, create request, local GET, render response  | Passed                                                                                        |
| 5–8 JSON POST, custom headers, query parameters, Bearer | Passed; loopback server verifies actual request                                               |
| 9–11 Save collection, restart, restore                  | Passed                                                                                        |
| 12–14 Environment creation, URL reference, real send    | Passed                                                                                        |
| 15–16 Import valid Postman collection, export           | Passed; output JSON validated                                                                 |
| 17–18 Light/dark switch, open/close tabs                | Passed; screenshots inspected                                                                 |
| 19 Assertion                                            | Passed in UI and packaged QuickJS                                                             |
| 20 Failed request                                       | Passed; deliberate socket disconnect produces visible transport error                         |
| 21 Upload                                               | Passed; picker-selected binary bytes match exactly; multipart also covered by engine fixtures |
| 22 Portable build starts with bundled runtime           | Passed; direct EXE launch and restart, separately recorded                                    |
| Additional WebSocket/SSE/isolation checks               | Passed                                                                                        |

The desktop script has **24 passed checks**; item 22 is recorded in the separate portable report, not counted twice. Raw evidence: [E2E_DEVELOPMENT_RESULTS.json](E2E_DEVELOPMENT_RESULTS.json).

The extended UI suite adds **12 passed checks**, with zero renderer exceptions: nested-folder context menus; scripted save/duplicate; dialog movement and request drag/reorder; tab drag; pane resize/collapse and minimum window; real two-request runner with assertions; secret environment export/import; backup/change/restore; immediate unsaved edit flush during native close and restart; dark/light/pink switching and matching Monaco backgrounds; native app zoom at 75%, 125%, 150% and 200%, shortcuts inside editors and rejected invalid IPC values; appearance persistence after restart and zoom reset at the 900 × 640 minimum window. Evidence: [UI_INTERACTIONS_RESULTS.json](UI_INTERACTIONS_RESULTS.json).

## Visual inspection and defects resolved

Inspected actual screenshots of dark/light themes, the 900 × 640 minimum window, response/tests, live messages, collection runner and final portable application. Compared hierarchy against the official Postman layout reference: dense header, left rail/explorer, request tabs, address row, editor tabs, lower response area and footer. Original branding/icons/colors are used. At minimum width the tab strip scrolls and panes remain usable; long responses stay inside editor scrolling surfaces.

During development, fixed Monaco worker import paths for the installed version, corrected automation to type into Monaco's native edit surface, and added unambiguous accessible labels to theme and collection/folder controls. An initial portable script check read a draft before its 200 ms autosave; the check now waits for actual persisted state before invoking that bridge. These failures were investigated and the final runs pass. No unresolved failure is hidden by removing a required check.

Representative captures: [dark](screenshots/sendit-dark.png), [light](screenshots/sendit-light.png), [pink](screenshots/sendit-pink.png), [appearance settings](screenshots/appearance-settings.png), [125% zoom](screenshots/sendit-zoom125.png), [minimum window](screenshots/sendit-minimum-window.png), [test results](screenshots/test-results.png), [runner](screenshots/collection-runner.png), [WebSocket](screenshots/live-connections.png), [SSE](screenshots/server-sent-events.png), [portable EXE](screenshots/portable-release.png).

## Dependency and build findings

The [production dependency audit](dependency-audit-production.json) reports zero known advisories. The complete development/build dependency audit reports **eight moderate entries** tracing to the same unpatched `sprintf-js` advisory in the electron-builder toolchain: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). These build dependencies are not application runtime dependencies. This remains a disclosed toolchain limitation; no blanket vulnerability-free claim is made. Snapshot: [dependency-audit.json](dependency-audit.json).

Vite emits a large-chunk advisory for bundled Monaco/editor language workers; packaging succeeds and the editor runs offline. Electron's built-in SQLite may emit an experimental API notice in the development runtime. Neither is a failed check.

## Method selector correction

Replaced the browser datalist, which filtered the initial GET value and hid the other methods, with an explicit accessible dropdown showing all seven standard methods. Custom method typing remains supported. The desktop acceptance suite verifies the entire option list, mouse selection of POST, arrow/Enter selection of PUT, custom PROPFIND entry, reopening the complete list and real POST execution. [Actual selector screenshot](screenshots/http-method-selector.png).

## Not established by these checks

Windows 10 runtime behavior, enterprise endpoint-security policy compatibility, publisher signing/SmartScreen reputation, a clean-VM installation matrix, all external OAuth providers, long-duration soak/load testing, high-DPI/multi-monitor edge cases, read-only-folder behavior under all ACL policies, every Postman import extension and independent security review. Implemented guardrails and explicit limitations are described in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and [SECURITY.md](SECURITY.md).

## Reproduction

On Windows x64 with Node.js 24.16+ and npm:

```powershell
npm ci
node node_modules/electron/install.js
npm run check
npm test
npm run build
node tests/e2e.mjs
node tests/ui-interactions.mjs
npm run package
node tests/release-smoke.mjs
Get-FileHash dist/SendIt-Portable-Win-x64.exe -Algorithm SHA256
```

Builds require network access to npm and Electron/electron-builder release downloads. Ordinary use requires no app-owned service. Rebuilding may produce a different hash because packaging metadata can vary; verify the hash of the artifact actually distributed.
