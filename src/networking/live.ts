import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import WebSocket, { type RawData } from 'ws';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Auth, ExecutionInput, LiveEvent } from '../shared/models';
import { interpolate, redact, variableMap } from '../services/variables';

const MAX_MESSAGE = 1024 * 1024;
const MAX_CONNECTIONS = 4;
type Protocol = 'websocket' | 'sse';
interface Connection {
  protocol: Protocol;
  opened: boolean;
  done: boolean;
  socket?: WebSocket;
  finish: (message: string, error?: Error) => void;
  publish: (type: LiveEvent['type'], data: string) => void;
}

/** Incremental UTF-8/CR/LF event-stream parser; reconnect policy belongs to the caller. */
class EventStreamParser {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private first = true;
  private skipLf = false;
  private data: string[] = [];
  private event = '';
  private id = '';
  private size = 0;
  constructor(private readonly dispatch: (data: string) => void) {}

  push(chunk: Buffer): void {
    let text = this.decoder.write(chunk);
    if (this.first && text) {
      this.first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.skipLf && text) {
      this.skipLf = false;
      if (text[0] === '\n') text = text.slice(1);
    }
    this.buffer += text;
    let start = 0;
    for (let index = 0; index < this.buffer.length; ++index) {
      const char = this.buffer[index];
      if (char !== '\r' && char !== '\n') continue;
      this.line(this.buffer.slice(start, index));
      if (char === '\r') {
        if (this.buffer[index + 1] === '\n') ++index;
        else if (index === this.buffer.length - 1) this.skipLf = true;
      }
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (Buffer.byteLength(this.buffer) + this.size > MAX_MESSAGE)
      throw new Error('SSE event exceeds the 1 MB limit.');
  }

  private line(line: string): void {
    this.size += Buffer.byteLength(line) + 1;
    if (this.size > MAX_MESSAGE) throw new Error('SSE event exceeds the 1 MB limit.');
    if (!line) {
      if (this.data.length) {
        const message = `event: ${this.event || 'message'}${this.id ? '\nid: ' + this.id : ''}\n\n${this.data.join('\n')}`;
        if (Buffer.byteLength(message) > MAX_MESSAGE)
          throw new Error('SSE event exceeds the 1 MB limit.');
        this.dispatch(message);
      }
      this.data = [];
      this.event = '';
      this.size = 0;
      return;
    }
    if (line[0] === ':') return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    // retry is intentionally ignored: sessions never reconnect automatically.
  }
}

function prepare(protocol: Protocol, input: ExecutionInput) {
  const scopes = [
    input.globals,
    input.collectionVariables,
    input.environment,
    input.request.variables,
  ];
  const values = variableMap(...scopes);
  const resolve = (text: string | undefined) => interpolate(text || '', values);
  const auth: Auth =
    input.request.auth.type === 'inherit'
      ? input.inheritedAuth || { type: 'none' }
      : input.request.auth;
  const secrets = scopes
    .flat()
    .filter((row) => row.secret || /password|secret|token|api[-_]?key/i.test(row.key))
    .map((row) => row.value);
  secrets.push(
    ...[auth.token, auth.password, auth.value, auth.clientSecret, auth.refreshToken].filter(
      (value): value is string => !!value,
    ),
  );
  let url: URL;
  try {
    url = new URL(
      resolve(input.request.params.length ? input.request.url.split('?')[0] : input.request.url),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unresolved variable:')) throw error;
    throw new Error(
      `Enter a complete ${protocol === 'websocket' ? 'ws:// or wss://' : 'http:// or https://'} URL.`,
    );
  }
  const allowed = protocol === 'websocket' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!allowed.includes(url.protocol))
    throw new Error(
      `${protocol === 'websocket' ? 'WebSocket' : 'SSE'} connections require ${allowed.join(' or ')} URLs.`,
    );
  if (url.username || url.password)
    throw new Error('Put credentials in the Authorization tab instead of the URL.');
  url.hash = '';
  if (input.request.params.length) {
    url.search = '';
    for (const pair of input.request.params)
      if (pair.enabled && pair.key) url.searchParams.append(resolve(pair.key), resolve(pair.value));
  }
  const headers: http.OutgoingHttpHeaders = Object.create(null);
  for (const row of input.request.headers) {
    if (!row.enabled || !row.key) continue;
    const name = resolve(row.key).toLowerCase();
    const value = resolve(row.value);
    http.validateHeaderName(name);
    http.validateHeaderValue(name, value);
    if (
      /^(connection|upgrade|sec-websocket-key|sec-websocket-version|sec-websocket-extensions|content-length|transfer-encoding)$/i.test(
        name,
      )
    )
      continue;
    const previous = headers[name];
    headers[name] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [String(previous), value];
    if (row.secret || /authorization|cookie|api[-_]?key|token|secret/i.test(name))
      secrets.push(value);
  }
  if (auth.type === 'basic') {
    const value = Buffer.from(`${resolve(auth.username)}:${resolve(auth.password)}`).toString(
      'base64',
    );
    headers.authorization = 'Basic ' + value;
    secrets.push(value, resolve(auth.password));
  } else if (auth.type === 'bearer' || auth.type === 'oauth2') {
    const token = resolve(auth.token);
    if (!token) throw new Error('Enter an access token before connecting.');
    headers.authorization = 'Bearer ' + token;
    secrets.push(token);
  } else if (auth.type === 'apikey') {
    const key = resolve(auth.key);
    const value = resolve(auth.value);
    if (!key) throw new Error('Enter an API key name.');
    secrets.push(value);
    if (auth.addTo === 'query') url.searchParams.set(key, value);
    else {
      http.validateHeaderName(key);
      http.validateHeaderValue(key, value);
      headers[key.toLowerCase()] = value;
    }
  } else if (auth.type === 'digest')
    throw new Error(
      'Digest authentication is supported for HTTP requests; live connections support Basic, Bearer and API key authentication.',
    );
  const proxy = input.settings.proxyUrl.trim();
  if (proxy) {
    let parsed: URL;
    try {
      parsed = new URL(proxy);
    } catch {
      throw new Error('Enter a valid HTTP or HTTPS proxy URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('Proxy must use HTTP or HTTPS.');
    if (parsed.password) secrets.push(decodeURIComponent(parsed.password));
  }
  return { url, headers, secrets, proxy };
}

export class LiveEngine {
  private connections = new Map<string, Connection>();
  constructor(private readonly emit: (event: LiveEvent) => void) {}

  async connect(id: string, protocol: Protocol, input: ExecutionInput): Promise<void> {
    if (this.connections.has(id))
      throw new Error('This connection is already active. Disconnect it before connecting again.');
    if (this.connections.size >= MAX_CONNECTIONS)
      throw new Error('At most four live connections can be open. Disconnect one first.');
    const { url, headers, secrets, proxy } = prepare(protocol, input);
    const verify = input.settings.verifyTls !== false;
    const timeoutMs = Math.max(1, Math.min(600000, input.settings.timeoutMs || 30000));
    return new Promise<void>((resolve, reject) => {
      let stop = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const connection: Connection = {
        protocol,
        opened: false,
        done: false,
        publish: (type, data) => {
          // Errors/control messages are redacted; payload messages remain inspectable.
          const safe = ['error', 'close', 'open'].includes(type) ? redact(data, secrets) : data;
          this.emit({ id, type, data: safe, at: new Date().toISOString() });
        },
        finish: (message, error) => {
          if (connection.done) return;
          connection.done = true;
          clearTimeout(timer);
          if (heartbeat) clearInterval(heartbeat);
          if (this.connections.get(id) === connection) this.connections.delete(id);
          stop();
          if (error) connection.publish('error', error.message);
          connection.publish('close', message);
          if (!connection.opened) reject(new Error(redact(error?.message || message, secrets)));
        },
      };
      this.connections.set(id, connection);
      const timer = setTimeout(
        () =>
          connection.finish(
            'Connection closed.',
            new Error(`Connection timed out after ${timeoutMs} ms.`),
          ),
        timeoutMs,
      );
      const opened = () => {
        if (connection.done) return;
        connection.opened = true;
        clearTimeout(timer);
        connection.publish(
          'open',
          protocol === 'websocket' ? 'WebSocket connected.' : 'SSE stream connected.',
        );
        resolve();
      };
      const failed = (error: Error) => connection.finish('Connection closed.', error);
      try {
        if (protocol === 'websocket') {
          // CONNECT supports ws and wss without exposing credentials to redirect targets.
          const agent = proxy
            ? new HttpsProxyAgent(proxy, { rejectUnauthorized: verify })
            : undefined;
          const protocolHeader = headers['sec-websocket-protocol'];
          const subprotocols = protocolHeader
            ? (Array.isArray(protocolHeader) ? protocolHeader.join(',') : String(protocolHeader))
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : [];
          delete headers['sec-websocket-protocol'];
          const socket = new WebSocket(url, subprotocols, {
            headers,
            agent,
            rejectUnauthorized: verify,
            handshakeTimeout: timeoutMs,
            followRedirects: false,
            perMessageDeflate: false,
            maxPayload: MAX_MESSAGE,
          });
          connection.socket = socket;
          stop = () => {
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          };
          socket.on('error', failed);
          socket.on('open', () => {
            if (connection.done) {
              socket.terminate();
              return;
            }
            opened();
            let awaitingPong = false;
            socket.on('pong', () => {
              awaitingPong = false;
            });
            heartbeat = setInterval(() => {
              if (awaitingPong) {
                failed(new Error('WebSocket heartbeat timed out.'));
                return;
              }
              if (socket.readyState === WebSocket.OPEN) {
                awaitingPong = true;
                socket.ping();
              }
            }, 30000);
            heartbeat.unref();
          });
          socket.on('message', (data: RawData, binary: boolean) => {
            if (connection.done) return;
            const bytes = Buffer.isBuffer(data)
              ? data
              : data instanceof ArrayBuffer
                ? Buffer.from(data)
                : Buffer.concat(data);
            if (bytes.length > MAX_MESSAGE) {
              failed(new Error('WebSocket message exceeds the 1 MB limit.'));
              return;
            }
            connection.publish(
              'message',
              binary
                ? `[Binary: ${bytes.length} bytes; Base64${bytes.length > 65536 ? ' preview truncated at 64 KB' : ''}]\n${bytes.subarray(0, 65536).toString('base64')}`
                : bytes.toString('utf8'),
            );
          });
          socket.on('close', (code, reason) =>
            connection.finish(
              `WebSocket closed (${code})${reason.length ? ': ' + reason.toString('utf8') : '.'}`,
            ),
          );
        } else {
          const transport = url.protocol === 'https:' ? https : http;
          const agent = proxy
            ? url.protocol === 'https:'
              ? new HttpsProxyAgent(proxy, { rejectUnauthorized: verify })
              : new HttpProxyAgent(proxy, { rejectUnauthorized: verify })
            : undefined;
          headers.accept = 'text/event-stream';
          headers['accept-encoding'] = 'identity';
          headers['cache-control'] = 'no-cache';
          const request = transport.request(
            url,
            { method: 'GET', headers, agent, rejectUnauthorized: verify },
            (response) => {
              if (connection.done) {
                response.destroy();
                return;
              }
              if (response.statusCode !== 200) {
                response.destroy();
                failed(
                  new Error(
                    `SSE server returned HTTP ${response.statusCode || 0}. Redirects are not followed for live connections.`,
                  ),
                );
                return;
              }
              if (!/^text\/event-stream(?:;|$)/i.test(response.headers['content-type'] || '')) {
                response.destroy();
                failed(new Error('SSE requires a text/event-stream response.'));
                return;
              }
              if (
                response.headers['content-encoding'] &&
                response.headers['content-encoding'] !== 'identity'
              ) {
                response.destroy();
                failed(
                  new Error(
                    'Compressed SSE streams are unsupported. The client requests identity encoding.',
                  ),
                );
                return;
              }
              stop = () => {
                response.destroy();
                request.destroy();
              };
              const parser = new EventStreamParser((data) => {
                if (!connection.done) connection.publish('message', data);
              });
              response.on('data', (chunk) => {
                try {
                  parser.push(Buffer.from(chunk));
                } catch (error) {
                  failed(error instanceof Error ? error : new Error(String(error)));
                }
              });
              response.on('error', failed);
              response.on('aborted', () =>
                failed(new Error('The SSE connection ended unexpectedly.')),
              );
              response.on('end', () => connection.finish('Server ended the SSE stream.'));
              response.on('close', () => {
                if (!connection.done) connection.finish('SSE stream closed.');
              });
              opened();
            },
          );
          stop = () => request.destroy();
          request.on('error', failed);
          request.on('socket', (socket) => socket.setKeepAlive(true, 30000));
          request.end();
        }
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  send(id: string, text: string): void {
    const connection = this.connections.get(id);
    if (!connection || connection.done || !connection.opened)
      throw new Error('Connect a WebSocket before sending a message.');
    if (connection.protocol !== 'websocket' || !connection.socket)
      throw new Error('SSE streams are receive-only.');
    if (Buffer.byteLength(text) > MAX_MESSAGE)
      throw new Error('WebSocket messages are limited to 1 MB.');
    if (connection.socket.bufferedAmount + Buffer.byteLength(text) > MAX_MESSAGE)
      throw new Error('WebSocket send buffer is full. Wait before sending another message.');
    if (connection.socket.readyState !== WebSocket.OPEN)
      throw new Error('The WebSocket is no longer open.');
    connection.socket.send(text, { binary: false }, (error) => {
      if (connection.done) return;
      if (error) connection.finish('Connection closed.', error);
      else connection.publish('sent', text);
    });
  }

  disconnect(id: string): void {
    this.connections.get(id)?.finish('Disconnected.');
  }
  dispose(): void {
    for (const id of [...this.connections.keys()]) this.disconnect(id);
  }
}
