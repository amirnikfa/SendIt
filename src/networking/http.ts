import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';
import type {
  ApiRequest,
  ApiResponse,
  Auth,
  CookieRecord,
  ExecutionInput,
  ExecutionResult,
  Pair,
  Settings,
} from '../shared/models';
import { interpolate, redact, resolveObject, variableMap } from '../services/variables';
import { runScript, type ScriptState } from '../services/scripts';
import { certificateOptions, certificateTrust } from './certificates';

const MAX_BYTES = 50 * 1024 * 1024;
const row = (key: string, value: string): Pair => ({ id: randomUUID(), key, value, enabled: true });
type WireResponse = {
  status: number;
  statusText: string;
  headers: Pair[];
  bytes: Buffer;
  url: string;
};
type Headers = Array<[string, string]>;
const getHeader = (headers: Headers, key: string) =>
  headers.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
const removeHeader = (headers: Headers, key: string) =>
  headers.filter(([name]) => name.toLowerCase() !== key.toLowerCase());
const setHeader = (headers: Headers, key: string, value: string): Headers => [
  ...removeHeader(headers, key),
  [key, value],
];
const responseHeader = (response: WireResponse, key: string) =>
  response.headers.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value;

function activeAuth(auth: Auth): Auth {
  switch (auth.type) {
    case 'basic':
    case 'digest':
      return { type: auth.type, username: auth.username, password: auth.password };
    case 'bearer':
    case 'oauth2':
      return { type: auth.type, token: auth.token };
    case 'apikey':
      return { type: auth.type, key: auth.key, value: auth.value, addTo: auth.addTo };
    default:
      return { type: 'none' };
  }
}
const timeout = (settings: Settings) =>
  Math.max(1, Math.min(600000, Number(settings.timeoutMs) || 30000));

function validateUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Enter a complete HTTP or HTTPS URL, including http:// or https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password)
    throw new Error('Put URL credentials in the Authorization tab instead of the URL.');
  url.hash = '';
  return url;
}

