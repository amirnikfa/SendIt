import { X509Certificate } from 'node:crypto';
import { createSecureContext, getCACertificates, type ConnectionOptions } from 'node:tls';
import type {
  CertificateFile,
  CertificateFileKind,
  ClientCertificate,
  Settings,
} from '../shared/models';
import { certificateHost, matchesCertificateHost } from '../shared/certificates';

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

function pemCertificates(file: CertificateFile): string[] {
  const data = bytes(file);
  const text = data.toString('utf8');
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text))
    throw new Error('This file contains a private key. Select a certificate-only file.');
  try {
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    return (blocks || [data]).map((value) => new X509Certificate(value).toString());
  } catch {
    throw new Error('Select a valid PEM or DER certificate file.');
  }
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
  if (kind === 'ca' || kind === 'certificate')
    return { ...file, data: Buffer.from(pemCertificates(file).join('\n')).toString('base64') };
  if (kind === 'privateKey' && !/-----BEGIN [^-]*PRIVATE KEY-----/.test(data.toString('utf8')))
    throw new Error('Select a PEM private key file.');
  return file;
}

function clientOptions(client: ClientCertificate): ConnectionOptions {
  if (client.format === 'pfx') {
    if (!client.pfx) throw new Error('Select a PFX/P12 file.');
    return { pfx: bytes(client.pfx), passphrase: client.passphrase || undefined };
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
): ConnectionOptions {
  const rejectUnauthorized =
    requestVerifyTls !== undefined ? requestVerifyTls : settings.verifyTls !== false;
  const options: ConnectionOptions = { rejectUnauthorized };
  const custom: string[] =
    settings.tls?.caEnabled && settings.tls.caCertificates.length
      ? settings.tls.caCertificates.flatMap(pemCertificates)
      : [];
  const system = systemCACertificates();
  if (custom.length || system.length) {
    options.ca = [...defaultCACertificates(), ...system, ...custom];
  }
  return options;
}

export function certificateOptions(
  url: URL,
  settings: Settings,
  requestVerifyTls?: boolean,
): ConnectionOptions {
  if (!['https:', 'wss:'].includes(url.protocol)) return {};
  const options = certificateTrust(settings, requestVerifyTls);
  const host = certificateHost(url.hostname);
  const port = Number(url.port || 443);
  const client = settings.tls?.clientCertificates.find((item) => {
    if (!item.enabled) return false;
    const certPort = Number(item.port || 443);
    if (certPort !== port && certPort !== 0) return false;
    return matchesCertificateHost(item.host, host);
  });
  if (client) {
    validateClientCertificate(client);
    Object.assign(options, clientOptions(client));
  }
  return options;
}
