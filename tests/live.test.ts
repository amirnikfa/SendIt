import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { LiveEngine } from '../src/networking/live';
import {
  defaultSettings,
  newRequest,
  pair,
  type ExecutionInput,
  type LiveEvent,
} from '../src/shared/models';

let server: Server, tls: Server, proxy: Server;
let ws: WebSocketServer, wss: WebSocketServer;
let base = '',
  secureBase = '',
  proxyBase = '';
const engines: LiveEngine[] = [];
const sockets = new WeakMap<Server, Set<net.Socket>>();
const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    const tracked = new Set<net.Socket>();
    sockets.set(server, tracked);
    server.on('connection', (socket) => {
      tracked.add(socket);
      socket.on('close', () => tracked.delete(socket));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
    );
  });
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    for (const socket of sockets.get(server) || []) socket.destroy();
    server.closeAllConnections();
    server.close(() => resolve());
  });
const input = (url: string): ExecutionInput => ({
  request: { ...newRequest(), url },
  globals: [],
  environment: [],
  collectionVariables: [],
  settings: { ...defaultSettings },
});
function client() {
  const events: LiveEvent[] = [];
  const engine = new LiveEngine((event) => events.push(event));
  engines.push(engine);
  return { events, engine };
}
async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for live event.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  const handle: http.RequestListener = (req, res) => {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path === '/bad') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: '/sse' });
      res.end();
      return;
    }
    if (path === '/slow') return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.flushHeaders();
    if (path === '/sse-large') {
      res.write('data: ' + 'x'.repeat(1024 * 1024) + '\n\n');
      return;
    }
    if (path === '/sse-fragments') {
      const bytes = Buffer.from(
        '\ufeff:comment\r\nevent: update\r\nid: event-1\r\ndata: café 😀\r\ndata: second line\r\n\r\ndata: next\n\n',
      );
      let offset = 0;
      const timer = setInterval(() => {
        if (offset === bytes.length) {
          clearInterval(timer);
          return;
        }
        res.write(bytes.subarray(offset, ++offset));
      }, 1);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.write(
      `event: request\ndata: ${JSON.stringify({ headers: req.headers, url: req.url })}\n\n`,
    );
    if (path === '/sse-end') res.end();
    if (path === '/sse-abort') setTimeout(() => res.destroy(), 10);
  };
  server = http.createServer(handle);
  ws = new WebSocketServer({ noServer: true });
  const addWs = (websocket: WebSocketServer) =>
    websocket.on('connection', (socket, request) => {
      socket.on('error', () => {});
      socket.send(JSON.stringify({ headers: request.headers, url: request.url }));
      socket.on('message', (data, binary) => socket.send(data, { binary }));
      if (request.url?.startsWith('/fragments')) {
        socket.send('frag', { fin: false, binary: false });
        socket.send('mented', { fin: true, binary: false });
      }
      if (request.url?.startsWith('/binary')) socket.send(Buffer.from([0, 255, 128]));
      if (request.url?.startsWith('/large')) socket.send('x'.repeat(1024 * 1024 + 1));
      if (request.url?.startsWith('/end')) socket.close(1000, 'Fixture ended');
    });
  addWs(ws);
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/slow') return;
    ws.handleUpgrade(request, socket, head, (client) => ws.emit('connection', client, request));
  });
  base = await listen(server);
  tls = https.createServer(
    {
      key: await readFile('tests/fixtures/localhost-key.pem'),
      cert: await readFile('tests/fixtures/localhost-cert.pem'),
    },
    handle,
  );
  wss = new WebSocketServer({ server: tls });
  addWs(wss);
  secureBase = (await listen(tls)).replace('http:', 'https:');
  proxy = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ via: 'proxy', url: req.url })}\n\n`);
  });
  proxy.on('connect', (request, socket, head) => {
    const [host, port] = (request.url || '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  proxyBase = await listen(proxy);
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
afterAll(async () => {
  for (const client of ws.clients) client.terminate();
  for (const client of wss.clients) client.terminate();
  ws.close();
  wss.close();
  await close(server);
  await close(tls);
  await close(proxy);
});

describe('live WebSocket client', () => {
  it('connects, sends, receives fragmented messages and disconnects', async () => {
    const { engine, events } = client();
    await engine.connect('ws', 'websocket', input(base.replace('http:', 'ws:') + '/fragments'));
    engine.send('ws', 'real echo');
    await until(
      () =>
        events.some((e) => e.type === 'message' && e.data === 'real echo') &&
        events.some((e) => e.data === 'fragmented'),
    );
    expect(events.some((e) => e.type === 'open')).toBe(true);
    expect(events.some((e) => e.type === 'sent' && e.data === 'real echo')).toBe(true);
    engine.disconnect('ws');
    expect(events.at(-1)?.type).toBe('close');
    expect(() => engine.send('ws', 'again')).toThrow('Connect');
  });
  it('resolves variables, custom headers, params and inherited authentication', async () => {
    const { engine, events } = client();
    const data = input('{{base}}/echo?disabled={{missing}}');
    data.environment = [pair('base', base.replace('http:', 'ws:')), pair('access', 'real-token')];
    data.request.params = [
      pair('q', 'hello world'),
      { ...pair('disabled', '{{missing}}'), enabled: false },
    ];
    data.request.headers = [pair('X-Test', '{{access}}')];
    data.inheritedAuth = { type: 'bearer', token: '{{access}}' };
    await engine.connect('auth', 'websocket', data);
    await until(() => events.some((e) => e.type === 'message'));
    const sent = JSON.parse(events.find((e) => e.type === 'message')!.data);
    expect(sent.url).toBe('/echo?q=hello+world');
    expect(sent.headers.authorization).toBe('Bearer real-token');
    expect(sent.headers['x-test']).toBe('real-token');
  });
  it('receives binary payloads and bounds incoming and outgoing frames', async () => {
    const { engine, events } = client();
    await engine.connect('binary', 'websocket', input(base.replace('http:', 'ws:') + '/binary'));
    await until(() => events.some((e) => e.data.includes('[Binary:')));
    expect(events.find((e) => e.data.includes('[Binary:'))?.data).toContain('AP+A');
    expect(() => engine.send('binary', 'x'.repeat(1024 * 1024 + 1))).toThrow('1 MB');
    await engine.connect('large', 'websocket', input(base.replace('http:', 'ws:') + '/large'));
    await until(() => events.some((e) => e.id === 'large' && e.type === 'error'));
    expect(events.some((e) => e.id === 'large' && e.type === 'close')).toBe(true);
  });
  it('reports server closure and supports subprotocol negotiation', async () => {
    const { engine, events } = client();
    const data = input(base.replace('http:', 'ws:') + '/end');
    data.request.headers = [pair('Sec-WebSocket-Protocol', 'json')];
    await engine.connect('end', 'websocket', data);
    await until(() => events.some((e) => e.type === 'close'));
    expect(events.find((e) => e.type === 'close')?.data).toContain('1000');
  });
  it('rejects invalid protocols, unsupported auth, duplicate IDs and excessive connections', async () => {
    const { engine } = client();
    await expect(engine.connect('invalid', 'websocket', input('file:///secret'))).rejects.toThrow(
      'WebSocket',
    );
    const digest = input(base.replace('http:', 'ws:'));
    digest.request.auth = { type: 'digest' };
    await expect(engine.connect('digest', 'websocket', digest)).rejects.toThrow('Digest');
    for (let n = 0; n < 4; ++n)
      await engine.connect(String(n), 'websocket', input(base.replace('http:', 'ws:')));
    await expect(
      engine.connect('0', 'websocket', input(base.replace('http:', 'ws:'))),
    ).rejects.toThrow('already active');
    await expect(
      engine.connect('5', 'websocket', input(base.replace('http:', 'ws:'))),
    ).rejects.toThrow('four');
    engine.disconnect('0');
    await engine.connect('5', 'websocket', input(base.replace('http:', 'ws:')));
  });
});

describe('live server-sent events', () => {
  it('incrementally parses split UTF-8, BOM, CRLF, comments, event/id and multiline data', async () => {
    const { engine, events } = client();
    await engine.connect('sse', 'sse', input(base + '/sse-fragments'));
    await until(() => events.filter((e) => e.type === 'message').length === 2);
    expect(events.filter((e) => e.type === 'message').map((e) => e.data)).toEqual([
      'event: update\nid: event-1\n\ncafé 😀\nsecond line',
      'event: message\nid: event-1\n\nnext',
    ]);
    expect(() => engine.send('sse', 'not allowed')).toThrow('receive-only');
  });
  it('sends Basic/API key auth and receives through a configured HTTP proxy', async () => {
    const { engine, events } = client();
    const data = input(base + '/sse');
    data.request.auth = { type: 'basic', username: 'user', password: 'password' };
    await engine.connect('basic', 'sse', data);
    await until(() => events.some((e) => e.id === 'basic' && e.type === 'message'));
    expect(events.find((e) => e.id === 'basic' && e.type === 'message')?.data).toContain(
      Buffer.from('user:password').toString('base64'),
    );
    data.request.auth = { type: 'apikey', key: 'access', value: 'key-value', addTo: 'query' };
    data.settings.proxyUrl = proxyBase;
    await engine.connect('proxy', 'sse', data);
    await until(() => events.some((e) => e.id === 'proxy' && e.type === 'message'));
    expect(events.find((e) => e.id === 'proxy' && e.type === 'message')?.data).toContain('via');
    expect(events.find((e) => e.id === 'proxy' && e.type === 'message')?.data).toContain(
      'access=key-value',
    );
  });
  it('rejects wrong MIME and redirects, and closes oversized/ended streams', async () => {
    const { engine, events } = client();
    await expect(engine.connect('bad', 'sse', input(base + '/bad'))).rejects.toThrow(
      'text/event-stream',
    );
    await expect(engine.connect('redirect', 'sse', input(base + '/redirect'))).rejects.toThrow(
      '302',
    );
    await engine.connect('large', 'sse', input(base + '/sse-large'));
    await until(() => events.some((e) => e.id === 'large' && e.type === 'error'));
    expect(events.find((e) => e.id === 'large' && e.type === 'error')?.data).toContain('1 MB');
    await engine.connect('end', 'sse', input(base + '/sse-end'));
    await until(() => events.some((e) => e.id === 'end' && e.type === 'close'));
    await engine.connect('abort', 'sse', input(base + '/sse-abort'));
    await until(() => events.some((e) => e.id === 'abort' && e.type === 'error'));
  });
});

describe('live lifecycle, TLS and proxy', () => {
  it('bounds initial handshakes and permits cancellation before opening', async () => {
    const { engine, events } = client();
    const data = input(base + '/slow');
    data.settings.timeoutMs = 30;
    await expect(engine.connect('timeout', 'sse', data)).rejects.toThrow('timed out');
    data.request.url = base.replace('http:', 'ws:') + '/slow';
    await expect(engine.connect('ws-timeout', 'websocket', data)).rejects.toThrow(
      /timed out|timeout/i,
    );
    data.settings.timeoutMs = 1000;
    const pending = engine.connect('cancel', 'websocket', data);
    const checked = expect(pending).rejects.toThrow('Disconnected');
    engine.disconnect('cancel');
    await checked;
    expect(events.filter((e) => e.id === 'cancel' && e.type === 'close')).toHaveLength(1);
  });
  it('enforces TLS verification and connects WSS/SSE through HTTP CONNECT when opted out', async () => {
    const { engine, events } = client();
    const data = input(secureBase.replace('https:', 'wss:'));
    await expect(engine.connect('secure', 'websocket', data)).rejects.toThrow(/self.signed/i);
    data.settings.verifyTls = false;
    data.settings.proxyUrl = proxyBase;
    await engine.connect('wss', 'websocket', data);
    engine.send('wss', 'tunneled');
    await until(() =>
      events.some((e) => e.id === 'wss' && e.data === 'tunneled' && e.type === 'message'),
    );
    data.request.url = secureBase + '/sse';
    await engine.connect('sse', 'sse', data);
    await until(() => events.some((e) => e.id === 'sse' && e.type === 'message'));
    engine.dispose();
    expect(events.some((e) => e.id === 'wss' && e.type === 'close')).toBe(true);
    expect(events.some((e) => e.id === 'sse' && e.type === 'close')).toBe(true);
  });
});
