import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpEngine } from '../src/networking/http';
import { defaultSettings, newRequest, pair, type ExecutionInput } from '../src/shared/models';

let server: Server;
let other: Server;
let proxy: Server;
let tls: Server;
let base = '';
let otherBase = '';
let proxyBase = '';
let tlsBase = '';
let temp = '';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const sockets = new WeakMap<Server, Set<net.Socket>>();
const listen = (s: Server) =>
  new Promise<string>((resolve) => {
    const tracked = new Set<net.Socket>();
    sockets.set(s, tracked);
    s.on('connection', (socket) => {
      tracked.add(socket);
      socket.on('close', () => tracked.delete(socket));
    });
    s.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`),
    );
  });
const close = (s: Server) =>
  new Promise<void>((resolve) => {
    for (const socket of sockets.get(s) || []) socket.destroy();
    s.closeAllConnections();
    s.close(() => resolve());
  });
function input(path = '/echo'): ExecutionInput {
  return {
    request: { ...newRequest(), url: base + path },
    settings: { ...defaultSettings },
    globals: [],
    environment: [],
    collectionVariables: [],
  };
}

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'sendit-tests-'));
  other = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers, url: req.url }));
  });
  otherBase = await listen(other);
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const path = new URL(req.url || '/', base || 'http://localhost').pathname;
    if (path === '/slow') {
      const timer = setTimeout(() => res.end('late'), 1000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/echo' });
      res.end();
      return;
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (path === '/other') {
      res.writeHead(302, { location: otherBase + '/echo' });
      res.end();
      return;
    }
    if (path === '/other-query') {
      res.writeHead(302, { location: otherBase + '/echo' + new URL(req.url || '/', base).search });
      res.end();
      return;
    }
    if (path === '/gzip' || path === '/brotli') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', path === '/gzip' ? 'gzip' : 'br');
      res.end(
        (path === '/gzip' ? gzipSync : brotliCompressSync)(Buffer.from('{"compressed":true}')),
      );
      return;
    }
    if (path === '/large') {
      res.end(Buffer.alloc(2 * 1024 * 1024, 'x'));
      return;
    }
    if (path === '/binary') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.from([0, 255, 128, 1, 2]));
      return;
    }
    if (path === '/cookies') {
      res.setHeader('set-cookie', ['session=abc; Path=/; HttpOnly', 'flag=yes; Path=/']);
    }
    if (path === '/digest') {
      const header = req.headers.authorization || '';
      if (!header.startsWith('Digest ')) {
        res.writeHead(401, {
          'www-authenticate':
            'Digest realm="fixture", nonce="test-nonce", qop="auth", algorithm=MD5',
        });
        res.end();
        return;
      }
      const fields: Record<string, string> = {};
      for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g)) fields[m[1]] = m[2] ?? m[3];
      const expected = md5(
        `${md5('alice:fixture:secret')}:test-nonce:${fields.nc}:${fields.cnonce}:auth:${md5(`${req.method}:/digest`)}`,
      );
      if (fields.response !== expected) {
        res.writeHead(403);
        res.end('digest verification failed');
        return;
      }
    }
    if (path === '/token') {
      res.setHeader('content-type', 'application/json');
      const params = new URLSearchParams(bytes.toString());
      if (
        req.headers.authorization !== 'Basic ' + Buffer.from('client:secret').toString('base64') ||
        !['client_credentials', 'refresh_token'].includes(params.get('grant_type') || '')
      ) {
        res.writeHead(401);
        res.end('{"error":"invalid_client"}');
      } else
        res.end(
          '{"access_token":"fixture-access","token_type":"Bearer","refresh_token":"fixture-refresh"}',
        );
      return;
    }
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('x-response', 'fixture');
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: bytes.toString(),
        bodyBase64: bytes.toString('base64'),
      }),
    );
  });
  base = await listen(server);
  proxy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ proxyUrl: req.url }));
  });
  proxy.on('connect', (req, socket, head) => {
    const [host, port] = (req.url || '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  proxyBase = await listen(proxy);
  tls = https.createServer(
    {
      key: await readFile('tests/fixtures/localhost-key.pem'),
      cert: await readFile('tests/fixtures/localhost-cert.pem'),
    },
    (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"tls":true}');
    },
  );
  tlsBase = (await listen(tls)).replace('http:', 'https:');
});
afterAll(async () => {
  await close(server);
  await close(other);
  await close(tls);
  await close(proxy);
  await rm(temp, { recursive: true, force: true });
});

describe('real desktop HTTP transport', () => {
  it('sends a real GET and retains a raw URL query when no parameter rows exist', async () => {
    const result = await new HttpEngine().execute(input('/echo?a=hello%20world&a=2'));
    expect(result.response.error).toBeUndefined();
    expect(result.response.status).toBe(200);
    expect(JSON.parse(result.response.body).url).toBe('/echo?a=hello%20world&a=2');
    expect(result.response.duration).toBeGreaterThanOrEqual(0);
    expect(result.response.size).toBe(Buffer.byteLength(result.response.body));
  });
  it('sends JSON, duplicate headers, enabled query params and Bearer authentication', async () => {
    const data = input('/echo?obsolete=1');
    Object.assign(data.request, {
      method: 'POST',
      params: [
        pair('q', 'hello & there'),
        pair('q', 'two'),
        { ...pair('disabled', 'x'), enabled: false },
      ],
      headers: [pair('X-Custom', 'one'), pair('X-Custom', 'two')],
      auth: { type: 'bearer', token: 'token-123' },
    });
    data.request.body = { ...data.request.body, mode: 'raw', raw: '{"real":true}' };
    const result = await new HttpEngine().execute(data);
    const sent = JSON.parse(result.response.body);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/echo?q=hello+%26+there&q=two');
    expect(sent.headers['x-custom']).toBe('one, two');
    expect(sent.headers.authorization).toBe('Bearer token-123');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body).toBe('{"real":true}');
  });
  it('resolves variable scope precedence and applies pre/post scripts', async () => {
    const data = input();
    data.request.url = '{{base}}/echo';
    data.globals = [pair('base', 'http://invalid')];
    data.collectionVariables = [pair('base', 'http://also-invalid')];
    data.environment = [pair('base', base)];
    data.request.preScript =
      'pm.environment.set("created", "before"); pm.variables.set("q", "from-script");';
    data.request.params = [pair('q', '{{q}}')];
    data.request.postScript =
      'pm.test("status", () => pm.response.to.have.status(200)); pm.test("query", () => pm.expect(pm.response.json().url).to.include("from-script")); pm.environment.set("next", "after");';
    const result = await new HttpEngine().execute(data);
    expect(result.response.error).toBeUndefined();
    expect(result.response.tests.map((test) => test.passed)).toEqual([true, true]);
    expect(result.environment.find((v) => v.key === 'created')?.value).toBe('before');
    expect(result.environment.find((v) => v.key === 'next')?.value).toBe('after');
  });
  it('reports unresolved variables and pre-script failures before any network send', async () => {
    const data = input();
    data.request.url = '{{missing}}';
    expect((await new HttpEngine().execute(data)).response.error).toContain('Unresolved variable');
    data.request.preScript = 'throw new Error("bad setup")';
    expect((await new HttpEngine().execute(data)).response.error).toContain(
      'Pre-request script: bad setup',
    );
  });
  it('removes disabled parameters even if all rows are disabled', async () => {
    const data = input('/echo?a={{unresolved}}');
    data.request.params = [{ ...pair('a', '{{unresolved}}'), enabled: false }];
    expect(JSON.parse((await new HttpEngine().execute(data)).response.body).url).toBe('/echo');
  });
  it('ignores inactive auth fields and non-executable descriptions', async () => {
    const data = input();
    data.request.auth = { type: 'none', token: '{{not_used}}' };
    data.request.headers = [{ ...pair('X-Test', 'ok'), description: '{{example_placeholder}}' }];
    expect((await new HttpEngine().execute(data)).response.status).toBe(200);
  });
  it('supports Basic, API key and independently verified Digest auth', async () => {
    const engine = new HttpEngine();
    const data = input();
    data.request.auth = { type: 'basic', username: 'alice', password: 'secret' };
    expect(JSON.parse((await engine.execute(data)).response.body).headers.authorization).toBe(
      'Basic ' + Buffer.from('alice:secret').toString('base64'),
    );
    data.request.auth = { type: 'apikey', key: 'key', value: 'secret', addTo: 'query' };
    expect(JSON.parse((await engine.execute(data)).response.body).url).toBe('/echo?key=secret');
    data.request.url = base + '/digest';
    data.request.auth = { type: 'digest', username: 'alice', password: 'secret' };
    expect((await engine.execute(data)).response.status).toBe(200);
  });
  it('acquires OAuth client-credentials and refresh tokens from a real endpoint', async () => {
    const engine = new HttpEngine();
    const auth = {
      type: 'oauth2' as const,
      tokenUrl: base + '/token',
      clientId: 'client',
      clientSecret: 'secret',
    };
    expect(await engine.oauth(auth, defaultSettings)).toEqual({
      token: 'fixture-access',
      refreshToken: 'fixture-refresh',
    });
    expect(
      (
        await engine.oauth(
          { ...auth, grantType: 'refresh_token', refreshToken: 'fixture-refresh' },
          defaultSettings,
        )
      ).token,
    ).toBe('fixture-access');
    await expect(
      engine.oauth({ ...auth, tokenUrl: 'http://example.com/token' }, defaultSettings),
    ).rejects.toThrow('HTTPS');
  });
  it('decodes gzip/Brotli and retains exact binary bytes', async () => {
    const engine = new HttpEngine();
    for (const path of ['/gzip', '/brotli'])
      expect(JSON.parse((await engine.execute(input(path))).response.body)).toEqual({
        compressed: true,
      });
    expect(Buffer.from((await engine.execute(input('/binary'))).response.base64, 'base64')).toEqual(
      Buffer.from([0, 255, 128, 1, 2]),
    );
  });
  it('handles redirects with POST rewrite and removes credentials across origins', async () => {
    const data = input('/redirect');
    data.request.method = 'POST';
    data.request.body.mode = 'raw';
    data.request.body.raw = 'hello';
    expect(JSON.parse((await new HttpEngine().execute(data)).response.body).method).toBe('GET');
    data.request.url = base + '/other';
    data.request.auth = { type: 'bearer', token: 'never-forward' };
    data.request.headers = [pair('Cookie', 'secret=never'), pair('X-API-Key', 'never-forward')];
    const sent = JSON.parse((await new HttpEngine().execute(data)).response.body);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers['x-api-key']).toBeUndefined();
    data.request.url = base + '/other-query';
    data.request.auth = {
      type: 'apikey',
      addTo: 'query',
      key: 'credential',
      value: 'never-forward',
    };
    const query = JSON.parse((await new HttpEngine().execute(data)).response.body);
    expect(query.url).toBe('/echo');
    expect((await new HttpEngine().execute(input('/loop'))).response.error).toContain(
      'Too many redirects',
    );
    data.request.url = base + '/redirect';
    data.settings.followRedirects = false;
    expect((await new HttpEngine().execute(data)).response.status).toBe(302);
  });
  it('persists, restores and deletes cookie jar entries', async () => {
    const engine = new HttpEngine();
    await engine.execute(input('/cookies'));
    expect((await engine.cookies()).some((c) => c.key === 'session' && c.httpOnly)).toBe(true);
    const restored = new HttpEngine();
    restored.loadCookies(engine.serializeCookies());
    expect(JSON.parse((await restored.execute(input())).response.body).headers.cookie).toContain(
      'session=abc',
    );
    await restored.deleteCookie('127.0.0.1', '/', 'session');
    expect((await restored.cookies()).some((c) => c.key === 'session')).toBe(false);
    await restored.setCookie(base, 'manual=yes; Path=/');
    expect((await restored.cookies()).some((c) => c.key === 'manual')).toBe(true);
  });
  it('sends form encoded, multipart, binary and GraphQL request bodies', async () => {
    const file = join(temp, 'upload.txt');
    await writeFile(file, 'actual file bytes');
    const engine = new HttpEngine((path) => path === file);
    const data = input();
    data.request.method = 'POST';
    data.request.body = {
      ...data.request.body,
      mode: 'urlencoded',
      fields: [pair('field', 'a & b')],
    };
    expect(JSON.parse((await engine.execute(data)).response.body).body).toBe('field=a+%26+b');
    data.request.body = {
      ...data.request.body,
      mode: 'form-data',
      fields: [pair('field', 'value'), { ...pair('upload', ''), type: 'file', filePath: file }],
    };
    const multipart = JSON.parse((await engine.execute(data)).response.body);
    expect(multipart.body).toContain('filename="upload.txt"');
    expect(multipart.body).toContain('actual file bytes');
    expect(multipart.headers['content-type']).toContain('boundary=');
    data.request.body = { ...data.request.body, mode: 'binary', filePath: file };
    expect(JSON.parse((await engine.execute(data)).response.body).body).toBe('actual file bytes');
    expect((await new HttpEngine().execute(data)).response.error).toContain('file picker');
    data.request.body = {
      ...data.request.body,
      mode: 'graphql',
      graphqlQuery: 'query Test { name }',
      graphqlVariables: '{"id":1}',
    };
    expect(JSON.parse(JSON.parse((await engine.execute(data)).response.body).body)).toEqual({
      query: 'query Test { name }',
      variables: { id: 1 },
    });
  });
  it('supports explicit HTTP proxy configuration', async () => {
    const data = input();
    data.settings.proxyUrl = proxyBase;
    const result = await new HttpEngine().execute(data);
    expect(result.response.error).toBeUndefined();
    expect(JSON.parse(result.response.body).proxyUrl).toBe(base + '/echo');
  });
  it('verifies TLS by default and supports explicit override and HTTPS proxy tunnels', async () => {
    const data = input();
    data.request.url = tlsBase;
    const secure = await new HttpEngine().execute(data);
    expect(secure.response.status).toBe(0);
    expect(secure.response.error).toMatch(/self.signed|DEPTH_ZERO_SELF_SIGNED_CERT/i);
    data.settings.verifyTls = false;
    expect(JSON.parse((await new HttpEngine().execute(data)).response.body)).toEqual({ tls: true });
    data.settings.proxyUrl = proxyBase;
    const tunnel = await new HttpEngine().execute(data);
    expect(tunnel.response.error).toBeUndefined();
    expect(JSON.parse(tunnel.response.body)).toEqual({ tls: true });
  });
  it('handles HEAD responses with content encoding and custom HTTP methods', async () => {
    const data = input('/gzip');
    data.request.method = 'HEAD';
    const head = await new HttpEngine().execute(data);
    expect(head.response.status).toBe(200);
    expect(head.response.size).toBe(0);
    expect(head.response.error).toBeUndefined();
    data.request.method = 'PROPFIND';
    data.request.url = base + '/echo';
    expect(JSON.parse((await new HttpEngine().execute(data)).response.body).method).toBe(
      'PROPFIND',
    );
  });
  it('cancels and times out requests and bounds response memory', async () => {
    const controller = new AbortController();
    const execution = new HttpEngine().execute(input('/slow'), controller.signal);
    setTimeout(() => controller.abort(), 30);
    expect((await execution).response.error).toBe('Request cancelled.');
    const timed = input('/slow');
    timed.settings.timeoutMs = 100;
    expect((await new HttpEngine().execute(timed)).response.error).toContain('timed out');
    const large = input('/large');
    large.settings.maxResponseMb = 1;
    expect((await new HttpEngine().execute(large)).response.error).toContain('1 MB limit');
  });
  it('reports transport failure and redacts secret script output', async () => {
    const data = input();
    data.request.url = 'http://127.0.0.1:1';
    expect((await new HttpEngine().execute(data)).response.error).toContain('ECONNREFUSED');
    data.request.url = base;
    data.environment = [{ ...pair('secret', 'super-private'), secret: true }];
    data.request.preScript = 'console.log(pm.environment.get("secret"));';
    const result = await new HttpEngine().execute(data);
    expect(result.response.logs.join('\n')).toContain('[REDACTED]');
    expect(result.response.logs.join('\n')).not.toContain('super-private');
    data.request.auth = { type: 'bearer', token: 'raw-credential' };
    data.request.preScript = 'throw new Error("raw-credential")';
    expect((await new HttpEngine().execute(data)).response.error).toBe(
      'Pre-request script: [REDACTED]',
    );
  });
  it('bounds aggregate script execution across collection, folder and request scripts', async () => {
    const data = input();
    data.preScripts = Array(10).fill('var start=Date.now(); while(Date.now()-start < 350){}');
    const start = performance.now();
    const result = await new HttpEngine().execute(data);
    expect(result.response.error).toMatch(/execution limit|2000 ms budget/);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
