# Import, export, and snippet compatibility

Implemented in `src/services/interchange.ts`. Research and verification date: 2026-10-11.

## Postman collection JSON

The importer accepts the common v2.0/v2.1 layout and exports v2.1. It creates new internal IDs so importing the same file cannot overwrite an existing collection. Requests remain editable.

| Data | Behavior |
| --- | --- |
| Collections and nested folders | Names, descriptions, nested parents, authentication and scripts retained; maximum 40 folder levels |
| Requests | Names, descriptions, methods, URL, headers, body, local variables and scripts retained |
| URLs | String/raw and structured host/path/port forms; query rows and duplicates retained; disabled rows excluded from the active URL |
| Path variables | `/:id` converted to `/{{id}}` with values stored as request variables |
| Key/value rows | Descriptions, enabled state and secret metadata retained where represented |
| Authentication | No Auth, parent inheritance, Basic, Bearer, API key, Digest and OAuth 2.0 token/client-credentials/refresh settings |
| Bodies | Raw language, URL-encoded, multipart, binary mode and GraphQL query/variables |
| Files | Every imported file reference cleared; select local files again before sending. Import never opens or reads paths in the imported content. |
| Scripts | Enabled JavaScript prerequest/test events at collection, folder and request level; multiple events joined in source order |
| Environment JSON | Names, values, enabled state and secret metadata; globals exports can be imported as environments with a warning |

Unsupported top-level, folder, item and request fields produce warnings. Examples include saved example responses, folder variables, request-specific proxies/certificates and protocol behavior overrides. External script URLs are not fetched. Disabled script events and bodies are omitted with warnings. Unsupported auth schemes become No Auth with a warning. Unsupported body modes cancel the import instead of dropping the body. OAuth authorization-code flows are not configured by import; existing access tokens are retained.

The internal explorer stores folders and requests separately. Relative folder order and request order survive within those lists, but export places folders before direct requests at each level. Collection IDs, original imported IDs, description MIME metadata and Postman cloud metadata are not preserved. Non-string variable values become deterministic string/JSON values. This is common-structure compatibility, not lossless archival of every Postman field. Use application backups for exact local-state archival.

Collection secret flags use the optional `x-apiworkbench-secret` extension; environment exports use the familiar `type: "secret"` flag. The collection extension survives ApiWorkbench round trips and does not misuse the v2.1 variable type enumeration. Other clients may ignore the extension.

## cURL

Import parses command text directly and never invokes a shell or subprocess. It supports POSIX single/double quoting, escaped characters and multiline continuations; `curl.exe` is also recognized. Common options include method, URL, duplicate headers, Basic/Digest/Bearer auth, JSON/raw data, URL-encoded fields, multipart fields/files, cookies, user agent and referrer. `--get` moves data to query parameters. `--data-raw` and `--form-string` retain literal `@` values. `--data-urlencode` requires `name=value` for editable form fields.

File-based bodies, header files and cookie files are never read. Files must be reselected, and omitted fields/settings are reported. `--insecure` does not alter application TLS settings. Unknown options produce warnings. Mixed body encodings, multiple URLs, incomplete quotes, shell operators and command substitutions are rejected. This parser does not implement every cURL flag, shell expansion, Windows cmd.exe escaping, or PowerShell expression syntax. Exported cURL uses POSIX quoting; use Git Bash or WSL to run those snippets on Windows. Variables remain `{{variables}}`; replace them before using a snippet in another client.

## Generated outputs

- **cURL** includes enabled query rows, headers, supported explicit auth and bodies. Parent auth, application networking settings, scripts, cookies from the cookie jar, and environment resolution are outside standalone snippets.
- **HTTP** produces an editable HTTP-client-style request snippet. Multipart construction and Digest challenge calculations are indicated in comments; use cURL or the application for those cases.
- **Offline Markdown** lists saved endpoints, descriptions, folder paths, headers and parameters. It redacts known credential headers/parameter names and secret rows, omits auth values and raw body values, and does not render remote assets. Review descriptions and URLs before sharing; arbitrary user text can contain sensitive information.
- **Collection/environment exports** intentionally retain configured values, including credentials and selected file paths. These files are sensitive. Imported paths are always cleared again.

## Validation and limits

Inputs are limited to 20 MiB of text characters, 150,000 JSON values, 100 JSON levels and 10,000 collection items. Prototype-related object properties are rejected. Invalid data produces an actionable error. No imported scripts run during import; scripts run only when sending a request in the bounded script runtime.

## References

- [Official Postman v2.1 schema](https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json)
- [Postman import workflows and cURL conversion](https://learning.postman.com/docs/getting-started/importing-and-exporting/importing-data/)
- [Official cURL manual](https://curl.se/docs/manpage.html)

The automated suite is `tests/interchange.test.ts`. Run it with `npx vitest run tests/interchange.test.ts`.
