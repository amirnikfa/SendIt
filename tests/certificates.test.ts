import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { getCACertificates, type TLSSocket } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { HttpEngine } from '../src/networking/http';
import { LiveEngine } from '../src/networking/live';
import {
  certificateOptions,
  certificateTrust,
  defaultCACertificates,
  prepareCertificateFile,
  systemCACertificates,
  validateClientCertificate,
} from '../src/networking/certificates';
import { certificateHost, matchesCertificateHost } from '../src/shared/certificates';
import {
  defaultSettings,
  newRequest,
  type CertificateFile,
  type ClientCertificate,
  type ExecutionInput,
  type LiveEvent,
} from '../src/shared/models';
import { settingsSchema, clientCertificateSchema } from '../src/shared/validation';

const servers: Server[] = [];
const sockets = new Set<net.Socket>();
const proxyIdentities: boolean[] = [];
let ca: CertificateFile,
  cert: CertificateFile,
  key: CertificateFile,
  encryptedKey: CertificateFile,
  pfx: CertificateFile;
let secureUrl = '',
  otherUrl = '',
  proxyUrl = '',
  secureProxyUrl = '';
let websocket: WebSocketServer;
const fixture = async (name: string): Promise<CertificateFile> => ({
  name,
  data: (await readFile(`tests/fixtures/${name}`)).toString('base64'),
});
const listen = (server: Server, secure = false) =>
  new Promise<string>((resolve) => {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve(
        `${secure ? 'https' : 'http'}://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      ),
    );
  });
function configuration(format: 'pem' | 'pfx' = 'pem'): ClientCertificate {
  return {
    id: 'test-client',
    host: '127.0.0.1',
    port: Number(new URL(secureUrl).port),
    enabled: true,
    format,
    ...(format === 'pem' ? { certificate: cert, privateKey: key } : { pfx }),
    passphrase: format === 'pfx' ? 'fixture-passphrase' : '',
  };
}
function input(client = true): ExecutionInput {
  const settings = structuredClone(defaultSettings);
  settings.timeoutMs = 2000;
  settings.tls = {
    caEnabled: true,
    caCertificates: [ca],
    clientCertificates: client ? [configuration()] : [],
  };
  return {
    request: { ...newRequest(), url: secureUrl + '/echo' },
    settings,
    globals: [],
    environment: [],
    collectionVariables: [],
  };
}
beforeAll(async () => {
  [ca, cert, key, encryptedKey, pfx] = await Promise.all(
    [
      'localhost-cert.pem',
      'client-cert.pem',
      'client-key.pem',
      'client-encrypted-key.pem',
      'client-identity.p12',
    ].map(fixture),
  );
  const serverTls = {
    cert: Buffer.from(ca.data, 'base64'),
    key: await readFile('tests/fixtures/localhost-key.pem'),
    ca: Buffer.from(ca.data, 'base64'),
    requestCert: true,
  };
  const other = https.createServer({ ...serverTls, rejectUnauthorized: false }, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        client: (req.socket as TLSSocket).getPeerCertificate().subject?.CN || null,
      }),
    );
  });
  otherUrl = await listen(other, true);
  const server = https.createServer({ ...serverTls, rejectUnauthorized: true }, (req, res) => {
    const client = (req.socket as TLSSocket).getPeerCertificate().subject?.CN;
    if (req.url === '/redirect-same' || req.url === '/redirect-other') {
      res.writeHead(302, { location: req.url === '/redirect-same' ? '/echo' : otherUrl + '/echo' });
      res.end();
    } else if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ client })}\n\n`);
    } else if (req.url === '/token') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: client }));
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ client, authorized: (req.socket as TLSSocket).authorized }));
    }
  });
  secureUrl = await listen(server, true);
  websocket = new WebSocketServer({ server, path: '/ws' });
  websocket.on('connection', (socket) =>
    socket.on('message', (message) => socket.send(message, { binary: false })),
  );
  const connect: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void = (
    req,
    socket,
    head,
  ) => {
    if ((socket as TLSSocket).encrypted)
      proxyIdentities.push(!!(socket as TLSSocket).getPeerCertificate().raw);
    const destination = new URL(`http://${req.url}`);
    const upstream = net.connect(Number(destination.port), destination.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  };
  const proxy = http.createServer();
  proxy.on('connect', connect);
  proxyUrl = await listen(proxy);
  const secureProxy = https.createServer({ ...serverTls, rejectUnauthorized: false });
  secureProxy.on('connect', connect);
  secureProxyUrl = await listen(secureProxy, true);
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => websocket.close(() => resolve()));
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('custom CA and mutual TLS', () => {
  it('adds private trust without replacing the default trusted roots or bypassing verification', async () => {
    const data = input(false);
    data.request.url = otherUrl;
    data.settings.tls.caEnabled = false;
    expect((await new HttpEngine().execute(data)).response.error).toMatch(
      /self.signed|unable to verify/i,
    );
    data.settings.tls.caEnabled = true;
    const response = (await new HttpEngine().execute(data)).response;
    expect(response.error).toBeUndefined();
    expect(response.status).toBe(200);
    expect(data.settings.verifyTls).toBe(true);
    expect(certificateTrust(data.settings).ca).toContain(getCACertificates('default')[0]);
    data.settings.tls.caCertificates = [];
    expect((await new HttpEngine().execute(data)).response.error).toMatch(
      /self.signed|unable to verify/i,
    );
  });
  it('authenticates with CRT/KEY and requires an enabled exact hostname and port match', async () => {
    const data = input(false);
    expect((await new HttpEngine().execute(data)).response.error).toBeTruthy();
    data.settings.tls.clientCertificates = [configuration()];
    const response = (await new HttpEngine().execute(data)).response;
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ client: 'SendIt Test Client', authorized: true });
    for (const patch of [{ host: 'localhost' }, { port: 443 }, { enabled: false }]) {
      data.settings.tls.clientCertificates = [{ ...configuration(), ...patch }];
      expect((await new HttpEngine().execute(data)).response.error).toBeTruthy();
    }
  });
  it('loads encrypted private keys and password-protected PFX/P12 identities', async () => {
    const data = input();
    for (const client of [
      { ...configuration(), privateKey: encryptedKey, passphrase: 'fixture-passphrase' },
      configuration('pfx'),
    ]) {
      data.settings.tls.clientCertificates = [client];
      const response = (await new HttpEngine().execute(data)).response;
      expect(response.error).toBeUndefined();
      expect(JSON.parse(response.body).client).toBe('SendIt Test Client');
      data.settings.tls.clientCertificates = [{ ...client, passphrase: 'incorrect-secret' }];
      const failure = (await new HttpEngine().execute(data)).response;
      expect(failure.error).toContain('Client certificate could not be loaded');
      expect(failure.error).not.toContain('incorrect-secret');
    }
  });
  it('selects certificates again on redirects and does not send them to another port or plaintext URL', async () => {
    const data = input();
    data.request.url = secureUrl + '/redirect-same';
    expect(JSON.parse((await new HttpEngine().execute(data)).response.body).client).toBe(
      'SendIt Test Client',
    );
    data.request.url = secureUrl + '/redirect-other';
    const response = (await new HttpEngine().execute(data)).response;
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.body).client).toBeNull();
    expect(
      certificateOptions(new URL(secureUrl.replace('https:', 'http:')), data.settings),
    ).toEqual({});
  });
  it('supports mTLS through HTTP and HTTPS CONNECT without presenting client credentials to the proxy', async () => {
    const data = input();
    for (const proxy of [proxyUrl, secureProxyUrl]) {
      data.settings.proxyUrl = proxy;
      const response = (await new HttpEngine().execute(data)).response;
      expect(response.error).toBeUndefined();
      expect(JSON.parse(response.body).client).toBe('SendIt Test Client');
    }
    expect(proxyIdentities).toEqual([false]);
  });
  it('uses certificate settings for OAuth token requests', async () => {
    const data = input();
    const token = await new HttpEngine().oauth(
      {
        type: 'oauth2',
        tokenUrl: secureUrl + '/token',
        clientId: 'test',
        clientSecret: 'secret',
        grantType: 'client_credentials',
      },
      data.settings,
    );
    expect(token.token).toBe('SendIt Test Client');
  });
  it.each(['', 'proxy', 'secure-proxy'])(
    'uses custom CA and mTLS for WSS and SSE (%s)',
    async (proxy) => {
      const events: LiveEvent[] = [];
      const live = new LiveEngine((event) => events.push(event));
      const data = input();
      data.settings.proxyUrl =
        proxy === 'proxy' ? proxyUrl : proxy === 'secure-proxy' ? secureProxyUrl : '';
      try {
        data.request.url = secureUrl.replace('https:', 'wss:') + '/ws';
        await live.connect('ws', 'websocket', data);
        live.send('ws', 'mutual-tls-echo');
        await expect
          .poll(() =>
            events.some((event) => event.type === 'message' && event.data === 'mutual-tls-echo'),
          )
          .toBe(true);
        data.request.url = secureUrl + '/sse';
        await live.connect('sse', 'sse', data);
        await expect
          .poll(() =>
            events.some(
              (event) =>
                event.id === 'sse' &&
                event.type === 'message' &&
                event.data.includes('SendIt Test Client'),
            ),
          )
          .toBe(true);
      } finally {
        live.dispose();
      }
    },
  );
  it('rejects invalid files, private keys in public CA files and wrong certificate/key pairs', () => {
    expect(() =>
      prepareCertificateFile('ca', {
        name: 'invalid.pem',
        data: Buffer.from('not a certificate').toString('base64'),
      }),
    ).toThrow('valid PEM or DER');
    expect(() => prepareCertificateFile('ca', key)).toThrow('private key');
    expect(() => prepareCertificateFile('ca', { ...ca, data: ca.data.slice(0, 12) })).toThrow();
    expect(() => prepareCertificateFile('privateKey', ca)).toThrow('PEM private key');
    expect(() =>
      prepareCertificateFile('pfx', {
        name: 'huge.p12',
        data: Buffer.alloc(262145).toString('base64'),
      }),
    ).toThrow('256 KB');
    expect(() => validateClientCertificate({ ...configuration(), certificate: ca })).toThrow(
      'Client certificate could not be loaded',
    );
    expect(() =>
      validateClientCertificate({
        ...configuration('pfx'),
        pfx: { name: 'invalid.p12', data: Buffer.from('invalid').toString('base64') },
      }),
    ).toThrow();
  });
  it('accepts and configures PFX/P12 files as client certificate without error', () => {
    const prepared = prepareCertificateFile('pfx', pfx);
    expect(prepared.name).toBe(pfx.name);
    expect(() =>
      validateClientCertificate({
        ...configuration('pfx'),
        pfx: prepared,
        passphrase: 'wrong-passphrase',
      }),
    ).toThrow('incorrect passphrase');

    expect(() =>
      validateClientCertificate({
        ...configuration('pfx'),
        pfx: prepared,
        passphrase: 'fixture-passphrase',
      }),
    ).not.toThrow();

    // certificateOptions attaching options for matching requests without error
    const testSettings = {
      ...input().settings,
      tls: {
        caEnabled: false,
        caCertificates: [],
        clientCertificates: [
          {
            id: 'user-cert-1',
            enabled: true,
            host: 'example.com, test.example.com',
            port: 443,
            format: 'pfx' as const,
            pfx: prepared,
            passphrase: 'fixture-passphrase',
          },
        ],
      },
    };
    const opts1 = certificateOptions(new URL('https://example.com/service'), testSettings);
    expect(opts1.pfx).toBeDefined();
    expect(opts1.passphrase).toBe('fixture-passphrase');

    const opts2 = certificateOptions(new URL('https://test.example.com/api/test'), testSettings);
    expect(opts2.pfx).toBeDefined();
    expect(opts2.passphrase).toBe('fixture-passphrase');
  });
  it('migrates older settings, normalizes hostnames, supports wildcards and rejects duplicates and ambiguous scopes', () => {
    const { tls: _tls, ...old } = defaultSettings;
    expect(settingsSchema.parse(old).tls).toEqual({
      caEnabled: false,
      caCertificates: [],
      clientCertificates: [],
    });
    expect(certificateHost('EXAMPLE.com.')).toBe('example.com');
    expect(certificateHost('::1')).toBe('[::1]');
    expect(certificateHost('*.example.com')).toBe('*.example.com');
    expect(certificateHost('https://example.com:8443/path')).toBe('example.com');
    expect(certificateHost('example.com:443')).toBe('example.com');
    expect(matchesCertificateHost('*.example.com', 'api.example.com')).toBe(true);
    expect(matchesCertificateHost('*.example.com', 'example.com')).toBe(false);

    for (const host of [
      'https://example.com',
      '*.example.com',
      'example.com:443',
      'example.com/path',
    ])
      expect(clientCertificateSchema.parse({ ...configuration(), host }).host).toMatch(
        /example\.com/,
      );

    expect(() => clientCertificateSchema.parse({ ...configuration(), host: '' })).toThrow();
    const settings = input().settings;
    settings.tls.clientCertificates.push({ ...configuration(), id: 'duplicate' });
    expect(() => settingsSchema.parse(settings)).toThrow('Only one client certificate');
    expect(() =>
      clientCertificateSchema.parse({ ...configuration('pfx'), certificate: cert }),
    ).toThrow();
  });
  it('loads system root CAs by default and disables verification when verifyTls is false', () => {
    const sys = systemCACertificates();
    const def = defaultCACertificates();
    expect(Array.isArray(sys)).toBe(true);
    expect(Array.isArray(def)).toBe(true);

    const normalTrust = certificateTrust(defaultSettings);
    expect(normalTrust.rejectUnauthorized).toBe(true);
    if (sys.length > 0) {
      expect(Array.isArray(normalTrust.ca)).toBe(true);
      expect((normalTrust.ca as any[]).length).toBeGreaterThanOrEqual(sys.length);
    }

    const disabledTrust = certificateTrust({ ...defaultSettings, verifyTls: false });
    expect(disabledTrust.rejectUnauthorized).toBe(false);
  });
});