function digestHeader(
  challenge: string,
  auth: Auth,
  method: string,
  url: URL,
  body: Buffer,
): string {
  if (!/^Digest\s/i.test(challenge))
    throw new Error('The server did not offer Digest authentication.');
  const values: Record<string, string> = Object.create(null);
  for (const match of challenge
    .slice(7)
    .matchAll(/([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g))
    values[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
  const algorithm = (values.algorithm || 'MD5').toUpperCase();
  const hashType =
    algorithm.replace(/-SESS$/, '') === 'SHA-512-256'
      ? 'sha512-256'
      : algorithm
          .replace(/-SESS$/, '')
          .replace('-', '')
          .toLowerCase();
  if (!['md5', 'sha256', 'sha512-256'].includes(hashType))
    throw new Error(`Unsupported Digest algorithm: ${algorithm}`);
  if (!values.nonce || values.realm === undefined)
    throw new Error('Invalid Digest authentication challenge.');
  const hash = (value: string | Buffer) => createHash(hashType).update(value).digest('hex');
  const cnonce = randomBytes(16).toString('hex');
  const nc = '00000001';
  const choices = (values.qop || '').split(',').map((q) => q.trim());
  const qop = choices.includes('auth') ? 'auth' : choices.includes('auth-int') ? 'auth-int' : '';
  if (values.qop && !qop) throw new Error('Unsupported Digest quality of protection.');
  const uri = url.pathname + url.search;
  let a1 = hash(`${auth.username || ''}:${values.realm}:${auth.password || ''}`);
  if (algorithm.endsWith('-SESS')) a1 = hash(`${a1}:${values.nonce}:${cnonce}`);
  const a2 = hash(`${method}:${uri}${qop === 'auth-int' ? ':' + hash(body) : ''}`);
  const response = qop
    ? hash(`${a1}:${values.nonce}:${nc}:${cnonce}:${qop}:${a2}`)
    : hash(`${a1}:${values.nonce}:${a2}`);
  const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;
  const parts = [
    `username=${quote(auth.username || '')}`,
    `realm=${quote(values.realm)}`,
    `nonce=${quote(values.nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
    `algorithm=${algorithm}`,
  ];
  if (values.opaque) parts.push(`opaque=${quote(values.opaque)}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  else if (algorithm.endsWith('-SESS')) parts.push(`cnonce=${quote(cnonce)}`);
  return `Digest ${parts.join(', ')}`;
}

export class HttpEngine {
  private jar = new CookieJar();
  constructor(private readonly authorizeFile: (path: string) => boolean = () => false) {}

  serializeCookies(): string {
    return JSON.stringify(this.jar.serializeSync());
  }
  loadCookies(serialized: string): void {
    this.jar = CookieJar.deserializeSync(serialized);
  }
  async cookies(): Promise<CookieRecord[]> {
    const data = await this.jar.serialize();
    return (data.cookies || []).map((cookie) => ({
      domain: String(cookie.domain || ''),
      path: String(cookie.path || '/'),
      key: cookie.key || '',
      value: cookie.value || '',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      expires: typeof cookie.expires === 'string' ? cookie.expires : undefined,
    }));
  }
  async setCookie(url: string, cookie: string): Promise<void> {
    await this.jar.setCookie(cookie, validateUrl(url).href);
  }
  async deleteCookie(domain: string, path: string, key: string): Promise<void> {
    await this.jar.store.removeCookie(domain, path, key);
  }

  private async file(path: string | undefined): Promise<Buffer> {
    if (!path || !this.authorizeFile(path))
      throw new Error(
        'Select this upload file using the file picker before sending. Imported file paths do not grant file access.',
      );
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Upload path must be a file.');
    if (info.size > MAX_BYTES) throw new Error('Upload files are limited to 50 MB.');
    return readFile(path);
  }

  private async body(request: ApiRequest): Promise<{ bytes: Buffer; contentType?: string }> {
    const body = request.body;
    switch (body.mode) {
      case 'none':
        return { bytes: Buffer.alloc(0) };
      case 'raw':
        return {
          bytes: Buffer.from(body.raw),
          contentType: {
            json: 'application/json',
            xml: 'application/xml',
            html: 'text/html',
            javascript: 'application/javascript',
            text: 'text/plain',
          }[body.language],
        };
      case 'urlencoded': {
        const params = new URLSearchParams();
        for (const field of body.fields)
          if (field.enabled && field.key) params.append(field.key, field.value);
        return {
          bytes: Buffer.from(params.toString()),
          contentType: 'application/x-www-form-urlencoded',
        };
      }
      case 'graphql': {
        let variables: unknown;
        try {
          variables = JSON.parse(body.graphqlVariables || '{}');
        } catch {
          throw new Error('GraphQL variables must be valid JSON.');
        }
        if (!variables || typeof variables !== 'object' || Array.isArray(variables))
          throw new Error('GraphQL variables must be a JSON object.');
        return {
          bytes: Buffer.from(JSON.stringify({ query: body.graphqlQuery || '', variables })),
          contentType: 'application/json',
        };
      }
      case 'binary':
        return { bytes: await this.file(body.filePath), contentType: 'application/octet-stream' };
      case 'form-data': {
        const boundary = '----SendIt' + randomBytes(16).toString('hex');
        const buffers: Buffer[] = [];
        let total = 0;
        const add = (data: string | Buffer) => {
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          total += bytes.length;
          if (total > MAX_BYTES) throw new Error('Multipart body exceeds 50 MB.');
          buffers.push(bytes);
        };
        const escape = (value: string) => value.replace(/\r|\n/g, '').replace(/"/g, '%22');
        for (const field of body.fields) {
          if (!field.enabled || !field.key) continue;
          add(`--${boundary}\r\nContent-Disposition: form-data; name="${escape(field.key)}"`);
          if (field.type === 'file') {
            add(
              `; filename="${escape(basename(field.filePath || 'file'))}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            );
            add(await this.file(field.filePath));
          } else {
            add('\r\n\r\n');
            add(field.value);
          }
          add('\r\n');
        }
        add(`--${boundary}--\r\n`);
        return {
          bytes: Buffer.concat(buffers),
          contentType: `multipart/form-data; boundary=${boundary}`,
        };
      }
    }
  }

  private async send(
    url: URL,
    method: string,
    headers: Headers,
    body: Buffer,
    settings: Settings,
    signal: AbortSignal,
    requestVerifyTls?: boolean,
  ): Promise<WireResponse> {
    const limit = Math.min(50, Math.max(1, Number(settings.maxResponseMb) || 50)) * 1024 * 1024;
    const proxy = settings.proxyUrl.trim();
    if (proxy) {
      const parsed = new URL(proxy);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Proxy must use http:// or https://.');
    }
    const agent = proxy
      ? url.protocol === 'https:'
        ? new HttpsProxyAgent(proxy, certificateTrust(settings, requestVerifyTls))
        : new HttpProxyAgent(proxy, certificateTrust(settings, requestVerifyTls))
      : undefined;
    const cookie = await this.jar.getCookieString(url.href);
    if (cookie && !getHeader(headers, 'cookie')) headers = [...headers, ['Cookie', cookie]];
    // Object values containing arrays retain duplicate wire headers and remain compatible
    // with proxy agents, which inspect ClientRequest.getHeader() before connecting.
    const outgoing: http.OutgoingHttpHeaders = Object.create(null);
    for (const [name, value] of headers) {
      const key = name.toLowerCase();
      const previous = outgoing[key];
      outgoing[key] =
        previous === undefined
          ? value
          : Array.isArray(previous)
            ? [...previous, value]
            : [String(previous), value];
    }
    return new Promise<WireResponse>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(
        url,
        {
          method,
          headers: outgoing,
          agent,
          ...certificateOptions(url, settings, requestVerifyTls),
          signal,
        },
        (response) => {
          const rows: Pair[] = [];
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            rows.push(row(response.rawHeaders[i], response.rawHeaders[i + 1]));
          this.collect(response, limit, method)
            .then(async (bytes) => {
              for (const cookie of response.headers['set-cookie'] || []) {
                try {
                  await this.jar.setCookie(cookie, url.href);
                } catch {
                  /* Invalid server cookies are ignored per cookie policy. */
                }
              }
              resolve({
                status: response.statusCode || 0,
                statusText: response.statusMessage || '',
                headers: rows,
                bytes,
                url: url.href,
              });
            })
            .catch((error) => {
              response.destroy();
              request.destroy();
              reject(error);
            });
        },
      );
      request.on('error', reject);
      request.end(body.length ? body : undefined);
    });
  }

  private async collect(response: IncomingMessage, limit: number, method: string): Promise<Buffer> {
    let stream: Readable = response;
    const encoding =
      method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304
        ? undefined
        : response.headers['content-encoding']?.toLowerCase().trim();
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip());
    else if (encoding === 'deflate') stream = response.pipe(createInflate());
    else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
    response.on('aborted', () =>
      stream.destroy(new Error('The server closed the connection before the response completed.')),
    );
    response.on('error', (error) => stream.destroy(error));
    const buffers: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > limit) {
        stream.destroy();
        throw new Error(
          `Response exceeds the configured ${Math.round(limit / 1024 / 1024)} MB limit.`,
        );
      }
      buffers.push(bytes);
    }
    return Buffer.concat(buffers);
  }

  async oauth(auth: Auth, settings: Settings): Promise<{ token: string; refreshToken?: string }> {
    const url = validateUrl(auth.tokenUrl || '');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error(
        'OAuth token endpoints must use HTTPS (loopback HTTP is allowed for local development).',
      );
    const grantType = auth.grantType || 'client_credentials';
    if (grantType === 'refresh_token' && !auth.refreshToken)
      throw new Error('A refresh token is required.');
    const body = new URLSearchParams({ grant_type: grantType });
    if (auth.scope) body.set('scope', auth.scope);
    if (grantType === 'refresh_token') body.set('refresh_token', auth.refreshToken || '');
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    const headers: Headers = [
      ['Content-Type', 'application/x-www-form-urlencoded'],
      ['Accept', 'application/json'],
      ['Host', url.host],
    ];
    if (auth.clientId)
      headers.push([
        'Authorization',
        'Basic ' +
          Buffer.from(`${encode(auth.clientId)}:${encode(auth.clientSecret || '')}`).toString(
            'base64',
          ),
      ]);
    const bytes = Buffer.from(body.toString());
    headers.push(['Content-Length', String(bytes.length)]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout(settings));
    try {
      const response = await this.send(
        url,
        'POST',
        headers,
        bytes,
        { ...settings, maxResponseMb: 1 },
        controller.signal,
      );
      let value: {
        access_token?: string;
        refresh_token?: string;
        error?: string;
        token_type?: string;
      };
      try {
        value = JSON.parse(response.bytes.toString('utf8'));
      } catch {
        throw new Error(`Token endpoint returned HTTP ${response.status} with invalid JSON.`);
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        typeof value.access_token !== 'string' ||
        !value.access_token
      )
        throw new Error(
          `OAuth token request failed (HTTP ${response.status}${value.error ? ', ' + String(value.error).slice(0, 80) : ''}).`,
        );
      if (value.token_type && value.token_type.toLowerCase() !== 'bearer')
        throw new Error(`Unsupported OAuth token type: ${value.token_type}`);
      return { token: value.access_token, refreshToken: value.refresh_token };
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(input: ExecutionInput, signal?: AbortSignal): Promise<ExecutionResult> {
    const started = performance.now();
    let state: ScriptState = structuredClone({
      globals: input.globals,
      environment: input.environment,
      collectionVariables: input.collectionVariables,
      variables: input.request.variables,
    });
    const response: ApiResponse = {
      status: 0,
      statusText: '',
      duration: 0,
      size: 0,
      headers: [],
      cookies: [],
      body: '',
      base64: '',
      contentType: '',
      url: '',
      tests: [],
      logs: [],
    };
    const secrets = [
      ...input.globals,
      ...input.environment,
      ...input.collectionVariables,
      ...input.request.variables,
    ]
      .filter((value) => value.secret || /password|secret|token|api[-_]?key/i.test(value.key))
      .map((value) => value.value);
    for (const auth of [input.request.auth, input.inheritedAuth].filter(
      (auth): auth is Auth => !!auth,
    )) {
      secrets.push(
        ...[auth.token, auth.password, auth.value, auth.clientSecret, auth.refreshToken].filter(
          (value): value is string => !!value,
        ),
      );
      if (auth.username || auth.password)
        secrets.push(
          Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64'),
        );
    }
    for (const header of input.request.headers)
      if (header.secret || /authorization|cookie|api[-_]?key|token|secret/i.test(header.key))
        secrets.push(header.value);
    let scriptTime = 0;
    const scriptBudget = async (
      source: string,
      scriptState: ScriptState,
      scriptResponse?: ApiResponse,
    ) => {
      if (!source.trim()) return { ...scriptState, tests: [], logs: [] };
      const remaining = Math.floor(2000 - scriptTime);
      if (remaining <= 0)
        return {
          ...scriptState,
          tests: [],
          logs: [],
          error: 'Combined script execution exceeds 2000 ms budget.',
        };
      const before = performance.now();
      try {
        return await runScript(source, scriptState, scriptResponse, Math.min(500, remaining));
      } finally {
        scriptTime += performance.now() - before;
      }
    };
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Request cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout(input.settings));
    try {
      for (const script of [...(input.preScripts || []), input.request.preScript]) {
        const result = await scriptBudget(script, state);
        response.tests.push(...result.tests);
        response.logs.push(...result.logs);
        if (result.error) throw new Error('Pre-request script: ' + result.error);
        state = result;
      }
      const values = variableMap(
        state.globals,
        state.collectionVariables,
        state.environment,
        state.variables,
      );
      // Resolve executable fields only: descriptions and scripts can legitimately contain example placeholders.
      const original = input.request;
      const auth = resolveObject(
        activeAuth(
          original.auth.type === 'inherit'
            ? input.inheritedAuth || ({ type: 'none' } as Auth)
            : original.auth,
        ),
        values,
      );
      const resolveRows = (rows: Pair[]) =>
        rows
          .filter((row) => row.enabled && row.key)
          .map((row) => ({
            ...row,
            key: interpolate(row.key, values),
            value: interpolate(row.value, values),
          }));
      const request: ApiRequest = {
        ...original,
        url: interpolate(
          original.params.length ? original.url.split('?')[0] : original.url,
          values,
        ),
        method: interpolate(original.method, values).toUpperCase(),
        params: resolveRows(original.params),
        headers: resolveRows(original.headers),
        body: {
          ...original.body,
          fields: ['form-data', 'urlencoded'].includes(original.body.mode)
            ? resolveRows(original.body.fields)
            : [],
          raw:
            original.body.mode === 'raw'
              ? interpolate(original.body.raw, values)
              : original.body.raw,
          graphqlQuery:
            original.body.mode === 'graphql'
              ? interpolate(original.body.graphqlQuery || '', values)
              : original.body.graphqlQuery,
          graphqlVariables:
            original.body.mode === 'graphql'
              ? interpolate(original.body.graphqlVariables || '{}', values)
              : original.body.graphqlVariables,
        },
        auth,
      };
      secrets.push(
        ...[auth.token, auth.password, auth.value, auth.clientSecret, auth.refreshToken].filter(
          (value): value is string => !!value,
        ),
      );
      for (const h of request.headers)
        if (/authorization|cookie|api[-_]?key|token|secret/i.test(h.key)) secrets.push(h.value);
      let url = validateUrl(request.url);
      if (original.params.length) {
        url.search = '';
        for (const param of request.params)
          if (param.key) url.searchParams.append(param.key, param.value);
      }
      let method = request.method;
      if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method))
        throw new Error('HTTP method contains invalid characters.');
      let headers: Headers = request.headers
        .filter((header) => header.key)
        .map((header) => [header.key, header.value]);
      for (const [key, value] of headers) {
        http.validateHeaderName(key);
        http.validateHeaderValue(key, value);
      }
      if (!getHeader(headers, 'accept')) headers.push(['Accept', '*/*']);
      if (!getHeader(headers, 'user-agent')) headers.push(['User-Agent', 'SendIt/1.0']);
      if (!getHeader(headers, 'accept-encoding'))
        headers.push(['Accept-Encoding', 'gzip, deflate, br']);
      const body = await this.body(request);
      let bytes = body.bytes;
      if (bytes.length > MAX_BYTES) throw new Error('Request body exceeds 50 MB.');
      if (body.contentType && !getHeader(headers, 'content-type'))
        headers.push(['Content-Type', body.contentType]);
      // A correct boundary is mandatory; use the actual generated boundary even if a bare multipart header was imported.
      if (request.body.mode === 'form-data')
        headers = setHeader(headers, 'Content-Type', body.contentType!);
      headers = removeHeader(headers, 'transfer-encoding');
      headers = removeHeader(headers, 'content-length');
      if (request.body.mode !== 'none') headers.push(['Content-Length', String(bytes.length)]);
      if (auth.type === 'basic')
        headers = setHeader(
          headers,
          'Authorization',
          'Basic ' +
            Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64'),
        );
      if (auth.type === 'bearer' || auth.type === 'oauth2') {
        if (!auth.token) throw new Error('Enter an access token or acquire an OAuth token first.');
        headers = setHeader(headers, 'Authorization', 'Bearer ' + auth.token);
      }
      if (auth.type === 'apikey') {
        if (!auth.key) throw new Error('Enter an API key name.');
        if (auth.addTo === 'query') url.searchParams.set(auth.key, auth.value || '');
        else headers = setHeader(headers, auth.key, auth.value || '');
      }
      const authOrigin = url.origin;
      let digestAttempted = false;
      let redirectCount = 0;
      let wire: WireResponse;
      while (true) {
        if (controller.signal.aborted) throw new Error('Request cancelled.');
        // Keep the current destination's Host when following redirects.
        const wireHeaders = getHeader(headers, 'host')
          ? headers
          : [...headers, ['Host', url.host] as [string, string]];
        wire = await this.send(
          url,
          method,
          wireHeaders,
          bytes,
          input.settings,
          controller.signal,
          request.verifyTls,
        );
        if (
          wire.status === 401 &&
          auth.type === 'digest' &&
          !digestAttempted &&
          url.origin === authOrigin
        ) {
          const challenge = wire.headers.find(
            (h) => h.key.toLowerCase() === 'www-authenticate' && /^Digest /i.test(h.value),
          )?.value;
          if (challenge) {
            headers = setHeader(
              headers,
              'Authorization',
              digestHeader(challenge, auth, method, url, bytes),
            );
            digestAttempted = true;
            continue;
          }
        }
        const location = responseHeader(wire, 'location');
        if (
          ![301, 302, 303, 307, 308].includes(wire.status) ||
          !location ||
          !input.settings.followRedirects
        )
          break;
        if (++redirectCount > 10) throw new Error('Too many redirects (maximum 10).');
        const next = validateUrl(new URL(location, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new Error(
            'Refused an HTTPS-to-HTTP redirect. Send the HTTP URL explicitly if intended.',
          );
        if (next.origin !== url.origin) {
          headers = headers.filter(
            ([key]) =>
              !/^(authorization|proxy-authorization|cookie|host)$/i.test(key) &&
              !/api[-_]?key|token|secret/i.test(key) &&
              !(auth.type === 'apikey' && key.toLowerCase() === auth.key?.toLowerCase()),
          );
          if (auth.type === 'apikey' && auth.addTo === 'query' && auth.key)
            next.searchParams.delete(auth.key);
        }
        if (
          (wire.status === 303 && method !== 'HEAD') ||
          ([301, 302].includes(wire.status) && method === 'POST')
        ) {
          method = 'GET';
          bytes = Buffer.alloc(0);
          headers = removeHeader(removeHeader(headers, 'content-type'), 'content-length');
        }
        if (auth.type === 'digest' && next.origin === authOrigin) {
          headers = removeHeader(headers, 'authorization');
          digestAttempted = false;
        }
        url = next;
        response.logs.push(`Followed redirect ${wire.status} (${redirectCount}/10).`);
      }
      response.status = wire.status;
      response.statusText = wire.statusText;
      response.headers = wire.headers;
      response.cookies = wire.headers
        .filter((header) => header.key.toLowerCase() === 'set-cookie')
        .map((header) => header.value);
      response.size = wire.bytes.length;
      response.base64 = wire.bytes.toString('base64');
      response.contentType = responseHeader(wire, 'content-type') || 'application/octet-stream';
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.contentType)?.[1] || 'utf-8';
      try {
        response.body = new TextDecoder(charset).decode(wire.bytes);
      } catch {
        response.body = wire.bytes.toString('utf8');
      }
      response.url = wire.url;
      response.duration = Math.round((performance.now() - started) * 10) / 10;
      for (const script of [...(input.postScripts || []), original.postScript]) {
        const result = await scriptBudget(script, state, response);
        response.tests.push(...result.tests);
        response.logs.push(...result.logs);
        if (result.error) {
          response.tests.push({ name: 'Post-response script', passed: false, error: result.error });
          if (scriptTime >= 2000) break;
        } else state = result;
      }
    } catch (error) {
      const source = error as Error & { code?: string };
      response.error = timedOut
        ? `Request timed out after ${input.settings.timeoutMs || 30000} ms.`
        : controller.signal.aborted
          ? 'Request cancelled.'
          : `${source.code ? source.code + ': ' : ''}${source.message || String(error)}`;
      response.logs.push(response.error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      response.duration = Math.round((performance.now() - started) * 10) / 10;
      secrets.push(
        ...[
          ...state.globals,
          ...state.environment,
          ...state.collectionVariables,
          ...state.variables,
        ]
          .filter((value) => value.secret || /password|secret|token|api[-_]?key/i.test(value.key))
          .map((value) => value.value),
      );
      response.logs = response.logs.map((line) => redact(line, secrets));
      response.tests = response.tests.map((test) => ({
        ...test,
        name: redact(test.name, secrets),
        error: test.error ? redact(test.error, secrets) : undefined,
      }));
      if (response.error) response.error = redact(response.error, secrets);
    }
    return {
      response,
      globals: state.globals,
      environment: state.environment,
      collectionVariables: state.collectionVariables,
    };
  }
}
