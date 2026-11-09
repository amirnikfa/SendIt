import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { createSecureContext, getCACertificates, type ConnectionOptions } from 'node:tls';
import type {
  CertificateFile,
  CertificateFileKind,
  ClientCertificate,
  Settings,
} from '../shared/models';
import { certificateHost, matchesCertificateHost, verifyTlsForUrl } from '../shared/certificates';

export const MAX_CERTIFICATE_BYTES = 256 * 1024;

export function isPkcs12(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 16) return false;
  if (data[0] !== 0x30) return false;
  let offset = 1;
  if (data[offset] & 0x80) offset += 1 + (data[offset] & 0x7f);
  else offset += 1;
  if (data[offset] !== 0x02 || data[offset + 1] !== 0x01 || data[offset + 2] !== 0x03) return false;
  offset += 3;
  if (data[offset] !== 0x30) return false;
  return data.includes(Buffer.from('2a864886f70d010701', 'hex'));
}

function bytes(file: CertificateFile): Buffer {
  const data = Buffer.from(file.data, 'base64');
  if (!data.length || data.length > MAX_CERTIFICATE_BYTES)
    throw new Error('Certificate files must be nonempty and no larger than 256 KB.');
  return data;
}

/** Read PKCS#12 certificate bags, verifying the archive MAC when present. */
export function extractP12Certificates(
  p12Buf: Buffer,
  candidatePassphrases: string[] = [''],
): string[] {
  if (!p12Buf.length || p12Buf.length > MAX_CERTIFICATE_BYTES) return [];
  const passphrases: (string | undefined)[] = [...new Set(candidatePassphrases)];
  if (!passphrases.length) passphrases.push('');
  // PKCS#12 distinguishes an empty password from an absent password.
  if (passphrases.includes('')) passphrases.push(undefined);
  for (const passphrase of passphrases) {
    try {
      const archive = forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(p12Buf.toString('binary')),
        false,
        passphrase,
      );
      const bags =
        archive.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
      const certificates = bags.map((bag) => {
        // Forge retains ASN.1 for certificates with non-RSA public keys.
        const encoded = bag.cert
          ? forge.pki.certificateToPem(bag.cert)
          : Buffer.from(forge.asn1.toDer(bag.asn1).getBytes(), 'binary');
        return new X509Certificate(encoded).toString();
      });
      return [...new Set(certificates)];
    } catch {
      // Do not salvage certificates from damaged or incorrectly decrypted bags.
    }
  }
  return [];
}

export function extractCertificates(
  file: CertificateFile,
  candidatePassphrases: string[] = [''],
): string[] {
  const data = bytes(file);
  const text = data.toString('utf8');
  if (/-----BEGIN CERTIFICATE-----/.test(text)) {
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (blocks && blocks.length) {
      return blocks.map((value) => new X509Certificate(value).toString());
    }
  }
  if (isPkcs12(data)) {
    return extractP12Certificates(data, candidatePassphrases);
  }
  try {
    return [new X509Certificate(data).toString()];
  } catch {
    return [];
  }
}

function pemCertificates(file: CertificateFile, candidatePassphrases: string[] = []): string[] {
  const data = bytes(file);
  const text = data.toString('utf8');
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text))
    throw new Error('This file contains a private key. Select a certificate-only file.');
  const certs = extractCertificates(file, candidatePassphrases);
  if (!certs.length) {
    throw new Error('Select a valid PEM or DER certificate file.');
  }
  return certs;
}

export function prepareCertificateFile(
  kind: CertificateFileKind,
  file: CertificateFile,
): CertificateFile {
  const data = bytes(file);
  if (kind === 'pfx') {
    if (!isPkcs12(data)) {
      throw new Error('Select a valid PFX or PKCS#12 (.p12, .pfx) file.');
    }
    return file;
  }
  if (kind === 'ca') {
    if (isPkcs12(data)) {
      const extracted = extractCertificates(file, ['']);
      if (extracted.length) {
        return { ...file, data: Buffer.from(extracted.join('\n')).toString('base64') };
      }
      return file;
    }
    return { ...file, data: Buffer.from(pemCertificates(file).join('\n')).toString('base64') };
  }
  if (kind === 'certificate')
    return { ...file, data: Buffer.from(pemCertificates(file).join('\n')).toString('base64') };
  if (kind === 'privateKey' && !/-----BEGIN [^-]*PRIVATE KEY-----/.test(data.toString('utf8')))
    throw new Error('Select a PEM private key file.');
  return file;
}

