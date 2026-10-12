/** Canonical exact hostname; certificates never match URLs, wildcard domains or other ports. */
export function certificateHost(value: string): string {
  const host = value.trim();
  if (!host || /[\s/\\?#@*]/.test(host))
    throw new Error('Enter an exact hostname without a URL, path or wildcard.');
  try {
    if (host.startsWith('[') && !/^\[[^\]]+\]$/.test(host)) throw new Error();
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const parsed = new URL(`https://${address}`);
    if (parsed.port || parsed.pathname !== '/' || parsed.username || parsed.password)
      throw new Error();
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    throw new Error('Enter a valid hostname or IP address; put the port in the Port field.');
  }
}
