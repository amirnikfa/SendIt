import { describe, expect, it } from 'vitest';
import {
  exportCollection,
  exportEnvironment,
  exportOpenApi,
  importText,
  isOpenApi,
  toCurl,
  toHttp,
  toMarkdown,
} from '../src/services/interchange';
import {
  newCollection,
  newRequest,
  pair,
  type ApiRequest,
  type Collection,
} from '../src/shared/models';

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const fixture = {
  info: { name: 'Orders API', schema, description: { content: 'Order lifecycle' } },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{access_token}}' }] },
  variable: [{ key: 'base', value: 'https://api.example.test', description: 'API root' }],
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: ['pm.variables.set("n", 1);', 'console.log("ready");'],
      },
    },
  ],
  item: [
    {
      name: 'Orders',
      description: 'Order requests',
      auth: {
        type: 'basic',
        basic: [
          { key: 'username', value: 'alice' },
          { key: 'password', value: '{{password}}' },
        ],
      },
      event: [
        {
          listen: 'test',
          script: { exec: 'pm.test("status", () => pm.response.to.have.status(200));' },
        },
      ],
      item: [
        {
          name: 'Admin',
          item: [
            {
              name: 'Create order',
              variable: [{ key: 'local', value: 'yes' }],
              event: [
                {
                  listen: 'test',
                  script: {
                    exec: ['pm.test("created", () => pm.expect(pm.response.code).to.eql(201));'],
                  },
                },
              ],
              request: {
                method: 'POST',
                description: { content: 'Creates an order' },
                url: {
                  raw: '{{base}}/orders?q=coffee',
                  query: [
                    { key: 'q', value: 'coffee', description: 'Filter' },
                    { key: 'inactive', value: 'yes', disabled: true },
                  ],
                },
                header: [
                  { key: 'X-Trace', value: '{{local}}', description: 'Trace' },
                  { key: 'X-Trace', value: 'duplicate', disabled: true },
                ],
                body: {
                  mode: 'raw',
                  raw: '{"quantity":2}',
                  options: { raw: { language: 'json' } },
                },
              },
            },
          ],
        },
      ],
    },
    { name: 'Health', request: 'https://api.example.test/health' },
  ],
};

function semantic(collection: Collection) {
  const strip = (rows: ReturnType<typeof pair>[]) => rows.map(({ id: _id, ...row }) => row);
  const folderPath = (id?: string): string[] => {
    if (!id) return [];
    const folder = collection.folders.find((f) => f.id === id)!;
    return [...folderPath(folder.parentId), folder.name];
  };
  return {
    name: collection.name,
    description: collection.description,
    auth: collection.auth,
    variables: strip(collection.variables),
    preScript: collection.preScript,
    postScript: collection.postScript,
    folders: collection.folders.map(({ id, parentId: _parent, ...folder }) => ({
      ...folder,
      path: folderPath(id),
    })),
    requests: collection.requests.map(
      ({ id: _id, collectionId: _collection, folderId, ...request }) => ({
        ...request,
        path: folderPath(folderId),
        params: strip(request.params),
        headers: strip(request.headers),
        variables: strip(request.variables),
        body: { ...request.body, fields: strip(request.body.fields) },
      }),
    ),
  };
}

