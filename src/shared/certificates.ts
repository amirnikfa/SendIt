import type { Settings } from './models';

/** Exact TLS destination, including a non-default port. WSS shares HTTPS trust. */
export function tlsOrigin(value: string | URL): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'wss:'].includes(url.protocol) || url.hostname.includes('*')) return;
    url.protocol = 'https:';
    return url.origin;
  } catch {
    return;
  }
}

/**
 * Normalizes host strings for matching, stripping schemes, paths, and standard ports.
 */
export function normalizeHostForMatch(value: string): string {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';
  if (/^[a-z]+:\/\//i.test(host)) {
    try {
      const u = new URL(host);
      host = u.hostname;
    } catch {
      host = host.replace(/^[a-z]+:\/\//i, '');
    }
  }
  host = host.split('/')[0].split('?')[0].split('#')[0].trim();
  if (host.includes(':') && !host.startsWith('[') && !host.includes('::')) {
    const parts = host.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
    }
  }
  return host.replace(/\.$/, '');
}

/**
 * Matches a request URL host against a configured certificate host pattern, just like Postman.
 */
export function matchesCertificateHost(pattern: string, requestHost: string): boolean {
  const normRequest = normalizeHostForMatch(requestHost);
  if (!normRequest) return false;
  const patterns = String(pattern || '')
    .split(/[,;\s]+/)
    .map(normalizeHostForMatch)
    .filter(Boolean);
  if (!patterns.length) return false;
  return patterns.some((p) => {
    if (p === '*' || p === normRequest) return true;
    if (p.startsWith('*.')) {
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(normRequest) || normRequest.includes(':')) {
        return false;
      }
      const suffix = p.slice(1);
      return normRequest.endsWith(suffix) && normRequest.length > suffix.length;
    }
    return false;
  });
}

/**
 * Forgiving match for insecureOrigins: supports full origin, bare IP/host, host:port, or wildcard.
 */
export function matchesInsecureOrigin(url: string | URL, insecureOrigins?: string[]): boolean {
  if (!insecureOrigins || !insecureOrigins.length) return false;
  try {
    const origin = tlsOrigin(url);
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const host = parsed.hostname.toLowerCase();
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

    return insecureOrigins.some((exc) => {
      if (!exc) return false;
      const trimmed = exc.trim();
      if (!trimmed) return false;
      if (trimmed === '*') return true;

      // If exc has a scheme (e.g. https://example.com or https://10.0.0.1:8443), treat as exact origin
      if (/^[a-z]+:\/\//i.test(trimmed)) {
        const excOrigin = tlsOrigin(trimmed);
        if (excOrigin && origin && excOrigin.toLowerCase() === origin.toLowerCase()) {
          return true;
        }
        return false;
      }

      // If exc has a port (e.g. 10.0.0.1:443 or example.com:8443)
      if (trimmed.includes(':') && !trimmed.startsWith('[') && !trimmed.includes('::')) {
        const [excHost, excPortStr] = trimmed.split(':');
        const excPort = Number(excPortStr);
        if (excPort && excPort !== port) return false;
        return matchesCertificateHost(excHost, host);
      }

      // Bare hostname or wildcard (e.g. 10.0.0.1 or *.bank.local)
      return matchesCertificateHost(trimmed, host);
    });
  } catch {
    return false;
  }
}

export function verifyTlsForUrl(
  url: string | URL,
  settings: Settings,
  requestVerifyTls?: boolean,
): boolean {
  // 1. Explicit per-request disable always disables SSL
  if (requestVerifyTls === false) return false;

  // 2. Client certificate with verifyServerCertificate: false bypasses server CA for this host
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (['https:', 'wss:'].includes(parsed.protocol)) {
      const host = parsed.hostname;
      const port = Number(parsed.port || 443);
      const client = settings.tls?.clientCertificates?.find((item) => {
        if (!item.enabled) return false;
        const certPort = Number(item.port || 443);
        if (certPort !== port && certPort !== 0) return false;
        return matchesCertificateHost(item.host, host);
      });
      if (client && client.verifyServerCertificate === false && requestVerifyTls !== true) {
        return false;
      }
    }
  } catch {
    // If URL parsing fails, continue
  }

  // 3. SSL verification exceptions (insecureOrigins)
  if (matchesInsecureOrigin(url, settings.tls?.insecureOrigins) && requestVerifyTls !== true) {
    return false;
  }

  // 4. Global setting verifyTls: false
  if (settings.verifyTls === false && requestVerifyTls !== true) {
    return false;
  }

  // 5. Per-request explicit override
  if (requestVerifyTls !== undefined) return requestVerifyTls;

  // 6. Default to settings or true
  return settings.verifyTls !== false;
}

/**
 * Canonical hostname for certificates.
 * Just like Postman:
 * - Supports exact domains and IP addresses (e.g. echo.getpostman.com, [::1]).
 * - Supports wildcard domains (e.g. *.example.com or *).
 * - Forgiving if user pastes URLs or includes protocols (e.g. https://api.example.com/...).
 */
function cleanSingleHost(value: string): string {
  let host = String(value || '').trim();
  if (!host) return '';
  if (/^https?:\/\//i.test(host)) {
    try {
      const parsed = new URL(host);
      host = parsed.hostname;
    } catch {
      host = host.replace(/^https?:\/\//i, '');
    }
  }
  host = host.split('/')[0].split('?')[0].split('#')[0].trim();
  if (host.includes(':') && !host.startsWith('[') && !host.includes('::')) {
    const parts = host.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      host = parts[0];
    }
  }
  if (host === '*') return '*';
  if (host.startsWith('*.')) {
    const base = host.slice(2).trim().toLowerCase().replace(/\.$/, '');
    if (!base || /[\s/]/.test(base)) throw new Error('Enter a valid wildcard domain.');
    return '*.' + base;
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.toLowerCase();
  }
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host.toLowerCase()}]`;
  }
  const cleaned = host.toLowerCase().replace(/\.$/, '');
  if (!cleaned || /[\s/]/.test(cleaned)) throw new Error('Enter a valid hostname.');
  return cleaned;
}

export function certificateHost(value: string): string {
  const parts = String(value || '')
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length)
    throw new Error(
      'Enter a hostname or wildcard domain (e.g. echo.getpostman.com, *.example.com, or *).',
    );
  return parts.map(cleanSingleHost).join(', ');
}
