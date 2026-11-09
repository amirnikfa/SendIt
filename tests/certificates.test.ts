import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { getCACertificates, type TLSSocket } from 'node:tls';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { HttpEngine } from '../src/networking/http';
import { LiveEngine } from '../src/networking/live';
import {
  certificateOptions,
  certificateTrust,
  defaultCACertificates,
  extractP12Certificates,
  prepareCertificateFile,
  systemCACertificates,
  validateClientCertificate,
} from '../src/networking/certificates';
import { importText } from '../src/services/interchange';
import {
  certificateHost,
  matchesCertificateHost,
  tlsOrigin,
  verifyTlsForUrl,
} from '../src/shared/certificates';
import {
  defaultSettings,
  initialState,
  newCollection,
  newRequest,
  type CertificateFile,
  type ClientCertificate,
  type ExecutionInput,
  type LiveEvent,
} from '../src/shared/models';
import { requestContext } from '../src/renderer/store';
import { settingsSchema, clientCertificateSchema } from '../src/shared/validation';

const servers: Server[] = [];
const sockets = new Set<net.Socket>();
const proxyIdentities: boolean[] = [];
let ca: CertificateFile,
  cert: CertificateFile,
  key: CertificateFile,
  encryptedKey: CertificateFile,
  pfx: CertificateFile,
  clientOnlyPfx: CertificateFile,
  intermediatePfx: CertificateFile;
