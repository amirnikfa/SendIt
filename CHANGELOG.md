# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **History TLS & Collection Context**: Preserved collection context (`collectionId`, `folderId`) and effective TLS verification settings (`verifyTls`) when opening requests from History. Recalling requests that rely on collection-level SSL bypass or collection variables no longer fails with CA certificate validation errors.
- **Response Panel Send Icon**: Added `flex-shrink: 0`, `aspect-ratio: 1 / 1`, and minimum dimension constraints to `.empty-icon` and its SVG icon in `styles.css`. The SendIt paper airplane icon now maintains its proper proportions without vertically squashing when resizing or collapsing the bottom response panel.

### Added

- **History Execution Test**: Added test coverage in `tests/certificates.test.ts` ensuring requests run from a collection preserve `verifyTls: false` into history, open with full collection inheritance, and execute successfully without CA errors.

## [1.0.0] - 2026-11-09

### Added

- PKCS#12 legacy cipher support (e.g. RC2-40), SSL bypass options, and flexible certificate controls.
- Per-request SSL toggle, wildcard mTLS host matching, and system CA trust.
- Custom CA certificates and mutual TLS (mTLS) support.
- 125% default app zoom controls and pink appearance theme.
- Rebranded desktop app as SendIt! with local offline-first storage and Windows certificate security.