describe('Postman collection interchange', () => {
  it('imports nested folders, inherited auth, disabled fields, descriptions and scripts', () => {
    const result = importText(JSON.stringify(fixture));
    expect(result.warnings).toEqual([]);
    const collection = result.collections[0];
    expect(collection.name).toBe('Orders API');
    expect(collection.description).toBe('Order lifecycle');
    expect(collection.folders[1].parentId).toBe(collection.folders[0].id);
    expect(collection.folders[0].auth).toMatchObject({ type: 'basic', username: 'alice' });
    const request = collection.requests[0];
    expect(request.auth.type).toBe('inherit');
    expect(request.folderId).toBe(collection.folders[1].id);
    expect(request.params[1].enabled).toBe(false);
    expect(request.headers).toHaveLength(2);
    expect(request.headers[0].description).toBe('Trace');
    expect(request.body).toMatchObject({ mode: 'raw', language: 'json', raw: '{"quantity":2}' });
    expect(request.postScript).toContain('created');
    expect(collection.preScript).toContain('\nconsole.log');
    expect(collection.requests[1].method).toBe('GET');
  });

  it('semantically round-trips a common v2.1 collection', () => {
    const first = importText(JSON.stringify(fixture)).collections[0];
    const exported = exportCollection(first);
    const second = importText(JSON.stringify(exported));
    expect(second.warnings).toEqual([]);
    expect(semantic(second.collections[0])).toEqual(semantic(first));
  });

  it('builds a structured URL with query, port, host, and path variable', () => {
    const result = importText(
      JSON.stringify({
        info: { name: 'Structured', schema },
        item: [
          {
            request: {
              url: {
                protocol: 'https',
                host: ['api', 'example', 'test'],
                port: '8443',
                path: ['orders', ':id'],
                variable: [{ key: 'id', value: 42 }],
                query: [
                  { key: 'q', value: '{{query}}' },
                  { key: 'a', value: 'A B' },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(result.collections[0].requests[0]).toMatchObject({
      url: 'https://api.example.test:8443/orders/{{id}}?q={{query}}&a=A%20B',
      variables: [{ key: 'id', value: '42' }],
    });
  });

  it('preserves duplicate raw URL query parameters', () => {
    const result = importText(
      JSON.stringify({
        info: { name: 'Query', schema },
        item: [{ request: 'https://example.test?a=1&a=2&word=hello+world' }],
      }),
    );
    expect(result.collections[0].requests[0].params.map((p) => [p.key, p.value])).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['word', 'hello world'],
    ]);
  });

  it('preserves local secret metadata without emitting an invalid v2.1 variable type', () => {
    const collection = newCollection('Secret metadata');
    collection.variables = [{ ...pair('token', 'sensitive'), secret: true }];
    const exported = exportCollection(collection) as { variable: Record<string, unknown>[] };
    expect(exported.variable[0].type).toBeUndefined();
    expect(exported.variable[0]['x-sendit-secret']).toBe(true);
    expect(importText(JSON.stringify(exported)).collections[0].variables[0].secret).toBe(true);
    exported.variable[0]['x-apiworkbench-secret'] = true;
    delete exported.variable[0]['x-sendit-secret'];
    expect(importText(JSON.stringify(exported)).collections[0].variables[0].secret).toBe(true);
  });

  it('imports protocolProfileBehavior strictSSL=false to disable TLS verification per request', () => {
    const coll = {
      info: { name: 'SSL Test', schema },
      item: [
        {
          name: 'Login Request',
          protocolProfileBehavior: { strictSSL: false },
          request: {
            method: 'POST',
            url: 'https://api.example.test/auth/login',
          },
        },
      ],
    };
    const result = importText(JSON.stringify(coll));
    expect(result.collections[0].requests[0].verifyTls).toBe(false);
  });

  it('inherits protocolProfileBehavior strictSSL=false from collection and folder levels', () => {
    const coll = {
      info: { name: 'Inherited SSL Test', schema },
      protocolProfileBehavior: { strictSSL: false },
      item: [
        {
          name: 'Top level request',
          request: 'https://api.example.test/item1',
        },
        {
          name: 'Folder',
          item: [
            {
              name: 'Nested request',
              request: 'https://api.example.test/item2',
            },
          ],
        },
      ],
    };
    const result = importText(JSON.stringify(coll));
    expect(result.collections[0].requests[0].verifyTls).toBe(false);
    expect(result.collections[0].requests[1].verifyTls).toBe(false);

    // Export preserves protocolProfileBehavior strictSSL: false
    const exported = exportCollection(result.collections[0]) as any;
    const topReq = exported.item.find((i: any) => i.name === 'Top level request');
    expect(topReq.protocolProfileBehavior?.strictSSL).toBe(false);
  });

  it.each(['urlencoded', 'formdata', 'graphql', 'file'])(
    'imports %s bodies without filesystem access',
    (mode) => {
      const body = {
        mode,
        urlencoded: [{ key: 'a', value: 'A B' }],
        formdata: [
          { key: 'text', value: 'value' },
          { key: 'upload', type: 'file', src: 'C:\\private\\credentials.txt' },
        ],
        graphql: { query: 'query { users { id } }', variables: '{"limit":5}' },
        file: { src: 'C:\\private\\credentials.txt' },
      };
      const result = importText(
        JSON.stringify({
          info: { name: 'Bodies', schema },
          item: [{ request: { url: 'https://example.test', body } }],
        }),
      );
      const imported = result.collections[0].requests[0].body;
      if (mode === 'formdata') {
        expect(imported.fields[1]).toMatchObject({ type: 'file', value: '' });
        expect(imported.fields[1].filePath).toBeUndefined();
      }
      if (mode === 'file') expect(imported.filePath).toBeUndefined();
      if (['file', 'formdata'].includes(mode))
        expect(result.warnings.join(' ')).toContain('Select local files again');
      if (mode === 'graphql') expect(imported.graphqlQuery).toBe(body.graphql.query);
      if (mode === 'urlencoded') expect(imported.fields[0].value).toBe('A B');
    },
  );

  it.each(['none', 'basic', 'bearer', 'apikey', 'oauth2', 'digest', 'inherit'] as const)(
    'round-trips %s request auth',
    (type) => {
      const collection = newCollection('Auth');
      const request = newRequest();
      request.auth =
        type === 'basic' || type === 'digest'
          ? { type, username: 'user', password: 'pass' }
          : type === 'bearer'
            ? { type, token: 'token' }
            : type === 'apikey'
              ? { type, key: 'key', value: '{{value}}', addTo: 'query' }
              : type === 'oauth2'
                ? {
                    type,
                    token: 'token',
                    tokenUrl: 'https://example.test/token',
                    clientId: 'id',
                    clientSecret: 'secret',
                    scope: 'read',
                    refreshToken: 'refresh',
                    grantType: 'refresh_token',
                  }
                : { type };
      collection.requests.push(request);
      expect(
        importText(JSON.stringify(exportCollection(collection))).collections[0].requests[0].auth,
      ).toEqual(request.auth);
    },
  );

  it('warns when omitting unsupported features and auth', () => {
    const result = importText(
      JSON.stringify({
        info: { name: 'Warnings', schema },
        protocolProfileBehavior: { disableBodyPruning: true },
        item: [
          {
            request: { url: 'https://example.test', auth: { type: 'awsv4' }, proxy: {} },
            response: [{ code: 200 }],
          },
        ],
      }),
    );
    expect(result.warnings.join(' ')).toMatch(/protocolProfileBehavior.*awsv4.*response.*proxy/);
    expect(result.collections[0].requests[0].auth.type).toBe('none');
  });

  it('omits disabled and external scripts with warnings', () => {
    const result = importText(
      JSON.stringify({
        info: { name: 'Scripts', schema },
        item: [],
        event: [
          { listen: 'test', disabled: true, script: { exec: 'throw 1' } },
          { listen: 'prerequest', script: { src: 'https://example.test/script.js' } },
        ],
      }),
    );
    expect(result.collections[0].postScript).toBe('');
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects unsupported body encodings instead of silently dropping content', () => {
    expect(() =>
      importText(
        JSON.stringify({
          info: { name: 'Unsafe loss', schema },
          item: [{ request: { body: { mode: 'unknown', content: 'important' } } }],
        }),
      ),
    ).toThrow(/body mode/);
  });

  it('rejects orphaned or cyclic folder structures on export', () => {
    const collection = newCollection('Broken');
    collection.folders.push({
      id: 'a',
      name: 'A',
      description: '',
      parentId: 'b',
      auth: { type: 'inherit' },
      preScript: '',
      postScript: '',
    });
    expect(() => exportCollection(collection)).toThrow(/orphaned or cyclic/);
  });
});

describe('environment interchange and import validation', () => {
  it('round-trips environment values, secret metadata and enabled state', () => {
    const first = {
      id: 'old',
      name: 'Staging',
      variables: [
        { ...pair('secret', 'sensitive'), secret: true, enabled: false, description: 'Credential' },
        pair('count', '42'),
      ],
    };
    const imported = importText(JSON.stringify(exportEnvironment(first))).environments[0];
    expect(imported.id).not.toBe(first.id);
    expect(imported.variables.map(({ id: _id, ...value }) => value)).toEqual(
      first.variables.map(({ id: _id, ...value }) => value),
    );
  });

  it.each([
    '',
    '{invalid',
    '[]',
    '{"info":{"name":"old","schema":"https://schema.getpostman.com/json/collection/v1.0.0/collection.json"},"item":[]}',
    '{"__proto__":{"polluted":true}}',
  ])('rejects invalid or unsafe input %s', (text) => {
    expect(() => importText(text)).toThrow();
  });

  it('rejects excessive text and deep objects', () => {
    expect(() => importText('x'.repeat(20 * 1024 * 1024 + 1))).toThrow(/20 MB/);
    expect(() => importText('['.repeat(102) + '0' + ']'.repeat(102))).toThrow(/deeply nested/);
  });

  it('imports UTF-8 BOM JSON and converts non-string variables deterministically', () => {
    const result = importText(
      '\uFEFF' +
        JSON.stringify({
          name: 'Env',
          values: [
            { key: 'count', value: 10 },
            { key: 'config', value: { active: true } },
          ],
        }),
    );
    expect(result.environments[0].variables.map((v) => v.value)).toEqual(['10', '{"active":true}']);
  });
});

describe('cURL import and request snippets', () => {
  it('imports quotes, JSON, duplicate headers, method and Bearer header', () => {
    const result = importText(
      `curl 'https://example.test/orders?q=hello%20world' -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer token' -H 'X-Tag: 1' -H 'X-Tag: 2' --data-raw '{"name":"Order"}'`,
    );
    const request = result.requests[0];
    expect(request.method).toBe('POST');
    expect(request.params[0].value).toBe('hello world');
    expect(request.headers).toHaveLength(4);
    expect(request.body.language).toBe('json');
  });

  it('round-trips literal shell metacharacters safely through POSIX quoting', () => {
    const request = newRequest('Quotes');
    request.method = 'POST';
    request.url = 'https://example.test';
    request.body = {
      mode: 'raw',
      raw: '{"text":"O\u0027Brien; $(whoami) & `test`"}',
      language: 'json',
      fields: [],
    };
    expect(importText(toCurl(request)).requests[0].body.raw).toBe(request.body.raw);
  });

  it('imports basic and digest authentication and attached options', () => {
    const request = importText(
      'curl.exe --digest -ualice:p:a:ss -XPUT -H"X-A: yes" https://example.test',
    ).requests[0];
    expect(request.auth).toEqual({ type: 'digest', username: 'alice', password: 'p:a:ss' });
    expect(request.headers[0].value).toBe('yes');
    expect(request.method).toBe('PUT');
  });

  it('supports --json, long option equals and line continuation', () => {
    const request = importText('curl --url=https://example.test \\\n --json \'{"id":1}\'')
      .requests[0];
    expect(request.method).toBe('POST');
    expect(request.headers.map((h) => [h.key, h.value])).toContainEqual([
      'Accept',
      'application/json',
    ]);
  });

  it('concatenates repeated --json payload pieces without a form separator', () => {
    const request = importText("curl https://example.test --json '{\"id\":' --json '1}'")
      .requests[0];
    expect(request.body.raw).toBe('{"id":1}');
  });

  it('imports URL-encoded fields and --get query data', () => {
    const request = importText(
      "curl -G 'https://example.test?existing=yes' --data-urlencode 'q=coffee & tea' --data-urlencode 'tag=a'",
    ).requests[0];
    expect(request.method).toBe('GET');
    expect(request.body.mode).toBe('none');
    expect(request.url).toBe('https://example.test?existing=yes&q=coffee%20%26%20tea&tag=a');
  });

  it('does not read imported multipart, binary, header or cookie file paths', () => {
    const multipart = importText(
      "curl https://example.test -F 'upload=@C:/secrets.txt' -F 'name=hello' -H '@C:/headers.txt' -b C:/cookies.txt",
    );
    expect(multipart.requests[0].body.fields[0]).toMatchObject({ type: 'file', value: '' });
    expect(multipart.requests[0].body.fields[0].filePath).toBeUndefined();
    expect(multipart.warnings).toHaveLength(3);
    const binary = importText("curl https://example.test --data-binary '@C:/secret.txt'");
    expect(binary.requests[0].body.mode).toBe('binary');
    expect(binary.requests[0].body.filePath).toBeUndefined();
  });

  it('keeps literal @ text when using --data-raw or --form-string', () => {
    expect(importText("curl https://example.test --data-raw '@literal'").requests[0].body.raw).toBe(
      '@literal',
    );
    expect(
      importText("curl https://example.test --form-string 'text=@literal'").requests[0].body
        .fields[0],
    ).toMatchObject({ type: 'text', value: '@literal' });
  });

  it('warns about TLS and unknown options without applying them', () => {
    const result = importText('curl -k --unknown --proxy http://proxy.test https://example.test');
    expect(result.requests[0].url).toBe('https://example.test');
    expect(result.warnings.join(' ')).toMatch(/TLS.*Unsupported.*proxy/);
  });

  it.each([
    'curl https://example.test; whoami',
    'curl "https://example.test/$(whoami)"',
    'curl https://example.test | cmd',
    "curl 'unclosed",
    'curl https://one.test https://two.test',
    'curl --url file:///C:/secret.txt',
    'curl https://example.test -d one -F key=two',
  ])('rejects dangerous or ambiguous command %s', (command) => {
    expect(() => importText(command)).toThrow();
  });

  it('generates cURL with auth, encoded active params and body', () => {
    const request = newRequest();
    request.url = '{{base}}/search?old=1';
    request.params = [pair('q', 'A B'), { ...pair('off', 'value'), enabled: false }];
    request.auth = { type: 'apikey', key: 'api_key', value: '{{key}}', addTo: 'query' };
    request.body.mode = 'urlencoded';
    request.body.fields = [pair('message', "it's fine")];
    const curl = toCurl(request);
    expect(curl).toContain('{{base}}/search?q=A%20B&api_key={{key}}');
    expect(curl).not.toContain('off=');
    expect(importText(curl).requests[0].body.fields[0].value).toBe("it's fine");
  });

  it('generates HTTP request snippets and UTF-8 Basic auth', () => {
    const request = newRequest();
    request.method = 'POST';
    request.url = 'https://example.test';
    request.auth = { type: 'basic', username: 'alice', password: 'pass' };
    request.body = {
      mode: 'graphql',
      raw: '',
      language: 'json',
      fields: [],
      graphqlQuery: '{ health }',
      graphqlVariables: '{}',
    };
    const snippet = toHttp(request);
    expect(snippet).toContain('POST https://example.test HTTP/1.1');
    expect(snippet).toContain('Authorization: Basic YWxpY2U6cGFzcw==');
    expect(snippet).toContain('"query": "{ health }"');
  });

  it('does not claim malformed GraphQL variables are runnable', () => {
    const request = newRequest();
    request.body.mode = 'graphql';
    request.body.graphqlVariables = '{bad';
    expect(() => toCurl(request)).toThrow(/GraphQL variables/);
  });

  it('produces useful local documentation without known header or parameter secrets', () => {
    const collection = newCollection('Documented');
    const request: ApiRequest = newRequest('Read');
    request.url = 'https://example.test?api_key=private';
    request.params = [pair('api_key', 'private')];
    request.headers = [
      pair('Authorization', 'Bearer supersecret'),
      pair('Accept', 'application/json'),
    ];
    request.description = 'Retrieves the account';
    collection.requests.push(request);
    const markdown = toMarkdown(collection);
    expect(markdown).toContain('Retrieves the account');
    expect(markdown).toContain('application/json');
    expect(markdown).not.toContain('private');
    expect(markdown).not.toContain('supersecret');
    expect(markdown).toContain('REDACTED');
  });

  describe('OpenAPI & Swagger (v3 & v2) import and export', () => {
    it('detects OpenAPI and Swagger specifications', () => {
      expect(isOpenApi({ openapi: '3.0.0', info: { title: 'Test' }, paths: {} })).toBe(true);
      expect(isOpenApi({ swagger: '2.0', info: { title: 'Test' }, paths: {} })).toBe(true);
      expect(isOpenApi({ info: { title: 'Test' }, paths: {} })).toBe(true);
      expect(isOpenApi({ info: { name: 'Postman' }, item: [] })).toBe(false);
      expect(isOpenApi({ values: [] })).toBe(false);
    });

    it('imports an OpenAPI 3.0 JSON specification with tags, servers, parameters, bodies, and auth', () => {
      const openApiJson = JSON.stringify({
        openapi: '3.0.3',
        info: {
          title: 'Pet Store API',
          description: 'A sample pet store service',
          version: '1.0.0',
        },
        servers: [{ url: 'https://api.petstore.test/v1', description: 'Production server' }],
        tags: [
          { name: 'Pets', description: 'Pet operations' },
          { name: 'Store', description: 'Store orders' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
            },
            apiKeyHeader: {
              type: 'apiKey',
              name: 'X-API-KEY',
              in: 'header',
            },
          },
          schemas: {
            Pet: {
              type: 'object',
              required: ['id', 'name'],
              properties: {
                id: { type: 'integer', example: 101 },
                name: { type: 'string', example: 'Doggie' },
                status: { type: 'string', enum: ['available', 'pending', 'sold'] },
              },
            },
          },
        },
        security: [{ bearerAuth: [] }],
        paths: {
          '/pets': {
            get: {
              tags: ['Pets'],
              summary: 'List all pets',
              description: 'Returns all pets matching query',
              parameters: [
                {
                  name: 'status',
                  in: 'query',
                  required: false,
                  description: 'Status filter',
                  schema: { type: 'string', default: 'available' },
                },
                {
                  name: 'limit',
                  in: 'query',
                  required: false,
                  schema: { type: 'integer', default: 20 },
                },
              ],
            },
            post: {
              tags: ['Pets'],
              summary: 'Create a pet',
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Pet' },
                  },
                },
              },
            },
          },
          '/pets/{petId}': {
            get: {
              tags: ['Pets'],
              summary: 'Get pet by ID',
              parameters: [
                {
                  name: 'petId',
                  in: 'path',
                  required: true,
                  description: 'The ID of the pet',
                  schema: { type: 'integer', default: 101 },
                },
              ],
              security: [{ apiKeyHeader: [] }],
            },
          },
          '/store/order': {
            post: {
              tags: ['Store'],
              summary: 'Place an order',
              requestBody: {
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      properties: {
                        petId: { type: 'integer', default: 101 },
                        quantity: { type: 'integer', default: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const result = importText(openApiJson);
      expect(result.collections).toHaveLength(1);
      const collection = result.collections[0];
      expect(collection.name).toBe('Pet Store API');
      expect(collection.description).toBe('A sample pet store service');

      // Base URL in variables
      const baseUrlVar = collection.variables.find((v) => v.key === 'baseUrl');
      expect(baseUrlVar).toBeDefined();
      expect(baseUrlVar?.value).toBe('https://api.petstore.test/v1');

      // Global auth
      expect(collection.auth.type).toBe('bearer');
      expect(collection.auth.token).toBe('{{bearerToken}}');

      // Tags -> Folders
      expect(collection.folders).toHaveLength(2);
      const petsFolder = collection.folders.find((f) => f.name === 'Pets');
      const storeFolder = collection.folders.find((f) => f.name === 'Store');
      expect(petsFolder).toBeDefined();
      expect(storeFolder).toBeDefined();

      // Requests
      expect(collection.requests).toHaveLength(4);

      // GET /pets
      const listPetsReq = collection.requests.find((r) => r.name === 'List all pets');
      expect(listPetsReq).toBeDefined();
      expect(listPetsReq?.method).toBe('GET');
      expect(listPetsReq?.url).toBe('{{baseUrl}}/pets');
      expect(listPetsReq?.folderId).toBe(petsFolder?.id);
      expect(listPetsReq?.params).toHaveLength(2);
      expect(listPetsReq?.params[0].key).toBe('status');
      expect(listPetsReq?.params[0].value).toBe('available');

      // POST /pets with JSON body referencing schema
      const createPetReq = collection.requests.find((r) => r.name === 'Create a pet');
      expect(createPetReq).toBeDefined();
      expect(createPetReq?.method).toBe('POST');
      expect(createPetReq?.body.mode).toBe('raw');
      expect(createPetReq?.body.language).toBe('json');
      const bodyParsed = JSON.parse(createPetReq?.body.raw || '{}');
      expect(bodyParsed.id).toBe(101);
      expect(bodyParsed.name).toBe('Doggie');

      // GET /pets/{petId} with path parameter and security override
      const getPetReq = collection.requests.find((r) => r.name === 'Get pet by ID');
      expect(getPetReq).toBeDefined();
      expect(getPetReq?.url).toBe('{{baseUrl}}/pets/:petId');
      expect(getPetReq?.auth.type).toBe('apikey');
      expect(getPetReq?.auth.key).toBe('X-API-KEY');
      expect(getPetReq?.auth.addTo).toBe('header');

      // POST /store/order with urlencoded body
      const orderReq = collection.requests.find((r) => r.name === 'Place an order');
      expect(orderReq).toBeDefined();
      expect(orderReq?.folderId).toBe(storeFolder?.id);
      expect(orderReq?.body.mode).toBe('urlencoded');
      expect(orderReq?.body.fields.some((f) => f.key === 'petId')).toBe(true);
    });

    it('imports an OpenAPI 3.0 specification from YAML text', () => {
      const yamlText = `
openapi: 3.0.0
info:
  title: Users Service
  description: YAML based user management API
  version: 2.1.0
servers:
  - url: https://users.example.com
paths:
  /users:
    get:
      summary: Retrieve all users
      parameters:
        - name: role
          in: query
          schema:
            type: string
            default: admin
`;
      const result = importText(yamlText);
      expect(result.collections).toHaveLength(1);
      const collection = result.collections[0];
      expect(collection.name).toBe('Users Service');
      expect(collection.variables.find((v) => v.key === 'baseUrl')?.value).toBe(
        'https://users.example.com',
      );
      expect(collection.requests).toHaveLength(1);
      expect(collection.requests[0].name).toBe('Retrieve all users');
      expect(collection.requests[0].params[0].key).toBe('role');
      expect(collection.requests[0].params[0].value).toBe('admin');
    });

    it('imports a Swagger 2.0 specification with host, basePath, and parameters', () => {
      const swaggerJson = JSON.stringify({
        swagger: '2.0',
        info: {
          title: 'Legacy Inventory API',
          version: '1.0.0',
        },
        host: 'inventory.legacy.test',
        basePath: '/api/v2',
        schemes: ['https'],
        securityDefinitions: {
          basicAuth: {
            type: 'basic',
          },
        },
        security: [{ basicAuth: [] }],
        paths: {
          '/items': {
            get: {
              summary: 'Get items',
              parameters: [
                {
                  name: 'category',
                  in: 'query',
                  type: 'string',
                  default: 'hardware',
                },
              ],
            },
            post: {
              summary: 'Add item',
              consumes: ['application/json'],
              parameters: [
                {
                  name: 'body',
                  in: 'body',
                  schema: {
                    type: 'object',
                    properties: {
                      sku: { type: 'string', example: 'ITEM-99' },
                      count: { type: 'integer', example: 5 },
                    },
                  },
                },
              ],
            },
          },
        },
      });

      const result = importText(swaggerJson);
      expect(result.collections).toHaveLength(1);
      const collection = result.collections[0];
      expect(collection.name).toBe('Legacy Inventory API');
      expect(collection.variables.find((v) => v.key === 'baseUrl')?.value).toBe(
        'https://inventory.legacy.test/api/v2',
      );
      expect(collection.auth.type).toBe('basic');
      expect(collection.requests).toHaveLength(2);

      const addReq = collection.requests.find((r) => r.name === 'Add item');
      expect(addReq?.body.mode).toBe('raw');
      expect(addReq?.body.raw).toContain('ITEM-99');
    });

    it('exports a collection to a valid OpenAPI 3.0 document', () => {
      const collection = newCollection('Payment Gateway');
      collection.description = 'Processes credit and debit payments';
      collection.variables.push(pair('baseUrl', 'https://pay.example.test/v1'));
      collection.auth = { type: 'bearer', token: '{{token}}' };

      const folder = {
        id: 'f-charges',
        name: 'Charges',
        description: 'Payment transactions',
        auth: { type: 'inherit' as const },
        preScript: '',
        postScript: '',
      };
      collection.folders.push(folder);

      const req1 = newRequest('Create charge');
      req1.method = 'POST';
      req1.url = '{{baseUrl}}/charges';
      req1.folderId = 'f-charges';
      req1.body = {
        mode: 'raw',
        language: 'json',
        raw: JSON.stringify({ amount: 5000, currency: 'USD' }),
        fields: [],
      };
      collection.requests.push(req1);

      const req2 = newRequest('Get charge status');
      req2.method = 'GET';
      req2.url = '{{baseUrl}}/charges/:chargeId';
      req2.folderId = 'f-charges';
      req2.params = [pair('expand', 'customer')];
      collection.requests.push(req2);

      const openapi = exportOpenApi(collection);
      expect(openapi.openapi).toBe('3.0.3');
      expect((openapi.info as any).title).toBe('Payment Gateway');
      expect((openapi.servers as any)[0].url).toBe('https://pay.example.test/v1');
      expect((openapi.tags as any)[0].name).toBe('Charges');

      const paths = openapi.paths as any;
      expect(paths['/charges']).toBeDefined();
      expect(paths['/charges'].post.summary).toBe('Create charge');
      expect(paths['/charges'].post.tags).toEqual(['Charges']);
      expect(paths['/charges'].post.requestBody.content['application/json'].schema.example).toEqual(
        {
          amount: 5000,
          currency: 'USD',
        },
      );

      expect(paths['/charges/{chargeId}']).toBeDefined();
      expect(paths['/charges/{chargeId}'].get.summary).toBe('Get charge status');
      const params = paths['/charges/{chargeId}'].get.parameters;
      expect(params.some((p: any) => p.name === 'chargeId' && p.in === 'path')).toBe(true);
      expect(params.some((p: any) => p.name === 'expand' && p.in === 'query')).toBe(true);
    });

    it('round-trips an exported collection back through importText', () => {
      const collection = newCollection('Roundtrip API');
      collection.variables.push(pair('baseUrl', 'https://roundtrip.test'));
      const req = newRequest('Ping');
      req.method = 'GET';
      req.url = '{{baseUrl}}/ping';
      collection.requests.push(req);

      const openApiObj = exportOpenApi(collection);
      const jsonText = JSON.stringify(openApiObj, null, 2);

      const reimported = importText(jsonText);
      expect(reimported.collections).toHaveLength(1);
      expect(reimported.collections[0].name).toBe('Roundtrip API');
      expect(reimported.collections[0].requests[0].name).toBe('Ping');
      expect(reimported.collections[0].requests[0].url).toBe('{{baseUrl}}/ping');
    });
  });
});
