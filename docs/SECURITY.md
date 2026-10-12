# Security and data handling

The renderer has no Node integration, runs in Chromium's sandbox and uses context isolation. A narrow preload bridge exposes named methods. Every IPC call checks both the originating webContents and the exact main frame URL. Zod validates request, settings, import/export and persisted state boundaries. New windows, application navigation, webviews and permission requests are denied.

HTTP/HTTPS run in the main process, independent of browser CORS. TLS verification is on by default. Proxy and TLS settings are explicit. Redirects are capped, HTTPS downgrade is refused, and cross-origin redirects discard recognized authentication and cookie headers. Native uploads require a file selected with the application picker; importing a path cannot read that file. File exports always use a native save dialog.

QuickJS/WASM executes synchronous scripts without Node, Electron, network or filesystem globals. The sandbox limits memory to 16 MB and a script to 500 ms. An aggregate script budget bounds inherited script chains. The supported API is documented in SCRIPT_API.md. This is a capability boundary, not Node's vm module.

Response HTML uses a scriptless sandboxed iframe with a restrictive content policy; no external resources are loaded. Code and response text use Monaco. Remote SVG/images are only displayed as image resources. The viewer displays a labeled 2 MB text preview; the complete response remains available for file saving up to the configured response limit (maximum 50 MB).

## At-rest protection and portable migration

SQLite commits state atomically with WAL and FULL synchronization. A previous state document is retained in the same database. Recognized auth tokens/passwords/client secrets, marked secret variable values and recognized sensitive header values are encrypted with Electron safeStorage, backed by Windows DPAPI. Cookie storage is encrypted as a whole. UI masking does not itself provide encryption.

**Windows DPAPI is tied to the Windows user account.** Move the EXE and SendIt-data together on the same account. To migrate to another machine/account, explicitly export a JSON backup on the original account, then restore it in a fresh data directory on the destination. The native export dialog states that backups contain unencrypted credentials. Store and transmit exports accordingly. Database contents encrypted on another account produce a clear load error; the application does not silently replace the data.

Descriptions, URLs, raw request bodies and unmarked ordinary variable values remain plaintext in SQLite. Do not embed secrets there; use marked variables or auth fields. Request history stores request configuration with the same protection rules. Response bodies are not persisted automatically. The console records request names/status plus redacted script output, not complete raw HTTP traffic. Redaction cannot infer every application-specific secret that a script constructs or transforms.

## Certificate credentials

Custom CA trust extends the runtime's default CA set while preserving server and hostname verification. Client identities are selected by exact normalized hostname and port on each TLS request, including redirects. Plain HTTP receives no client identity, and HTTPS proxies receive trust options without the destination's private credentials. Certificate import requires native file selection, with a 256 KB file limit; malformed identities and incorrect passphrases are rejected before saving.

Private-key bytes, PFX/P12 bytes and certificate passphrases receive the same Windows DPAPI protection as recognized auth credentials, including retained state snapshots. Public certificate and CA bytes remain plaintext. Explicit full-state backups contain these credentials unencrypted; collection/environment exports do not include application certificate settings. See [TLS_CERTIFICATES.md](TLS_CERTIFICATES.md).

## Release scope

The release has no telemetry, application-owned backend, login or automatic updater. Executable signing requires a publisher certificate and is outside this build. Keep the release and its Electron runtime current by rebuilding/upgrading. The release is functionally tested locally; it has not undergone an independent penetration test or broad enterprise deployment validation.
