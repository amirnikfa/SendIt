# TLS certificates in SendIt!

Open **Settings → Certificates** to configure custom trust and client authentication. Changes apply to new connections for HTTPS requests, OAuth token acquisition, WSS and HTTPS SSE. Disconnect and reconnect an existing live connection to apply changed certificates.

## Custom CA certificates

1. Click **Add CA certificate** and choose a `.pem`, `.crt` or `.cer` file.
2. **Use custom CA certificates** is enabled when a file is added. It can be disabled without removing the saved files.
3. Keep **Settings → Network → Verify SSL certificates** enabled.

PEM bundles and individual DER certificates are supported. Custom certificates extend the runtime's default trusted CA set. Hostname, validity and certificate-chain verification remain enabled. CA trust also applies to HTTPS proxies. Up to ten CA files may be stored, each at most 256 KB. Private keys in CA files are rejected.

## Client certificates for mTLS

1. Click **Add client certificate**.
2. Enter the exact hostname or IP address, such as `api.example.com` or `127.0.0.1`, and the TLS port. HTTPS defaults to **443**. Enter no URL, path or wildcard; enter the port separately.
3. Choose a format:
   - **CRT / PEM + KEY:** select a certificate or PEM certificate chain and its matching PEM private key. An individual DER client certificate is also accepted. Enter the passphrase for an encrypted key.
   - **PFX / P12:** select the PKCS#12 file containing the client identity and enter its passphrase if required.
4. Click **Save client certificate**. SendIt validates the identity before saving; an invalid file, mismatched key or incorrect passphrase leaves the previously saved identity intact.

Up to twenty client identities are supported, with one identity per hostname/port and at most 256 KB per file. Use the checkbox to temporarily disable an identity, or edit/remove it. International hostnames and IPv6 addresses are normalized for exact matching. Subdomains and different ports need separate entries.

Client credentials are applied only to the matching TLS destination. They are recalculated for each HTTP redirect and are never sent on plain HTTP or presented to an HTTPS proxy as the destination identity. CA certificates included in a PFX/P12 also provide server trust for that matching destination. Encrypted certificate bags are decoded using the identity's passphrase and the archive's integrity is checked when a MAC is present. Only CA certificates are added as trust anchors; the client leaf certificate is not.

An imported issuing CA can anchor the server chain even when the bundle omits its root. TLS still verifies certificate signatures, validity and the server hostname. CA files added under custom trust support issuing CAs in the same way. If the P12 contains only a client identity or its CA does not issue the server certificate, add the server's CA under custom trust.

Postman collections do not contain the application's global verification setting or client certificates. For example, a collection can explicitly disable verification on `loginStatic` while leaving its other requests to inherit the global setting. Successful login in that case establishes a cookie but does not establish server trust. The login cookie is reused by subsequent requests; each TLS connection still needs the appropriate CA chain. Keep verification enabled and configure the P12 for the service's host and port.

## Explicit SSL exceptions

If the server CA is unavailable, a certificate failure offers **Disable SSL for https://host:port & Retry**. This is an explicit bypass of server certificate verification for that exact destination. It applies to later requests and survives restart. It does not install a CA or make the server certificate trusted. Global verification remains enabled, HTTPS proxy verification stays separate, and redirects to other hosts or ports are checked using their own settings. A request explicitly set to SSL On still verifies its server certificate.

**Disable SSL for this request & Retry** affects only the current request. Neither retry action changes global verification. Review or remove host exceptions under **Settings → Certificates → SSL verification exceptions**. Removing an exception restores inherited verification for that destination. WSS uses the same host and port exception as HTTPS.

## Storage and migration

Files are imported as bytes through native file selectors; subsequent requests do not depend on the original file remaining on disk. Private-key data, PFX/P12 data and passphrases are encrypted in SQLite using Windows DPAPI. Public certificates and CA certificates remain plaintext. Removing an entry stops its use; it is not a secure erasure of earlier database snapshots or exported files.

Explicit **Settings → Data → Export backup** includes certificate files and passphrases in plaintext. Store backups securely. To migrate to a different Windows account or machine, export from the original account and restore into a fresh data directory. Collection/environment exports do not include these application certificate settings.

## Verification

`tests/certificates.test.ts` uses actual TLS handshakes to test CA trust, PEM/encrypted-key/PFX identities, exact host/port matching, redirects, HTTP/HTTPS proxies, OAuth, WSS and SSE. `tests/certificates-ui.mjs` verifies native file import, validation errors, successful requests, Windows encryption, restart and backup restoration. `tests/release-smoke.mjs` checks custom CA trust and both client formats in the actual portable executable.

The certificate suite also covers AES-128/AES-192 encrypted certificate bags, intermediate-only P12 chains, invalid archive passwords/integrity, and an imported `loginStatic` followed by a verified service request after cookie persistence. It checks that a P12's client leaf does not enter the trust list, CA trust stays scoped to the identity destination, and hostname mismatches still fail.

The AES fixtures reuse the existing public test identity and CA. To regenerate, run OpenSSL `pkcs12 -export -inkey tests/fixtures/client-key.pem -in tests/fixtures/client-cert.pem -certfile tests/fixtures/localhost-cert.pem -passout pass:fixture-passphrase -keypbe AES-256-CBC -certpbe AES-128-CBC -iter 2048 -out tests/fixtures/client-aes128.p12`; use `AES-192-CBC` and `client-aes192.p12` for the second fixture. The intermediate-only archive and server certificate are generated locally by the test.

Files in `tests/fixtures` are public test credentials for local fixture servers, including a PFX password of `fixture-passphrase`. They must not be used as production identities.

TLS options are implemented with the [Node TLS API](https://nodejs.org/api/tls.html). This feature does not add a TLS protocol-version or cipher-selection control.