let secureUrl = '',
  signedUrl = '',
  intermediateUrl = '',
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
  clientOnlyPfx = {
    name: 'client-only.p12',
    data: Buffer.from(
      forge.asn1
        .toDer(
          forge.pkcs12.toPkcs12Asn1(
            forge.pki.privateKeyFromPem(Buffer.from(key.data, 'base64').toString()),
            [forge.pki.certificateFromPem(Buffer.from(cert.data, 'base64').toString())],
            'fixture-passphrase',
          ),
        )
        .getBytes(),
      'binary',
    ).toString('base64'),
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
    if (req.url === '/login') {
      const port = (server.address() as net.AddressInfo).port;
      res.setHeader('set-cookie', [
        `session_id=secret-cookie-123; Domain=127.0.0.1:${port}; Path=/; Secure; HttpOnly`,
        'auth_token=jwt-456; Domain="127.0.0.1"; Path=/; Secure',
      ]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ login: true, client }));
    } else if (req.url === '/other-service') {
      const cookie = req.headers.cookie || '';
      if (!cookie.includes('session_id=secret-cookie-123')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no cookie is set apparently' }));
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, cookie }));
      }
    } else if (req.url === '/redirect-same' || req.url === '/redirect-other') {
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
  // An internal service that sends only its leaf, requiring the issuer from the P12.
  const issuer = forge.pki.certificateFromPem(Buffer.from(ca.data, 'base64').toString());
  const issuerKey = forge.pki.privateKeyFromPem(serverTls.key.toString());
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = issuer.publicKey;
  leaf.serialNumber = '02';
  leaf.validity = issuer.validity;
  leaf.setSubject([{ name: 'commonName', value: 'Internal API' }]);
  leaf.setIssuer(issuer.subject.attributes);
  leaf.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  leaf.sign(issuerKey, forge.md.sha256.create());
  const sessionService: http.RequestListener = (req, res) => {
    if (req.url?.endsWith('/user/loginStatic')) {
      res.setHeader('set-cookie', 'session_id=login-session; Path=/; Secure; HttpOnly');
      res.end('Logged in');
    } else {
      const authorized = req.headers.cookie?.includes('session_id=login-session');
      res.writeHead(authorized ? 200 : 401);
      res.end(authorized ? 'Authenticated service response' : 'Missing login cookie');
    }
  };
  signedUrl = await listen(
    https.createServer(
      { ...serverTls, cert: forge.pki.certificateToPem(leaf), rejectUnauthorized: true },
      sessionService,
    ),
    true,
  );
  const intermediate = forge.pki.createCertificate();
  intermediate.publicKey = issuer.publicKey;
  intermediate.serialNumber = '03';
  intermediate.validity = issuer.validity;
  intermediate.setSubject([{ name: 'commonName', value: 'Internal Issuing CA' }]);
  intermediate.setIssuer(issuer.subject.attributes);
  intermediate.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  intermediate.sign(issuerKey, forge.md.sha256.create());
  leaf.setIssuer(intermediate.subject.attributes);
  leaf.sign(issuerKey, forge.md.sha256.create());
  const clientLeaf = forge.pki.certificateFromPem(Buffer.from(cert.data, 'base64').toString());
  clientLeaf.setIssuer(intermediate.subject.attributes);
  clientLeaf.sign(issuerKey, forge.md.sha256.create());
  intermediatePfx = {
    name: 'intermediate-only.p12',
    data: Buffer.from(
      forge.asn1
        .toDer(
          forge.pkcs12.toPkcs12Asn1(
            forge.pki.privateKeyFromPem(Buffer.from(key.data, 'base64').toString()),
            [clientLeaf, intermediate],
            'fixture-passphrase',
          ),
        )
        .getBytes(),
      'binary',
    ).toString('base64'),
  };
  intermediateUrl = await listen(
    https.createServer(
      {
        ...serverTls,
        cert: forge.pki.certificateToPem(leaf),
        rejectUnauthorized: true,
      },
      sessionService,
    ),
    true,
  );
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
  it('uses an explicit host exception for a client-only P12 without changing global or proxy trust', async () => {
    const data = input();
    data.settings.tls = {
      caEnabled: false,
      caCertificates: [],
      clientCertificates: [
        { ...configuration('pfx'), pfx: clientOnlyPfx, port: Number(new URL(signedUrl).port) },
      ],
    };
    const engine = new HttpEngine();
    data.request.url = signedUrl + '/api/v1/user/loginStatic';
    data.request.verifyTls = false;
    expect((await engine.execute(data)).response.status).toBe(200);
    data.request = {
      ...newRequest(),
      url: signedUrl + '/api/v1/card/balanceInquery',
    };
    const failure = (await engine.execute(data)).response;
    expect(failure.error).toMatch(/self.signed|unable to verify/i);
    expect(failure.url).toBe(data.request.url);
    const restored = new HttpEngine();
    restored.loadCookies(engine.serializeCookies());
    data.settings.tls.insecureOrigins = [tlsOrigin(data.request.url)!];
    data.settings = settingsSchema.parse(data.settings);
    const success = (await restored.execute(data)).response;
    expect(success.error).toBeUndefined();
    expect(success.status).toBe(200);
    expect(success.body).toBe('Authenticated service response');
    expect(data.settings.verifyTls).toBe(true);
    expect(certificateTrust(data.settings).rejectUnauthorized).toBe(true);
    expect(certificateOptions(new URL(otherUrl), data.settings).rejectUnauthorized).toBe(true);

    data.request.verifyTls = true;
    expect((await restored.execute(data)).response.error).toMatch(/self.signed|unable to verify/i);
    data.request.verifyTls = undefined;
    data.settings.proxyUrl = secureProxyUrl;
    expect((await restored.execute(data)).response.error).toMatch(/self.signed|unable to verify/i);
    data.settings.proxyUrl = '';
    data.settings.tls.insecureOrigins = [];
    expect((await restored.execute(data)).response.error).toMatch(/self.signed|unable to verify/i);
  });
  it('does not carry a host SSL exception across redirects to another port', async () => {
    const data = input();
    data.settings.tls.caEnabled = false;
    data.settings.tls.insecureOrigins = [secureUrl];
    data.request.url = secureUrl + '/redirect-other';
    const response = (await new HttpEngine().execute(data)).response;
    expect(response.error).toMatch(/self.signed|unable to verify/i);
    expect(response.url).toBe(otherUrl + '/echo');
  });
  it('validates exact SSL exception origins and resolves request overrides consistently', () => {
    const settings = structuredClone(defaultSettings);
    settings.tls.insecureOrigins = ['https://example.com'];
    expect(verifyTlsForUrl('https://example.com/login', settings)).toBe(false);
    expect(verifyTlsForUrl('wss://example.com/events', settings)).toBe(false);
    expect(verifyTlsForUrl('https://example.com:444/login', settings)).toBe(true);
    expect(verifyTlsForUrl('https://sub.example.com', settings)).toBe(true);
    expect(verifyTlsForUrl('https://example.com.evil.test', settings)).toBe(true);
    expect(verifyTlsForUrl('https://example.com', settings, true)).toBe(true);
    expect(verifyTlsForUrl('https://other.test', { ...settings, verifyTls: false }, true)).toBe(
      true,
    );
    for (const value of [
      'http://example.com',
      'https://*.example.com',
      'https://example.com/path',
      'https://user:pass@example.com',
    ]) {
      settings.tls.insecureOrigins = [value];
      expect(() => settingsSchema.parse(settings)).toThrow('exact HTTPS origins');
    }
  });
  it.each(['client-aes128.p12', 'client-aes192.p12'])(
    'reads the complete authenticated certificate bags from %s',
    async (name) => {
      const data = await readFile(`tests/fixtures/${name}`);
      const certificates = extractP12Certificates(data, ['fixture-passphrase']);
      expect(certificates).toHaveLength(2);
      expect(certificates).toContain(
        new X509Certificate(Buffer.from(ca.data, 'base64')).toString(),
      );
      expect(extractP12Certificates(data, ['wrong-password'])).toEqual([]);
    },
  );
  it('authenticates plaintext certificate bags before trusting them and excludes the client leaf', () => {
    const data = Buffer.from(intermediatePfx.data, 'base64');
    const certificates = extractP12Certificates(data, ['fixture-passphrase']);
    expect(certificates).toHaveLength(2);
    expect(extractP12Certificates(data, ['wrong-password'])).toEqual([]);
    // Change public certificate bytes in the unencrypted bag without updating the archive MAC.
    const damaged = Buffer.from(data);
    const offset = damaged.indexOf(Buffer.from('Internal Issuing CA'));
    expect(offset).toBeGreaterThan(0);
    damaged[offset] ^= 1;
    expect(extractP12Certificates(damaged, ['fixture-passphrase'])).toEqual([]);

    const dataInput = input();
    dataInput.settings.tls.caEnabled = false;
    dataInput.settings.tls.clientCertificates = [
      {
        ...configuration('pfx'),
        pfx: intermediatePfx,
      },
    ];
    const options = certificateOptions(new URL(secureUrl), dataInput.settings);
    const issuer = certificates.find((pem) => new X509Certificate(pem).ca)!;
    const client = certificates.find((pem) => !new X509Certificate(pem).ca)!;
    expect(options.ca).toContain(issuer);
    expect(options.ca).not.toContain(client);
    expect(certificateTrust(dataInput.settings).ca || []).not.toContain(issuer);
  });
  it.each(['client-aes128.p12', 'client-aes192.p12', 'intermediate-only.p12'])(
    'uses %s CA trust for a verified service after imported loginStatic and cookie reload',
    async (name) => {
      const serviceUrl = name === 'intermediate-only.p12' ? intermediateUrl : signedUrl;
      const collection = importText(
        JSON.stringify({
          info: { name: 'Internal API login workflow' },
          item: [
            {
              name: 'loginStatic',
              protocolProfileBehavior: { strictSSL: false },
              request: {
                method: 'POST',
                url: serviceUrl + '/api/v1/user/loginStatic',
              },
            },
            {
              name: 'balanceInquery',
              request: {
                method: 'POST',
                url: serviceUrl + '/api/v1/card/balanceInquery',
              },
            },
          ],
        }),
      ).collections[0];
      const data = input();
      data.settings.tls = {
        caEnabled: false,
        caCertificates: [],
        clientCertificates: [
          {
            ...configuration('pfx'),
            port: Number(new URL(serviceUrl).port),
            pfx: name === 'intermediate-only.p12' ? intermediatePfx : await fixture(name),
          },
        ],
      };
      const engine = new HttpEngine();
      data.request = collection.requests[0];
      expect((await engine.execute(data)).response.status).toBe(200);
      data.request = collection.requests[1];
      expect(data.request.verifyTls).toBeUndefined();
      expect(certificateOptions(new URL(data.request.url), data.settings).rejectUnauthorized).toBe(
        true,
      );
      const restored = new HttpEngine();
      restored.loadCookies(engine.serializeCookies());
      const response = (await restored.execute(data)).response;
      expect(response.error).toBeUndefined();
      expect(response.status).toBe(200);
      expect(response.body).toBe('Authenticated service response');
      expect(data.settings.verifyTls).toBe(true);

      if (name === 'intermediate-only.p12') {
        data.request.url = data.request.url.replace('127.0.0.1', 'localhost');
        data.settings.tls.clientCertificates[0].host = 'localhost';
        expect((await restored.execute(data)).response.error).toContain(
          'ERR_TLS_CERT_ALTNAME_INVALID',
        );
        data.request.url = data.request.url.replace('localhost', '127.0.0.1');
        data.settings.tls.clientCertificates[0].host = '127.0.0.1';
      }

      // An identity for another destination must not grant server trust here.
      data.settings.tls.clientCertificates[0].port = Number(new URL(otherUrl).port);
      expect((await restored.execute(data)).response.error).toMatch(
        /unable to verify|self.signed/i,
      );
    },
  );
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
  it('preserves and sends cookies across collection requests over HTTPS with CA certificate', async () => {
    const engine = new HttpEngine();
    const loginInput = input();
    loginInput.request.url = secureUrl + '/login';
    const loginResult = await engine.execute(loginInput);
    expect(loginResult.response.status).toBe(200);
    expect(loginResult.response.cookies.length).toBe(2);

    // Verify cookies stored in engine jar (including IP domain and port stripping)
    const stored = await engine.cookies();
    expect(stored.some((c) => c.key === 'session_id' && c.value === 'secret-cookie-123')).toBe(
      true,
    );
    expect(stored.some((c) => c.key === 'auth_token' && c.value === 'jwt-456')).toBe(true);

    // Call another service from the collection on that server
    const nextInput = input();
    nextInput.request.url = secureUrl + '/other-service';
    const nextResult = await engine.execute(nextInput);
    expect(nextResult.response.error).toBeUndefined();
    expect(nextResult.response.status).toBe(200);
    const body = JSON.parse(nextResult.response.body);
    expect(body.ok).toBe(true);
    expect(body.cookie).toContain('session_id=secret-cookie-123');
    expect(body.cookie).toContain('auth_token=jwt-456');

    // Also test when collection request has existing headers (merging without drop)
    const nextWithHeaders = input();
    nextWithHeaders.request.url = secureUrl + '/other-service';
    nextWithHeaders.request.headers = [
      { id: '1', key: 'Cookie', value: 'custom=pre-existing', enabled: true },
    ];
    const nextWithHeadersResult = await engine.execute(nextWithHeaders);
    expect(nextWithHeadersResult.response.status).toBe(200);
    const body2 = JSON.parse(nextWithHeadersResult.response.body);
    expect(body2.cookie).toContain('custom=pre-existing');
    expect(body2.cookie).toContain('session_id=secret-cookie-123');
  });

  it('extracts CA certificates from PKCS#12 bundles and automatically trusts them for matching hosts', async () => {
    // client-identity.p12 contains SendIt Test Client and localhost CA cert
    const pfxClient: ClientCertificate = {
      id: 'pfx-client',
      host: '127.0.0.1',
      port: Number(new URL(secureUrl).port),
      enabled: true,
      format: 'pfx',
      pfx,
      passphrase: 'fixture-passphrase',
    };

    // When caEnabled is false, certificateOptions should still include the CA certificate from the client PFX
    const testSettings = structuredClone(defaultSettings);
    testSettings.tls = {
      caEnabled: false,
      caCertificates: [],
      clientCertificates: [pfxClient],
    };

    const options = certificateOptions(new URL(secureUrl + '/echo'), testSettings);
    expect(options.ca).toBeDefined();
    expect(Array.isArray(options.ca)).toBe(true);
    // Should contain localhost CA from pfx
    const caStrings = (options.ca as string[]).join('\n');
    expect(caStrings).toContain('-----BEGIN CERTIFICATE-----');

    // Executing request with pfx client should succeed because CA is trusted from PFX
    const engine = new HttpEngine();
    const reqInput: ExecutionInput = {
      request: { ...newRequest(), url: secureUrl + '/echo' },
      settings: testSettings,
      globals: [],
      environment: [],
      collectionVariables: [],
    };
    const result = await engine.execute(reqInput);
    expect(result.response.error).toBeUndefined();
    expect(result.response.status).toBe(200);
  });

  it('supports PKCS#12 (.p12) in caCertificates and bypasses TLS when verifyTls is false without crashing', async () => {
    // Test PKCS#12 file used as CA certificate
    const testSettings = structuredClone(defaultSettings);
    testSettings.tls = {
      caEnabled: true,
      caCertificates: [pfx],
      clientCertificates: [
        {
          id: 'pfx-client',
          host: '127.0.0.1',
          port: Number(new URL(secureUrl).port),
          enabled: true,
          format: 'pfx',
          pfx,
          passphrase: 'fixture-passphrase',
        },
      ],
    };

    // With candidate passphrase from client certificate, CA is decrypted and extracted
    const trust = certificateTrust(testSettings);
    expect(trust.rejectUnauthorized).toBe(true);
    expect(Array.isArray(trust.ca)).toBe(true);

    // When verifyTls is false, it returns rejectUnauthorized: false immediately
    const disabledTrust = certificateTrust(testSettings, false);
    expect(disabledTrust.rejectUnauthorized).toBe(false);

    // Even with a completely corrupted CA certificate, verifyTls: false never throws
    const corruptSettings = structuredClone(defaultSettings);
    corruptSettings.tls = {
      caEnabled: true,
      caCertificates: [{ name: 'broken.crt', data: Buffer.from('bad data').toString('base64') }],
      clientCertificates: [],
    };
    const corruptDisabled = certificateTrust(corruptSettings, false);
    expect(corruptDisabled.rejectUnauthorized).toBe(false);
  });

  it('verifies all 4 SSL bypass options against an untrusted HTTPS server', async () => {
    const engine = new HttpEngine();

    // Baseline: untrusted server fails verification with global verifyTls: true
    const baseInput = input(false);
    baseInput.request.url = otherUrl;
    baseInput.settings.verifyTls = true;
    baseInput.settings.tls.caEnabled = false;
    expect((await engine.execute(baseInput)).response.error).toMatch(
      /self.signed|unable to verify/i,
    );

    // Option 1: Client certificate with verifyServerCertificate: false
    const opt1Input = input(false);
    opt1Input.request.url = otherUrl;
    opt1Input.settings.verifyTls = true;
    opt1Input.settings.tls.caEnabled = false;
    opt1Input.settings.tls.clientCertificates = [
      {
        ...configuration(),
        port: Number(new URL(otherUrl).port),
        verifyServerCertificate: false,
      },
    ];
    const opt1Res = await engine.execute(opt1Input);
    expect(opt1Res.response.status).toBe(200);
    expect(opt1Res.response.error).toBeUndefined();

    // Option 2: Request / collection-level verifyTls: false
    const opt2Input = input(false);
    opt2Input.request.url = otherUrl;
    opt2Input.request.verifyTls = false;
    opt2Input.settings.verifyTls = true;
    opt2Input.settings.tls.caEnabled = false;
    const opt2Res = await engine.execute(opt2Input);
    expect(opt2Res.response.status).toBe(200);
    expect(opt2Res.response.error).toBeUndefined();

    // Option 3: Insecure origins exception
    const opt3Input = input(false);
    opt3Input.request.url = otherUrl;
    opt3Input.settings.verifyTls = true;
    opt3Input.settings.tls.caEnabled = false;
    opt3Input.settings.tls.insecureOrigins = [otherUrl];
    const opt3Res = await engine.execute(opt3Input);
    expect(opt3Res.response.status).toBe(200);
    expect(opt3Res.response.error).toBeUndefined();

    // Option 4: Global verifyTls: false
    const opt4Input = input(false);
    opt4Input.request.url = otherUrl;
    opt4Input.settings.verifyTls = false;
    opt4Input.settings.tls.caEnabled = false;
    const opt4Res = await engine.execute(opt4Input);
    expect(opt4Res.response.status).toBe(200);
    expect(opt4Res.response.error).toBeUndefined();

    // Explicit per-request verifyTls: true overrides Options 1, 3, and 4
    for (const testInput of [opt1Input, opt3Input, opt4Input]) {
      const strictInput = structuredClone(testInput);
      strictInput.request.verifyTls = true;
      expect((await engine.execute(strictInput)).response.error).toMatch(
        /self.signed|unable to verify/i,
      );
    }
  });

  it('preserves collection context and verifyTls when request is called from history', async () => {
    const engine = new HttpEngine();
    const appState = initialState();
    const collection = newCollection('Test TLS Collection');
    collection.verifyTls = false;
    const collReq = newRequest();
    collReq.url = otherUrl;
    collReq.collectionId = collection.id;
    collection.requests.push(collReq);
    appState.workspaces[0].collections.push(collection);

    // 1. Run from within collection: requestContext inherits verifyTls: false
    const collectionContext = requestContext(appState, structuredClone(collReq));
    expect(collectionContext.request.verifyTls).toBe(false);
    const collectionResult = await engine.execute(collectionContext);
    expect(collectionResult.response.status).toBe(200);
    expect(collectionResult.response.error).toBeUndefined();

    // 2. Saved to history with effective verifyTls and collectionId
    const historyRequest = structuredClone(collReq);
    if (
      historyRequest.verifyTls === undefined &&
      collectionContext.request.verifyTls !== undefined
    ) {
      historyRequest.verifyTls = collectionContext.request.verifyTls;
    }
    const historyEntry = {
      id: 'hist-1',
      at: new Date().toISOString(),
      request: historyRequest,
      status: collectionResult.response.status,
      duration: collectionResult.response.duration,
      error: collectionResult.response.error,
    };
    appState.workspaces[0].history.unshift(historyEntry);

    // 3. Opened from history: preserves collectionId, folderId, and verifyTls
    const openedFromHistory = {
      ...historyEntry.request,
      id: 'tab-req-1',
      collectionId: historyEntry.request.collectionId,
      folderId: historyEntry.request.folderId,
      verifyTls: historyEntry.request.verifyTls,
    };
    expect(openedFromHistory.collectionId).toBe(collection.id);
    expect(openedFromHistory.verifyTls).toBe(false);

    // 4. Executed from history: inherits collection context and succeeds without CA certificate error
    const historyContext = requestContext(appState, structuredClone(openedFromHistory));
    expect(historyContext.request.verifyTls).toBe(false);
    const historyResult = await engine.execute(historyContext);
    expect(historyResult.response.status).toBe(200);
    expect(historyResult.response.error).toBeUndefined();

    // 5. Even if collection is removed, the request from history still maintains verifyTls: false and succeeds
    const appStateNoCollection = structuredClone(appState);
    appStateNoCollection.workspaces[0].collections = [];
    const orphanContext = requestContext(appStateNoCollection, structuredClone(openedFromHistory));
    expect(orphanContext.request.verifyTls).toBe(false);
    const orphanResult = await engine.execute(orphanContext);
    expect(orphanResult.response.status).toBe(200);
    expect(orphanResult.response.error).toBeUndefined();
  });
});
