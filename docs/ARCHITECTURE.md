# Architecture

SendIt! is a local Electron application. React + TypeScript + Zustand render the workbench. Vite bundles the renderer. Monaco is bundled locally; no CDN runtime dependency. Main and preload are built with esbuild. SQLite uses the runtime's built-in node:sqlite driver, avoiding native addon ABI mismatch.

## Boundaries

- `src/shared`: serializable request, response, workspace, settings and bridge contracts.
- `src/main`: application lifecycle, secure window, sender-validated IPC, native dialogs and execution orchestration.
- `src/preload`: one typed method per IPC operation; no raw invoke exposure.
- `src/networking`: native HTTP engine, cookies, authentication, redirects, cancellation and limits.
- `src/services`: variables, QuickJS scripts and interchange formats.
- `src/storage`: SQLite document transactions, adjacent portable storage and backups.
- `src/renderer`: React workbench and UI state. No Node integration.

The renderer sends typed request data to the main process. IPC input is validated before use. User-selected file paths are authorized by the main process; imported paths do not grant automatic filesystem access. The HTTP engine allows HTTP/HTTPS; the separate live engine allows WS/WSS and HTTP/HTTPS SSE connections. Response content is treated as untrusted text. HTML preview is sandboxed without scripts or external connections.

## Data

A versioned workspace document is committed atomically in SQLite. The state includes workspace hierarchy, environments, settings, draft tabs and bounded request history. Runtime responses are transient unless explicitly saved. Portable runs use `<executable directory>/SendIt-data`; unpacked builds use their executable directory. Development uses the project data directory. An existing data folder from the former app is reused if no SendIt-data folder exists. The former default title is updated; custom titles and encrypted credentials are preserved. Legacy backups and secret variable extensions remain readable. A read-only location produces an explicit error with relocation instructions. Chromium's profile is placed inside this data directory as well.

Recognized credential fields and sensitive headers are individually encrypted with Electron safeStorage (Windows DPAPI); marked variable values receive the same protection. Cookies are encrypted as a complete jar. Other document fields remain plaintext. Encryption is bound to the Windows account. Explicit plaintext JSON backup/restore supports migration to another account. See SECURITY.md for the exact storage boundary and migration procedure.

## Security and reliability

BrowserWindow uses contextIsolation, sandbox and no nodeIntegration. Navigation, new windows and permissions are denied. IPC verifies the top-level application sender. Scripts execute in QuickJS WASM with a memory limit and interrupt deadline, never Node eval/vm. Network sizes and timeouts are bounded. TLS verifies certificates by default; insecure mode is explicit. Cross-origin redirects must strip authentication. Persistence writes are serialized and transactional.

## Build and QA

Vitest tests engines with deterministic loopback fixtures. Playwright launches Electron for real UI workflows and screenshots. electron-builder produces the x64 portable launcher. A separate release smoke test launches the portable EXE and records Windows process/window evidence. No successful build claim substitutes for launch verification.
