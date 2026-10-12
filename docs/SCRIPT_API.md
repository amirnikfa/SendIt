# Script runtime and supported APIs

SendIt! runs pre-request and post-response JavaScript in a new QuickJS WebAssembly runtime. The runtime exposes no Node.js, Electron, filesystem, HTTP, `fetch`, module loader, timers, or renderer objects. This follows the isolation and resource-control interfaces documented by [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten). Native `eval`/`Function` stay inside the guest runtime and cannot obtain host privileges.

Each script is limited to 500 ms, 16 MB guest memory, 512 KB stack, 256 KB source, 1,000 test cases, and 200 console messages of up to 4,000 characters each. All scripts attached to one request share a 2-second execution budget. Script input, including the response text, is limited to 5 MB; larger responses remain available in the response viewer but produce a clear script-input-limit error. No asynchronous job queue is run. Async test callbacks produce a failed test rather than a false pass.

Scripts run in collection, outer-folder, inner-folder, request order when the caller provides that hierarchy. Pre-request scripts run before variable interpolation and networking. A pre-request error prevents sending. Post-response errors become failed test results without discarding the real HTTP response. Each successful script's variable changes carry into the next script and the returned environment, global and collection state. Local variables last for the current execution. When a script throws or hits a resource limit, that script's variable changes are rolled back and its error is reported.

## Variables

Available scope objects:

- `pm.globals`
- `pm.collectionVariables`
- `pm.environment`
- `pm.variables`

Each implements `get(name)`, `has(name)`, `set(name, value)`, `unset(name)`, `clear()`, `toObject()`, and `replaceIn(text)`. Values set through scripts are stored as strings. `pm.variables.get` reads local/request → environment → collection → global. `pm.variables.set`, `unset` and `clear` change only the local scope. Environment and global edits persist when the application saves execution results. A disabled variable is not resolved.

Request execution recursively resolves `{{name}}` in URLs, enabled query/header values and names, active body fields, and active authentication fields. Missing or cyclic references produce actionable errors. Interpolation supports `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}` and `{{$randomInt}}` (0–1000). The sandbox's `replaceIn` is a simple one-pass substitution and leaves missing references unchanged; it does not implement the dynamic variables.

## Tests and assertions

`pm.test(name, synchronousCallback)` captures a named pass/failure. `pm.test.skip(name)` writes a console entry without running a callback.

`pm.expect(value, optionalMessage)` supports:

- Readable chain words: `to`, `be`, `been`, `is`, `that`, `which`, `and`, `has`, `have`, `with`, `at`, `of`, `same`.
- `.not`, `.deep`, `.equal` / `.equals` / `.eq`, `.eql`.
- `.include` / `.includes` / `.contain`, `.property(key, optionalValue)`.
- `.a(type)` / `.an(type)`, `.match(regex)`, `.oneOf(values)`, `.lengthOf(number)`.
- `.above` / `.greaterThan`, `.below` / `.lessThan`, `.least`, `.most`, `.within`.
- Property assertions: `.true`, `.false`, `.null`, `.undefined`, `.ok`, `.exist`, `.empty`.

This is a documented compatibility subset, not the complete Chai API. JSON object deep equality compares object keys and array elements recursively.

## Response access (post-response only)

- `pm.response.code`, `.status`, `.responseTime` (milliseconds), `.responseSize` (decoded bytes).
- `pm.response.text()`, `.json()`; malformed JSON throws normally.
- `pm.response.headers.get(name)`, `.has(name)`, `.all()`, `.toObject()`; lookups ignore case.
- `pm.response.to.have.status(code)`.
- `pm.response.to.have.header(name, optionalValue)`.
- `pm.response.to.be.ok` asserts a 2xx status.

`console.log`, `.info`, `.warn`, `.error`, `.debug` append to the API console. Known authentication values, marked secret variables, sensitive variable names and sensitive custom headers are redacted from console output, test names, test errors and transport errors. This is best-effort redaction: scripts can transform values arbitrarily. HTTP response bodies and visible response headers are intentionally presented as returned by the server and can contain credentials reflected by that server.

```js
// Pre-request
pm.environment.set('resourceId', '42');
pm.variables.set('runLabel', 'local execution');

// Post-response
pm.test('Successful response', () => {
  pm.response.to.have.status(200);
  pm.expect(pm.response.json()).to.have.property('id');
});
pm.test('Fast response', () => {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});
const data = pm.response.json();
if (data.access_token) pm.environment.set('access_token', data.access_token);
```

## Unsupported sandbox capabilities

`pm.sendRequest`, `pm.execution`, `pm.iterationData`, `pm.request` mutation, async callbacks/promises, imported npm packages, legacy global `tests` objects, full Chai/plugin assertions, Postman Vault and cloud services are unsupported. Collection runner requests execute in their saved order; scripts cannot alter runner flow. No unsupported capability is represented as a working API.

## Networking boundaries

The desktop transport implements HTTP/1.1 and HTTPS independently of browser CORS. TLS verification is enabled by default. HTTP/HTTPS proxies (including credentials in the proxy URL), bounded redirects, standard cookie policy, gzip/deflate/Brotli decoding, cancellation, duplicate headers, all standard/custom method tokens and common body modes are implemented.

Uploads and decoded responses are limited to 50 MB; the response setting can lower its bound. Request timeout accepts 1–600,000 ms. Upload paths must have been approved through the application file picker; approved real paths are persisted in the local data directory. Imported paths do not grant filesystem access. Cookies persist through the caller's serialized jar. Redirects are capped at ten, HTTPS-to-HTTP downgrade redirects are refused, and authorization/cookie headers plus identifiable key/token/secret headers and the configured API-key query parameter are removed when the destination origin changes. Cookies from the jar are still evaluated using standard domain/path rules.

Authentication supports no auth, parent inheritance, Basic, Bearer, header/query API keys, Digest (MD5, SHA-256, SHA-512-256; sess; auth/auth-int), and OAuth Bearer tokens. Token acquisition implements OAuth client credentials and refresh-token grants with HTTP Basic client authentication. Token endpoints require HTTPS except loopback development addresses; token requests do not follow redirects. OAuth authorization-code/PKCE, implicit/password flows, client-secret-in-body variants, automatic token refresh, AWS signing, NTLM, client TLS certificates, custom CA files, SOCKS/PAC proxies, HTTP/2 and gRPC are not implemented.

The separate Live connections tool implements WebSocket/WSS and incremental SSE. It supports variables, headers, Basic/Bearer/API-key authentication, TLS verification and HTTP/HTTPS proxies. It does not execute scripts, share the HTTP cookie jar, auto-reconnect or follow redirects. It has at most four concurrent connections and a 1 MB message/event bound; binary WebSocket previews are limited to 64 KB. Sending WebSocket messages is text-only.

Response size is the decoded body byte count. Exact response bytes are retained as Base64 for saving binary responses; text is decoded using the declared charset when available, with UTF-8 fallback. Response headers retain original compression headers even though the saved/viewed body is decoded. Headers and responses are never replaced with mocked sample data.

Engineering references: [Node HTTP client](https://nodejs.org/api/http.html), [tough-cookie](https://github.com/salesforce/tough-cookie), [Postman sandbox overview](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview), [Postman variables](https://learning.postman.com/docs/use/send-requests/variables/variables/).
