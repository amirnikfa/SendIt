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

/**
 * Matches a request URL host against a configured certificate host pattern, just like Postman.
 */
export function matchesCertificateHost(pattern: string, requestHost: string): boolean {
  const normRequest = String(requestHost || '')
    .trim()
    .toLowerCase();
  const patterns = String(pattern || '')
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!patterns.length) return false;
  return patterns.some((p) => {
    if (p === '*' || p === normRequest) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return normRequest.endsWith(suffix) && normRequest.length > suffix.length;
    }
    return false;
  });
}
