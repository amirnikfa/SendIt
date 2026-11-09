# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OpenAPI & Swagger Import**: Added support for importing OpenAPI 3.0/3.1 and Swagger 2.0 specifications from both JSON and YAML formats into SendIt collections. Automatically resolves `$ref` schemas, generates mock request body payloads from object/array/primitive definitions, parses query/header/path parameters, maps tags into folder hierarchies, and imports Bearer, API Key, and Basic security schemes.
- **OpenAPI 3.0 Export**: Added collection export to OpenAPI 3.0 in both YAML (`.openapi.yaml`) and JSON (`.openapi.json`) formats, complete with server definitions, path items, operations, tags, request bodies, and auth configurations.
- **OpenAPI UI Actions**: Added "Export OpenAPI 3.0 (YAML)" and "Export OpenAPI 3.0 (JSON)" options to collection context menus and collection settings dialogs. Updated the Import dialog and file picker to accept `.yaml` and `.yml` files alongside `.json`.
- **OpenAPI Test Coverage**: Added comprehensive test suite in `tests/interchange.test.ts` validating OpenAPI 3.0 JSON/YAML parsing, Swagger 2.0 JSON parsing, OpenAPI 3.0 YAML/JSON export, and import-export roundtripping.

### Fixed

- **History TLS & Collection Context**: Preserved collection context (`collectionId`, `folderId`) and effective TLS verification settings (`verifyTls`) when opening requests from History. Recalling requests that rely on collection-level SSL bypass or collection variables no longer fails with CA certificate validation errors.
- **Response Panel Send Icon**: Added `flex-shrink: 0`, `aspect-ratio: 1 / 1`, and minimum dimension constraints to `.empty-icon` and its SVG icon in `styles.css`. The SendIt paper airplane icon now maintains its proper proportions without vertically squashing when resizing or collapsing the bottom response panel.

## [1.0.0] - 2026-11-09

### Added

- PKCS#12 legacy cipher support (e.g. RC2-40), SSL bypass options, and flexible certificate controls.
- Per-request SSL toggle, wildcard mTLS host matching, and system CA trust.
- Custom CA certificates and mutual TLS (mTLS) support.
- 125% default app zoom controls and pink appearance theme.
- Rebranded desktop app as SendIt! with local offline-first storage and Windows certificate security.