export interface P12Identity {
  cert: string;
  key?: string;
  ca: string[];
}

/**
 * Extract client certificate, private key, and bundled CA chain from PKCS#12 archives.
 * Uses node-forge to decrypt legacy ciphers (RC2-40, 3DES, AES) that OpenSSL 3 rejects natively.
 */
export function extractP12Identity(
  p12Buf: Buffer,
  candidatePassphrase = '',
): P12Identity | undefined {
  if (!p12Buf.length || p12Buf.length > MAX_CERTIFICATE_BYTES) return;
  const passphrases: (string | undefined)[] = [candidatePassphrase];
  if (candidatePassphrase !== '') passphrases.push('');
  passphrases.push(undefined);
  for (const passphrase of passphrases) {
    try {
      const asn1 = forge.asn1.fromDer(p12Buf.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
      let cert = '';
      let key = '';
      const ca: string[] = [];

      for (const sc of p12.safeContents) {
        for (const sb of sc.safeBags) {
          if (sb.cert) {
            const pem = sb.cert
              ? forge.pki.certificateToPem(sb.cert)
              : Buffer.from(forge.asn1.toDer(sb.asn1).getBytes(), 'binary').toString('utf8');
            if (!cert) {
              cert = pem;
            } else {
              ca.push(pem);
            }
          }
          if (sb.key) {
            key = forge.pki.privateKeyToPem(sb.key);
          }
        }
      }
      if (cert) {
        return { cert, key: key || undefined, ca };
      }
    } catch {
      // Try next candidate passphrase
    }
  }
  return undefined;
}

export function clientOptions(client: ClientCertificate): ConnectionOptions {
  if (client.format === 'pfx') {
    if (!client.pfx) throw new Error('Select a PFX/P12 file.');
    const pfxBuf = bytes(client.pfx);
    const opts: ConnectionOptions = { pfx: pfxBuf, passphrase: client.passphrase || undefined };
    // Modern PFX files are handled natively by Node.js.
    // Legacy PKCS#12 ciphers (e.g. RC2-40 in enterprise banking certs) fail in OpenSSL 3
    // with ERR_CRYPTO_UNSUPPORTED_OPERATION ('Unsupported PKCS12 PFX data').
    // When that occurs, we seamlessly extract PEM credentials using forge.
    try {
      createSecureContext(opts);
      return opts;
    } catch (err: any) {
      if (String(err?.message || '').includes('Unsupported PKCS12 PFX data')) {
        const identity = extractP12Identity(pfxBuf, client.passphrase || '');
        if (identity?.cert && identity?.key) {
          return {
            cert: identity.cert,
            key: identity.key,
            passphrase: client.passphrase || undefined,
          };
        }
      }
      return opts;
    }
  }
  if (!client.certificate || !client.privateKey)
    throw new Error('Select a certificate and private key.');
  return {
    cert: pemCertificates(client.certificate).join('\n'),
    key: bytes(client.privateKey),
    passphrase: client.passphrase || undefined,
  };
}

export function validateClientCertificate(client: ClientCertificate): void {
  const options = clientOptions(client);
  if (client.format === 'pfx') {
    if (!client.pfx) throw new Error('Select a PFX/P12 file.');
    const data = bytes(client.pfx);
    if (!isPkcs12(data)) {
      throw new Error('Select a valid PFX/P12 file.');
    }
    try {
      createSecureContext(options);
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (/INCORRECT_PASSWORD|mac verify failure|bad decrypt/i.test(msg)) {
        if (!client.passphrase) {
          throw new Error(
            'Client certificate could not be loaded: this PFX/P12 certificate requires a passphrase. Please enter the passphrase.',
          );
        }
        throw new Error(
          'Client certificate could not be loaded: incorrect passphrase for this PFX/P12 certificate.',
        );
      }
      if (msg.includes('Unsupported PKCS12 PFX data')) {
        return;
      }
      throw error;
    }
    return;
  }
  try {
    createSecureContext(options);
  } catch (error: any) {
    throw new Error(
      'Client certificate could not be loaded. Check the file format, matching private key and passphrase.',
    );
  }
}

export function systemCACertificates(): string[] {
  if (typeof getCACertificates === 'function') {
    try {
      return getCACertificates('system');
    } catch {
      return [];
    }
  }
  return [];
}

export function defaultCACertificates(): string[] {
  if (typeof getCACertificates === 'function') {
    try {
      return getCACertificates('default');
    } catch {
      return [];
    }
  }
  return [];
}

/** Proxy trust options never contain the destination's client credentials. */
export function certificateTrust(
  settings: Settings,
  requestVerifyTls?: boolean,
  candidatePassphrases: string[] = [],
): ConnectionOptions {
  const rejectUnauthorized =
    requestVerifyTls !== undefined ? requestVerifyTls : settings.verifyTls !== false;
  const options: ConnectionOptions = { rejectUnauthorized };
  if (!rejectUnauthorized) {
    return options;
  }
  const passphrases = [
    '',
    ...candidatePassphrases,
    ...(settings.tls?.clientCertificates || [])
      .map((item) => item.passphrase || '')
      .filter(Boolean),
  ];
  const custom: string[] = [];
  if (settings.tls?.caEnabled && settings.tls.caCertificates?.length) {
    for (const file of settings.tls.caCertificates) {
      try {
        const certs = extractCertificates(file, passphrases);
        for (const cert of certs) {
          if (!custom.includes(cert)) custom.push(cert);
        }
      } catch {
        // Fall back gracefully for individual malformed CA files
      }
    }
  }
  const system = systemCACertificates();
  if (custom.length || system.length) {
    options.ca = [...defaultCACertificates(), ...system, ...custom];
  }
  if (custom.some((pem) => new X509Certificate(pem).ca)) {
    options.allowPartialTrustChain = true;
  }
  return options;
}

export function certificateOptions(
  url: URL,
  settings: Settings,
  requestVerifyTls?: boolean,
): ConnectionOptions {
  if (!['https:', 'wss:'].includes(url.protocol)) return {};
  const host = certificateHost(url.hostname);
  const port = Number(url.port || 443);
  const client = settings.tls?.clientCertificates.find((item) => {
    if (!item.enabled) return false;
    const certPort = Number(item.port || 443);
    if (certPort !== port && certPort !== 0) return false;
    return matchesCertificateHost(item.host, host);
  });
  const passphrases: string[] = [];
  if (client?.passphrase) passphrases.push(client.passphrase);

  const options = certificateTrust(
    settings,
    verifyTlsForUrl(url, settings, requestVerifyTls),
    passphrases,
  );
  if (client) {
    validateClientCertificate(client);
    Object.assign(options, clientOptions(client));

    if (client.verifyServerCertificate === false && requestVerifyTls !== true) {
      options.rejectUnauthorized = false;
    }

    if (client.format === 'pfx' && client.pfx && options.rejectUnauthorized !== false) {
      try {
        const pfxData = bytes(client.pfx);
        // The identity's CA bags apply only to this host/port. Client leaf
        // certificates must never become server trust anchors.
        const chainCerts = extractP12Certificates(pfxData, [client.passphrase || '']).filter(
          (pem) => new X509Certificate(pem).ca,
        );
        if (chainCerts.length) {
          // Enterprise P12 files often omit the root. An explicitly imported
          // issuing CA can anchor the chain while signatures, expiry and the
          // server hostname are still verified by TLS.
          options.allowPartialTrustChain = true;
          const caList = Array.isArray(options.ca) ? options.ca : defaultCACertificates();
          const existing = new Set(caList.map((c) => (typeof c === 'string' ? c.trim() : '')));
          const additional = chainCerts.filter((c) => !existing.has(c.trim()));
          if (additional.length) {
            options.ca = [...caList, ...additional];
          }
        }
      } catch {
        // Fall back gracefully
      }
    }
  }
  return options;
}
