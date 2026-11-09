import {
  newCollection,
  newRequest,
  pair,
  uid,
  type ApiRequest,
  type Auth,
  type Collection,
  type Environment,
  type ImportResult,
  type Pair,
  type RequestBody,
} from '../shared/models';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

type JsonObject = Record<string, unknown>;
const MAX_IMPORT = 20 * 1024 * 1024;
const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, fallback = ''): string =>
  value === undefined || value === null
    ? fallback
    : typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
const description = (value: unknown): string =>
  typeof value === 'string' ? value : str(object(value).content);
const warning = (warnings: string[], message: string) => {
  if (!warnings.includes(message) && warnings.length < 200) warnings.push(message);
};

function validateJson(root: unknown): void {
  const queue: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    if (++count > 150_000) throw new Error('Import contains too many values (maximum 150,000).');
    if (depth > 100) throw new Error('Import is too deeply nested (maximum 100 JSON levels).');
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new Error(`Unsafe object property in import: ${key}`);
        queue.push({ value: entry, depth: depth + 1 });
      }
    }
  }
}

function unknownFields(
  value: JsonObject,
  allowed: string[],
  warnings: string[],
  context: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      warning(warnings, `${context}: field "${key}" is not supported and was omitted.`);
}

function importPairs(value: unknown, warnings: string[], context: string, files = false): Pair[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((entry) => {
    const row = object(entry);
    if (!Object.hasOwn(row, 'key') && !Object.hasOwn(row, 'id'))
      throw new Error(`${context} contains a row without a key.`);
    const result: Pair = {
      ...pair(str(row.key ?? row.id), str(row.value)),
      enabled: row.disabled !== true && row.enabled !== false,
    };
    if (row.description !== undefined) result.description = description(row.description);
    if (
      row.type === 'secret' ||
      row.secret === true ||
      row['x-sendit-secret'] === true ||
      row['x-apiworkbench-secret'] === true
    )
      result.secret = true;
    if (files) {
      result.type = row.type === 'file' ? 'file' : 'text';
      if (result.type === 'file') {
        result.value = '';
        warning(
          warnings,
          'Imported file references were removed. Select local files again before sending.',
        );
      }
      if (row.contentType)
        warning(warnings, 'Per-part multipart Content-Type overrides are not supported.');
    }
    return result;
  });
}

function importAuth(value: unknown, warnings: string[], inherited = true): Auth {
  if (value === undefined || value === null) return { type: inherited ? 'inherit' : 'none' };
  const source = object(value);
  const kind = str(source.type);
  if (kind === 'noauth') return { type: 'none' };
  const attributes = new Map(
    list(source[kind]).map((entry) => {
      const row = object(entry);
      return [str(row.key), str(row.value)];
    }),
  );
  const get = (key: string) => attributes.get(key) ?? '';
  switch (kind) {
    case 'basic':
    case 'digest':
      return { type: kind, username: get('username'), password: get('password') };
    case 'bearer':
      return { type: 'bearer', token: get('token') };
    case 'apikey':
      return {
        type: 'apikey',
        key: get('key'),
        value: get('value'),
        addTo: get('in') === 'query' ? 'query' : 'header',
      };
    case 'oauth2': {
      const grant = get('grant_type') || get('grantType') || 'client_credentials';
      if (!['client_credentials', 'refresh_token'].includes(grant))
        warning(
          warnings,
          `OAuth grant "${grant}" is unsupported. An existing access token is preserved; configure a supported grant to retrieve new tokens.`,
        );
      return {
        type: 'oauth2',
        token: get('accessToken'),
        tokenUrl: get('accessTokenUrl'),
        clientId: get('clientId'),
        clientSecret: get('clientSecret'),
        scope: get('scope'),
        refreshToken: get('refreshToken'),
        grantType: grant === 'refresh_token' ? 'refresh_token' : 'client_credentials',
      };
    }
    default:
      warning(
        warnings,
        `Authentication "${kind || 'unknown'}" is unsupported and was set to No Auth. Configure authentication before sending.`,
      );
      return { type: 'none' };
  }
}

function importScripts(
  value: unknown,
  warnings: string[],
): { preScript: string; postScript: string } {
  const result = { preScript: '', postScript: '' };
  for (const entry of list(value)) {
    const event = object(entry);
    if (event.disabled === true) {
      warning(warnings, 'Disabled script events were omitted.');
      continue;
    }
    if (event.listen !== 'prerequest' && event.listen !== 'test') {
      warning(warnings, `Script event "${str(event.listen)}" is unsupported.`);
      continue;
    }
    const script = object(event.script);
    if (script.src) warning(warnings, 'External script sources are not imported or fetched.');
    if (script.type && script.type !== 'text/javascript') {
      warning(warnings, `Script language "${str(script.type)}" is unsupported.`);
      continue;
    }
    const code = Array.isArray(script.exec)
      ? script.exec.map((line) => str(line)).join('\n')
      : str(script.exec);
    const target = event.listen === 'prerequest' ? 'preScript' : 'postScript';
    result[target] += (result[target] ? '\n' : '') + code;
  }
  return result;
}

function parseQuery(url: string): Pair[] {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return [];
  const query = url.slice(queryStart + 1).split('#')[0];
  return [...new URLSearchParams(query)].map(([key, value]) => pair(key, value));
}

// Keep variable placeholders readable and resolvable while encoding literal query values.
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/%7B%7B(.*?)%7D%7D/g, '{{$1}}');
function withQuery(url: string, params: Pair[]): string {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const base = (hashIndex >= 0 ? url.slice(0, hashIndex) : url).split('?')[0];
  const query = params
    .filter((p) => p.enabled && p.key)
    .map((p) => `${encode(p.key)}=${encode(p.value)}`)
    .join('&');
  return base + (query ? '?' + query : '') + hash;
}

function importUrl(
  value: unknown,
  warnings: string[],
): { url: string; params: Pair[]; variables: Pair[] } {
  if (typeof value === 'string') return { url: value, params: parseQuery(value), variables: [] };
  const source = object(value);
  const variables = importPairs(source.variable, warnings, 'URL variables');
  let raw = str(source.raw);
  if (!raw) {
    const host = Array.isArray(source.host)
      ? source.host.map((v) => str(v)).join('.')
      : str(source.host);
    const path = Array.isArray(source.path)
      ? source.path.map((v) => (typeof v === 'object' ? str(object(v).value) : str(v))).join('/')
      : str(source.path).replace(/^\//, '');
    raw =
      (source.protocol ? str(source.protocol).replace(/:$/, '') + '://' : '') +
      host +
      (source.port ? ':' + str(source.port) : '') +
      (path ? '/' + path : '') +
      (source.hash ? '#' + str(source.hash) : '');
  }
  // Postman path variables use :id; our resolver uses the common {{id}} syntax.
  for (const variable of variables) {
    const escapedKey = variable.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    raw = raw.replace(
      new RegExp('/:' + escapedKey + '(?=[/?#]|$)', 'g'),
      '/{{' + variable.key + '}}',
    );
  }
  const params =
    source.query !== undefined
      ? importPairs(source.query, warnings, 'Query parameters')
      : parseQuery(raw);
  return { url: source.query !== undefined ? withQuery(raw, params) : raw, params, variables };
}

function importBody(value: unknown, warnings: string[]): RequestBody {
  const source = object(value);
  const result: RequestBody = { mode: 'none', raw: '', language: 'json', fields: [] };
  if (source.disabled === true) {
    warning(warnings, 'A disabled request body was omitted.');
    return result;
  }
  switch (source.mode) {
    case undefined:
      return result;
    case 'raw': {
      result.mode = 'raw';
      result.raw = str(source.raw);
      const language = str(object(object(source.options).raw).language, 'text');
      result.language = ['json', 'xml', 'html', 'javascript'].includes(language)
        ? (language as RequestBody['language'])
        : 'text';
      return result;
    }
    case 'urlencoded':
      result.mode = 'urlencoded';
      result.fields = importPairs(source.urlencoded, warnings, 'URL-encoded body');
      return result;
    case 'formdata':
      result.mode = 'form-data';
      result.fields = importPairs(source.formdata, warnings, 'Multipart body', true);
      return result;
    case 'file':
      result.mode = 'binary';
      warning(
        warnings,
        'Imported file references were removed. Select local files again before sending.',
      );
      return result;
    case 'graphql': {
      result.mode = 'graphql';
      const graphql = object(source.graphql);
      result.graphqlQuery = str(graphql.query);
      result.graphqlVariables = str(graphql.variables, '{}');
      return result;
    }
    default:
      throw new Error(
        `Unsupported request body mode: ${str(source.mode)}. Import cancelled to avoid losing the request body.`,
      );
  }
}

function importCollection(source: JsonObject, warnings: string[]): Collection {
  const info = object(source.info);
  if (!Array.isArray(source.item) || typeof info.name !== 'string')
    throw new Error('A collection must contain info.name and an item array.');
  const schema = str(info.schema);
  if (schema && !/\/v2\.[01]\.\d+\//.test(schema))
    throw new Error('Only Postman collection v2.0 and v2.1 JSON are supported.');
  if (!schema)
    warning(warnings, 'Collection has no schema identifier; imported using the v2.1 layout.');
  const collection = newCollection(info.name);
  collection.description = description(info.description);
  collection.auth = importAuth(source.auth, warnings, false);
  collection.variables = importPairs(source.variable, warnings, 'Collection variables');
  Object.assign(collection, importScripts(source.event, warnings));
  unknownFields(
    source,
    ['info', 'item', 'auth', 'variable', 'event', 'protocolProfileBehavior'],
    warnings,
    'Collection',
  );
  const collectionProtocolProfile = object(source.protocolProfileBehavior);
  if (source.protocolProfileBehavior !== undefined) {
    unknownFields(
      collectionProtocolProfile,
      ['strictSSL', 'disableCertificateVerification'],
      warnings,
      'Collection protocolProfileBehavior',
    );
    if (
      collectionProtocolProfile.strictSSL === false ||
      collectionProtocolProfile.disableCertificateVerification === true
    ) {
      collection.verifyTls = false;
    } else if (collectionProtocolProfile.strictSSL === true) {
      collection.verifyTls = true;
    }
  }
  let itemCount = 0;
  const visit = (
    items: unknown[],
    parentId?: string,
    depth = 0,
    inheritedProfile: Record<string, unknown> = collectionProtocolProfile,
  ): void => {
    if (depth > 40) throw new Error('A collection cannot contain more than 40 folder levels.');
    for (const entry of items) {
      if (++itemCount > 10_000)
        throw new Error('A collection cannot contain more than 10,000 requests and folders.');
      const item = object(entry);
      if (Array.isArray(item.item)) {
        const folderProtocolProfile = {
          ...inheritedProfile,
          ...object(item.protocolProfileBehavior),
        };
        const folder = {
          id: uid(),
          name: str(item.name, 'Untitled folder'),
          description: description(item.description),
          parentId,
          auth: importAuth(item.auth, warnings),
          ...importScripts(item.event, warnings),
          ...(folderProtocolProfile.strictSSL === false ||
          folderProtocolProfile.disableCertificateVerification === true
            ? { verifyTls: false }
            : folderProtocolProfile.strictSSL === true
              ? { verifyTls: true }
              : {}),
        };
        collection.folders.push(folder);
        unknownFields(
          item,
          ['id', 'name', 'description', 'item', 'auth', 'event', 'protocolProfileBehavior'],
          warnings,
          'Folder',
        );
        visit(item.item, folder.id, depth + 1, folderProtocolProfile);
      } else {
        if (
          typeof item.request !== 'string' &&
          (!item.request || typeof item.request !== 'object' || Array.isArray(item.request))
        )
          throw new Error(`Collection item "${str(item.name)}" has no valid request.`);
        const requestSource =
          typeof item.request === 'string' ? { url: item.request } : object(item.request);
        const request = newRequest(str(item.name, 'Untitled request'));
        request.method = str(requestSource.method, 'GET').toUpperCase();
        if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(request.method))
          throw new Error('Request contains an invalid HTTP method.');
        const url = importUrl(requestSource.url, warnings);
        request.url = url.url;
        request.params = url.params;
        request.variables = [
          ...url.variables,
          ...importPairs(item.variable, warnings, 'Request variables'),
        ];
        request.description = description(requestSource.description ?? item.description);
        request.auth = importAuth(requestSource.auth, warnings);
        request.body = importBody(requestSource.body, warnings);
        request.headers =
          typeof requestSource.header === 'string'
            ? parseHeaderLines(requestSource.header)
            : importPairs(requestSource.header, warnings, 'Headers');
        const protocolProfile = {
          ...inheritedProfile,
          ...object(item.protocolProfileBehavior ?? requestSource.protocolProfileBehavior),
        };
        if (
          protocolProfile.strictSSL === false ||
          protocolProfile.disableCertificateVerification === true
        ) {
          request.verifyTls = false;
        } else if (protocolProfile.strictSSL === true) {
          request.verifyTls = true;
        }
        request.collectionId = collection.id;
        request.folderId = parentId;
        Object.assign(request, importScripts(item.event, warnings));
        collection.requests.push(request);
        unknownFields(
          item,
          ['id', 'name', 'description', 'variable', 'event', 'request', 'protocolProfileBehavior'],
          warnings,
          'Request item',
        );
        unknownFields(
          requestSource,
          ['url', 'method', 'description', 'auth', 'body', 'header'],
          warnings,
          'Request',
        );
      }
    }
  };
  visit(source.item);
  return collection;
}

function parseHeaderLines(text: string): Pair[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error('A header must have a name followed by a colon.');
      return pair(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    });
}

export function isOpenApi(source: JsonObject): boolean {
  if (typeof source.openapi === 'string' && source.openapi.startsWith('3.')) return true;
  if (typeof source.swagger === 'string' && source.swagger.startsWith('2.')) return true;
  if (
    source.paths !== undefined &&
    typeof source.paths === 'object' &&
    source.info !== undefined &&
    typeof source.info === 'object'
  ) {
    return true;
  }
  return false;
}

function resolveRef(ref: string, root: JsonObject): JsonObject {
  if (!ref.startsWith('#/')) return {};
  const parts = ref.slice(2).split('/');
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return {};
    current = (current as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return object(current);
}

function generateSchemaExample(
  schemaRaw: unknown,
  root: JsonObject,
  depth = 0,
  visitedRefs = new Set<string>(),
): unknown {
  if (depth > 8 || !schemaRaw || typeof schemaRaw !== 'object') return '';
  let schema = object(schemaRaw);
  if (typeof schema.$ref === 'string') {
    if (visitedRefs.has(schema.$ref)) return {};
    visitedRefs.add(schema.$ref);
    schema = resolveRef(schema.$ref, root);
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  const type = str(schema.type).toLowerCase();
  if (type === 'string') {
    const format = str(schema.format).toLowerCase();
    if (format === 'date-time') return '2026-01-01T00:00:00.000Z';
    if (format === 'date') return '2026-01-01';
    if (format === 'email') return 'user@example.com';
    if (format === 'uri' || format === 'url') return 'https://example.com';
    if (format === 'uuid' || format === 'guid') return '00000000-0000-0000-0000-000000000000';
    if (format === 'binary' || format === 'byte') return 'binary';
    return 'string';
  }
  if (type === 'integer' || type === 'number') {
    return typeof schema.minimum === 'number' ? schema.minimum : 0;
  }
  if (type === 'boolean') {
    return true;
  }
  if (type === 'array') {
    const itemExample = generateSchemaExample(schema.items, root, depth + 1, visitedRefs);
    return itemExample !== undefined ? [itemExample] : [];
  }
  if (type === 'object' || schema.properties) {
    const props = object(schema.properties);
    const result: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(props)) {
      result[propName] = generateSchemaExample(propSchema, root, depth + 1, visitedRefs);
    }
    return result;
  }
  return '';
}

function parseSecurityScheme(schemeObj: JsonObject): Auth | null {
  const type = str(schemeObj.type).toLowerCase();
  if (type === 'http') {
    const scheme = str(schemeObj.scheme).toLowerCase();
    if (scheme === 'bearer') return { type: 'bearer', token: '{{bearerToken}}' };
    if (scheme === 'basic')
      return { type: 'basic', username: '{{username}}', password: '{{password}}' };
  } else if (type === 'basic') {
    return { type: 'basic', username: '{{username}}', password: '{{password}}' };
  } else if (type === 'apikey') {
    const inVal = str(schemeObj.in).toLowerCase();
    const nameVal = str(schemeObj.name, 'api_key');
    return {
      type: 'apikey',
      key: nameVal,
      value: '{{apiKey}}',
      addTo: inVal === 'query' ? 'query' : 'header',
    };
  } else if (type === 'oauth2') {
    return { type: 'oauth2', token: '{{accessToken}}' };
  }
  return null;
}

export function importOpenApi(source: JsonObject, warnings: string[]): Collection {
  const info = object(source.info);
  const name = str(info.title, 'OpenAPI Collection').trim() || 'OpenAPI Collection';
  const collection = newCollection(name);
  collection.description = description(info.description);

  // Extract Base URL
  const servers = list(source.servers);
  let baseUrl = '';
  if (servers.length) {
    const firstServer = object(servers[0]);
    let rawUrl = str(firstServer.url, '');
    const vars = object(firstServer.variables);
    for (const [k, v] of Object.entries(vars)) {
      const defaultVal = str(object(v).default, '');
      rawUrl = rawUrl.replace(new RegExp(`\\{${k}\\}`, 'g'), defaultVal);
    }
    baseUrl = rawUrl;
  } else if (source.host) {
    const schemes = list(source.schemes);
    const scheme = schemes.length ? str(schemes[0], 'https') : 'https';
    const host = str(source.host, 'api.example.com');
    const basePath = str(source.basePath, '');
    const cleanBasePath = basePath.startsWith('/') ? basePath : basePath ? `/${basePath}` : '';
    baseUrl = `${scheme}://${host}${cleanBasePath}`;
  }

  if (baseUrl) {
    baseUrl = baseUrl.replace(/\/+$/, '');
    collection.variables.push(pair('baseUrl', baseUrl));
  }

  // Security definitions
  const components = object(source.components);
  const secSchemes = object(components.securitySchemes || source.securityDefinitions);

  const globalSec = list(source.security);
  if (globalSec.length) {
    const firstSec = object(globalSec[0]);
    const firstKey = Object.keys(firstSec)[0];
    if (firstKey && secSchemes[firstKey]) {
      const parsedAuth = parseSecurityScheme(object(secSchemes[firstKey]));
      if (parsedAuth) collection.auth = parsedAuth;
    }
  }

  // Tags -> Folders
  const tagMap = new Map<string, string>();
  for (const tagItem of list(source.tags)) {
    const tagObj = object(tagItem);
    const tagName = str(tagObj.name).trim();
    if (tagName && !tagMap.has(tagName)) {
      const folderId = uid();
      tagMap.set(tagName, folderId);
      collection.folders.push({
        id: folderId,
        name: tagName,
        description: description(tagObj.description),
        auth: { type: 'inherit' },
        preScript: '',
        postScript: '',
      });
    }
  }

  // Paths & Operations
  const paths = object(source.paths);
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'] as const;

  for (const [pathKey, pathItemRaw] of Object.entries(paths)) {
    if (pathKey.startsWith('x-')) continue;
    let pathObj = object(pathItemRaw);
    if (typeof pathObj.$ref === 'string') {
      pathObj = resolveRef(pathObj.$ref, source);
    }
    const pathParams = list(pathObj.parameters);

    for (const method of methods) {
      const opRaw = pathObj[method];
      if (!opRaw || typeof opRaw !== 'object') continue;
      const op = object(opRaw);

      const req = newRequest();
      req.method = method.toUpperCase();
      req.name = str(op.summary || op.operationId || `${req.method} ${pathKey}`).trim();
      req.description = description(op.description);
      req.collectionId = collection.id;

      // Group into folder by tag
      const opTags = list(op.tags);
      if (opTags.length) {
        const firstTag = str(opTags[0]).trim();
        if (firstTag) {
          if (!tagMap.has(firstTag)) {
            const folderId = uid();
            tagMap.set(firstTag, folderId);
            collection.folders.push({
              id: folderId,
              name: firstTag,
              description: '',
              auth: { type: 'inherit' },
              preScript: '',
              postScript: '',
            });
          }
          req.folderId = tagMap.get(firstTag);
        }
      }

      // Format URL: convert {param} to :param
      const cleanPath = pathKey.startsWith('/') ? pathKey : `/${pathKey}`;
      const normalizedPath = cleanPath.replace(/\{([^}]+)\}/g, ':$1');
      req.url = baseUrl ? `{{baseUrl}}${normalizedPath}` : normalizedPath;

      // Parameters
      const allParams = [...pathParams, ...list(op.parameters)];
      const seenParam = new Set<string>();

      for (const pRaw of allParams) {
        let p = object(pRaw);
        if (typeof p.$ref === 'string') {
          p = resolveRef(p.$ref, source);
        }
        const pName = str(p.name).trim();
        const pIn = str(p.in).toLowerCase();
        if (!pName) continue;
        const pKey = `${pIn}:${pName}`;
        if (seenParam.has(pKey)) continue;
        seenParam.add(pKey);

        let pVal = '';
        if (p.example !== undefined) pVal = str(p.example);
        else if (p.default !== undefined) pVal = str(p.default);
        else if (p.schema && typeof p.schema === 'object') {
          const pSchema = object(p.schema);
          if (pSchema.example !== undefined) pVal = str(pSchema.example);
          else if (pSchema.default !== undefined) pVal = str(pSchema.default);
        }
        const pDesc = description(p.description);

        if (pIn === 'query') {
          req.params.push({
            id: uid(),
            key: pName,
            value: pVal,
            description: pDesc,
            enabled: p.required !== false,
          });
        } else if (pIn === 'header') {
          if (!['authorization', 'content-type', 'accept'].includes(pName.toLowerCase())) {
            req.headers.push({
              id: uid(),
              key: pName,
              value: pVal,
              description: pDesc,
              enabled: p.required !== false,
            });
          }
        } else if (pIn === 'path') {
          req.variables.push({
            id: uid(),
            key: pName,
            value: pVal || '1',
            description: pDesc,
            enabled: true,
          });
        } else if (pIn === 'body') {
          // Swagger 2 body parameter
          const schema = p.schema ? object(p.schema) : {};
          const ex = generateSchemaExample(schema, source);
          req.body = {
            mode: 'raw',
            raw: typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2),
            fields: [],
            language: 'json',
          };
          if (!req.headers.some((h) => h.key.toLowerCase() === 'content-type')) {
            req.headers.push(pair('Content-Type', 'application/json'));
          }
        } else if (pIn === 'formdata') {
          // Swagger 2 formData parameter
          const consumes = list(op.consumes || source.consumes).map(String);
          const isMultipart = consumes.some((c) => c.includes('multipart'));
          req.body.mode = isMultipart ? 'form-data' : 'urlencoded';
          req.body.fields.push({
            id: uid(),
            key: pName,
            value: pVal,
            description: pDesc,
            enabled: p.required !== false,
            type: str(p.type) === 'file' ? 'file' : 'text',
          });
        }
      }

      // OpenAPI 3 requestBody
      if (op.requestBody && typeof op.requestBody === 'object') {
        let rb = object(op.requestBody);
        if (typeof rb.$ref === 'string') {
          rb = resolveRef(rb.$ref, source);
        }
        const content = object(rb.content);
        if (content['application/json']) {
          const jsonContent = object(content['application/json']);
          const schema = jsonContent.schema ? object(jsonContent.schema) : {};
          const ex =
            jsonContent.example !== undefined
              ? jsonContent.example
              : generateSchemaExample(schema, source);
          req.body = {
            mode: 'raw',
            raw: typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2),
            fields: [],
            language: 'json',
          };
          if (!req.headers.some((h) => h.key.toLowerCase() === 'content-type')) {
            req.headers.push(pair('Content-Type', 'application/json'));
          }
        } else if (content['application/x-www-form-urlencoded']) {
          const formContent = object(content['application/x-www-form-urlencoded']);
          const schema = formContent.schema ? object(formContent.schema) : {};
          const props = object(schema.properties);
          req.body.mode = 'urlencoded';
          for (const [fName, fSchema] of Object.entries(props)) {
            const val = generateSchemaExample(fSchema, source);
            req.body.fields.push(pair(fName, str(val)));
          }
        } else if (content['multipart/form-data']) {
          const formContent = object(content['multipart/form-data']);
          const schema = formContent.schema ? object(formContent.schema) : {};
          const props = object(schema.properties);
          req.body.mode = 'form-data';
          for (const [fName, fSchema] of Object.entries(props)) {
            const fObj = object(fSchema);
            const isFile =
              str(fObj.format) === 'binary' ||
              (str(fObj.type) === 'string' && str(fObj.format) === 'binary');
            const val = generateSchemaExample(fSchema, source);
            req.body.fields.push({
              id: uid(),
              key: fName,
              value: isFile ? '' : str(val),
              enabled: true,
              type: isFile ? 'file' : 'text',
            });
          }
        } else {
          const firstType = Object.keys(content)[0];
          if (firstType) {
            const cObj = object(content[firstType]);
            const ex =
              cObj.example !== undefined
                ? cObj.example
                : generateSchemaExample(cObj.schema, source);
            req.body = {
              mode: 'raw',
              raw: typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2),
              fields: [],
              language: firstType.includes('json')
                ? 'json'
                : firstType.includes('xml')
                  ? 'xml'
                  : firstType.includes('html')
                    ? 'html'
                    : 'text',
            };
            if (!req.headers.some((h) => h.key.toLowerCase() === 'content-type')) {
              req.headers.push(pair('Content-Type', firstType));
            }
          }
        }
      }

      // Security override per operation
      if (op.security && Array.isArray(op.security)) {
        if (op.security.length === 0) {
          req.auth = { type: 'none' };
        } else {
          const opFirstSec = object(op.security[0]);
          const opFirstKey = Object.keys(opFirstSec)[0];
          if (opFirstKey && secSchemes[opFirstKey]) {
            const parsed = parseSecurityScheme(object(secSchemes[opFirstKey]));
            if (parsed) req.auth = parsed;
          }
        }
      }

      collection.requests.push(req);
    }
  }

  return collection;
}

/** Import data only: never executes shell code, fetches remote content, or opens file references. */
export function importText(text: string): ImportResult {
  if (text.length > MAX_IMPORT) throw new Error('Import exceeds the 20 MB text limit.');
  const sourceText = text.replace(/^\uFEFF/, '').trim();
  if (!sourceText)
    throw new Error(
      'Paste an OpenAPI specification, Postman collection, environment, or cURL command.',
    );
  const result: ImportResult = { collections: [], environments: [], requests: [], warnings: [] };
  if (/^curl(?:\.exe)?(?:\s|$)/i.test(sourceText)) {
    result.requests.push(importCurl(sourceText, result.warnings));
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    try {
      parsed = yamlLoad(sourceText, { json: true });
    } catch {
      throw new Error('Import must be valid JSON, YAML, or a cURL command.');
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Import content must be an object.');
  }
  validateJson(parsed);
  const source = object(parsed);
  if (isOpenApi(source)) {
    result.collections.push(importOpenApi(source, result.warnings));
  } else if (source.info && source.item) {
    result.collections.push(importCollection(source, result.warnings));
  } else if (Array.isArray(source.values) && typeof source.name === 'string') {
    result.environments.push({
      id: uid(),
      name: source.name,
      variables: importPairs(source.values, result.warnings, 'Environment variables'),
    });
    if (source._postman_variable_scope === 'globals')
      warning(
        result.warnings,
        'Globals were imported as an environment. Copy values into Global variables if required.',
      );
    unknownFields(
      source,
      [
        'id',
        'name',
        'values',
        '_postman_variable_scope',
        '_postman_exported_at',
        '_postman_exported_using',
        'color',
      ],
      result.warnings,
      'Environment',
    );
  } else
    throw new Error(
      'Content is not a recognized OpenAPI specification, Postman collection, or environment.',
    );
  return result;
}

function exportPairs(rows: Pair[], environment = false): JsonObject[] {
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    ...(environment
      ? { enabled: row.enabled, type: row.secret ? 'secret' : 'default' }
      : { disabled: !row.enabled, ...(row.secret ? { 'x-sendit-secret': true } : {}) }),
    ...(row.description ? { description: row.description } : {}),
  }));
}

function exportAuth(auth: Auth): JsonObject | undefined {
  if (auth.type === 'inherit') return undefined;
  if (auth.type === 'none') return { type: 'noauth' };
  let values: Record<string, string | undefined> = {};
  switch (auth.type) {
    case 'basic':
    case 'digest':
      values = { username: auth.username, password: auth.password };
      break;
    case 'bearer':
      values = { token: auth.token };
      break;
    case 'apikey':
      values = { key: auth.key, value: auth.value, in: auth.addTo ?? 'header' };
      break;
    case 'oauth2':
      values = {
        accessToken: auth.token,
        accessTokenUrl: auth.tokenUrl,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        scope: auth.scope,
        refreshToken: auth.refreshToken,
        grant_type: auth.grantType,
      };
      break;
  }
  return {
    type: auth.type,
    [auth.type]: Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ key, value, type: 'string' })),
  };
}

function exportScripts(source: { preScript: string; postScript: string }): JsonObject[] {
  return [
    ['prerequest', source.preScript],
    ['test', source.postScript],
  ]
    .filter(([, code]) => code)
    .map(([listen, code]) => ({
      listen,
      script: { type: 'text/javascript', exec: code.split('\n') },
    }));
}

function exportBody(body: RequestBody): JsonObject | undefined {
  switch (body.mode) {
    case 'none':
      return undefined;
    case 'raw':
      return { mode: 'raw', raw: body.raw, options: { raw: { language: body.language } } };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: exportPairs(body.fields) };
    case 'form-data':
      return {
        mode: 'formdata',
        formdata: body.fields.map((row) => ({
          key: row.key,
          disabled: !row.enabled,
          description: row.description,
          type: row.type === 'file' ? 'file' : 'text',
          ...(row.type === 'file' ? { src: row.filePath ?? '' } : { value: row.value }),
        })),
      };
    case 'binary':
      return { mode: 'file', file: { src: body.filePath ?? '' } };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: { query: body.graphqlQuery ?? '', variables: body.graphqlVariables ?? '{}' },
      };
  }
}

export function exportCollection(collection: Collection): object {
  const seen = new Set<string>();
  const items = (parentId?: string, depth = 0): JsonObject[] => {
    if (depth > 40) throw new Error('Collection folder hierarchy is too deep.');
    const folders = collection.folders
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => {
        if (seen.has(folder.id))
          throw new Error('Collection folder hierarchy contains duplicate IDs or a cycle.');
        seen.add(folder.id);
        return {
          id: folder.id,
          name: folder.name,
          description: folder.description,
          ...(folder.verifyTls === false
            ? { protocolProfileBehavior: { strictSSL: false } }
            : folder.verifyTls === true
              ? { protocolProfileBehavior: { strictSSL: true } }
              : {}),
          auth: exportAuth(folder.auth),
          event: exportScripts(folder),
          item: items(folder.id, depth + 1),
        };
      });
    const requests = collection.requests
      .filter((request) => request.folderId === parentId)
      .map((request) => ({
        id: request.id,
        name: request.name,
        ...(request.verifyTls === false
          ? { protocolProfileBehavior: { strictSSL: false } }
          : request.verifyTls === true
            ? { protocolProfileBehavior: { strictSSL: true } }
            : {}),
        variable: exportPairs(request.variables),
        event: exportScripts(request),
        request: {
          method: request.method,
          description: request.description,
          url: {
            raw: withQuery(
              request.url,
              request.params.length ? request.params : parseQuery(request.url),
            ),
            query: exportPairs(request.params.length ? request.params : parseQuery(request.url)),
          },
          header: exportPairs(request.headers),
          auth: exportAuth(request.auth),
          body: exportBody(request.body),
        },
      }));
    return [...folders, ...requests];
  };
  const item = items();
  if (
    seen.size !== collection.folders.length ||
    collection.requests.some((request) => request.folderId && !seen.has(request.folderId))
  )
    throw new Error(
      'Collection contains orphaned or cyclic folders. Repair the hierarchy before exporting.',
    );
  return {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      description: collection.description,
      schema: SCHEMA,
    },
    ...(collection.verifyTls === false
      ? { protocolProfileBehavior: { strictSSL: false } }
      : collection.verifyTls === true
        ? { protocolProfileBehavior: { strictSSL: true } }
        : {}),
    auth: exportAuth(collection.auth),
    variable: exportPairs(collection.variables),
    event: exportScripts(collection),
    item,
  };
}

export function exportEnvironment(environment: Environment): object {
  return {
    id: environment.id,
    name: environment.name,
    values: exportPairs(environment.variables, true),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'SendIt!/1.0',
  };
}

export function exportOpenApi(collection: Collection): JsonObject {
  const openapi: JsonObject = {
    openapi: '3.0.3',
    info: {
      title: collection.name || 'API',
      description: collection.description || undefined,
      version: '1.0.0',
    },
  };

  const baseVar = collection.variables.find((v) => v.enabled && v.key === 'baseUrl');
  let baseUrl = baseVar?.value?.trim() || '';
  if (!baseUrl) {
    for (const req of collection.requests) {
      if (/^https?:\/\//i.test(req.url)) {
        try {
          const u = new URL(req.url);
          baseUrl = u.origin;
          break;
        } catch {}
      }
    }
  }

  if (baseUrl) {
    openapi.servers = [{ url: baseUrl, description: 'Default server' }];
  }

  const folderMap = new Map<string, string>();
  const tags: JsonObject[] = [];
  for (const folder of collection.folders) {
    folderMap.set(folder.id, folder.name);
    tags.push({
      name: folder.name,
      description: folder.description || undefined,
    });
  }
  if (tags.length) {
    openapi.tags = tags;
  }

  const securitySchemes: JsonObject = {};
  if (collection.auth.type === 'bearer') {
    securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer' };
    openapi.security = [{ bearerAuth: [] }];
  } else if (collection.auth.type === 'basic') {
    securitySchemes.basicAuth = { type: 'http', scheme: 'basic' };
    openapi.security = [{ basicAuth: [] }];
  } else if (collection.auth.type === 'apikey') {
    securitySchemes.apiKeyAuth = {
      type: 'apiKey',
      name: collection.auth.key || 'api_key',
      in: collection.auth.addTo === 'query' ? 'query' : 'header',
    };
    openapi.security = [{ apiKeyAuth: [] }];
  }

  const paths: JsonObject = {};

  for (const req of collection.requests) {
    let rawPath = req.url;
    if (rawPath.startsWith('{{baseUrl}}')) {
      rawPath = rawPath.replace('{{baseUrl}}', '');
    } else if (baseUrl && rawPath.startsWith(baseUrl)) {
      rawPath = rawPath.slice(baseUrl.length);
    } else if (/^https?:\/\/[^/]+/i.test(rawPath)) {
      rawPath = rawPath.replace(/^https?:\/\/[^/]+/i, '');
    }
    rawPath = rawPath.split('?')[0];
    if (!rawPath.startsWith('/')) rawPath = '/' + rawPath;

    const openApiPath = rawPath
      .replace(/:([a-zA-Z0-9_-]+)/g, '{$1}')
      .replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, '{$1}');

    if (!paths[openApiPath]) paths[openApiPath] = {};
    const pathItem = paths[openApiPath] as JsonObject;

    const method = req.method.toLowerCase();
    const operation: JsonObject = {
      summary: req.name,
      description: req.description || undefined,
      responses: {
        '200': {
          description: 'Successful response',
        },
      },
    };

    if (req.folderId && folderMap.has(req.folderId)) {
      operation.tags = [folderMap.get(req.folderId)!];
    }

    const parameters: JsonObject[] = [];

    const pathMatches = [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const p of pathMatches) {
      parameters.push({
        name: p,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }

    for (const q of req.params) {
      if (q.key) {
        parameters.push({
          name: q.key,
          in: 'query',
          required: false,
          description: q.description || undefined,
          schema: { type: 'string', default: q.value || undefined },
        });
      }
    }

    for (const h of req.headers) {
      if (h.key && !['authorization', 'content-type', 'accept'].includes(h.key.toLowerCase())) {
        parameters.push({
          name: h.key,
          in: 'header',
          required: false,
          description: h.description || undefined,
          schema: { type: 'string', default: h.value || undefined },
        });
      }
    }

    if (parameters.length) {
      operation.parameters = parameters;
    }

    if (['post', 'put', 'patch'].includes(method)) {
      if (req.body.mode === 'raw' && req.body.raw.trim()) {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(req.body.raw);
        } catch {}
        if (parsedJson !== undefined) {
          operation.requestBody = {
            content: {
              'application/json': {
                schema: { type: 'object', example: parsedJson },
              },
            },
          };
        } else {
          operation.requestBody = {
            content: {
              'text/plain': {
                schema: { type: 'string', example: req.body.raw },
              },
            },
          };
        }
      } else if (req.body.mode === 'urlencoded' && req.body.fields.length) {
        const props: JsonObject = {};
        for (const f of req.body.fields) {
          if (f.key) props[f.key] = { type: 'string', default: f.value || undefined };
        }
        operation.requestBody = {
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties: props },
            },
          },
        };
      } else if (req.body.mode === 'form-data' && req.body.fields.length) {
        const props: JsonObject = {};
        for (const f of req.body.fields) {
          if (f.key) {
            props[f.key] =
              f.type === 'file'
                ? { type: 'string', format: 'binary' }
                : { type: 'string', default: f.value || undefined };
          }
        }
        operation.requestBody = {
          content: {
            'multipart/form-data': {
              schema: { type: 'object', properties: props },
            },
          },
        };
      }
    }

    if (req.auth && req.auth.type !== 'inherit') {
      if (req.auth.type === 'none') {
        operation.security = [];
      } else if (req.auth.type === 'bearer') {
        securitySchemes.bearerAuth = { type: 'http', scheme: 'bearer' };
        operation.security = [{ bearerAuth: [] }];
      } else if (req.auth.type === 'basic') {
        securitySchemes.basicAuth = { type: 'http', scheme: 'basic' };
        operation.security = [{ basicAuth: [] }];
      } else if (req.auth.type === 'apikey') {
        securitySchemes.apiKeyAuth = {
          type: 'apiKey',
          name: req.auth.key || 'api_key',
          in: req.auth.addTo === 'query' ? 'query' : 'header',
        };
        operation.security = [{ apiKeyAuth: [] }];
      }
    }

    pathItem[method] = operation;
  }

  openapi.paths = paths;
  if (Object.keys(securitySchemes).length) {
    openapi.components = { securitySchemes };
  }

  return openapi;
}

function tokenizeCurl(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  let started = false;
  command = command.replace(/\\\r?\n|\^\r?\n|`\r?\n/g, '');
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = '';
      else token += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) token += command[++i];
      else {
        if (char === '`' || (char === '$' && command[i + 1] === '('))
          throw new Error('Shell substitutions are not supported. Paste literal values.');
        token += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else if (char === '\\') {
      if (i + 1 >= command.length) throw new Error('Incomplete escape in cURL command.');
      token += command[++i];
      started = true;
    } else {
      if (/[;|&<>`]/.test(char) || (char === '$' && command[i + 1] === '('))
        throw new Error(
          'Shell operators and substitutions are not supported. Quote URLs and values containing special characters.',
        );
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in cURL command.');
  if (started) tokens.push(token);
  return tokens;
}

function importCurl(text: string, warnings: string[]): ApiRequest {
  const tokens = tokenizeCurl(text);
  const request = newRequest('Imported cURL request');
  request.auth = { type: 'none' };
  const data: string[] = [];
  const encoded: Pair[] = [];
  const form: Pair[] = [];
  let explicitMethod = false;
  let useGet = false;
  let digest = false;
  let json = false;
  let bodyKind = '';
  let binary = false;
  let rawOption = '';
  const setBodyKind = (kind: string) => {
    if (bodyKind && bodyKind !== kind)
      throw new Error('Mixed cURL body encodings are not supported. Use a single body encoding.');
    bodyKind = kind;
  };
  for (let i = 1; i < tokens.length; i++) {
    let option = tokens[i];
    let attached: string | undefined;
    if (option.startsWith('--') && option.includes('=')) {
      const equals = option.indexOf('=');
      attached = option.slice(equals + 1);
      option = option.slice(0, equals);
    } else if (/^-[XHduFAbe]/.test(option) && option.length > 2) {
      attached = option.slice(2);
      option = option.slice(0, 2);
    }
    const take = (): string => {
      if (attached !== undefined) return attached;
      if (i + 1 >= tokens.length) throw new Error(`Missing value for ${option}.`);
      return tokens[++i];
    };
    switch (option) {
      case '-X':
      case '--request':
        request.method = take().toUpperCase();
        explicitMethod = true;
        break;
      case '--url':
        if (request.url) throw new Error('Only one cURL URL can be imported at a time.');
        request.url = take();
        break;
      case '-H':
      case '--header': {
        const header = take();
        if (header.startsWith('@')) {
          warning(warnings, 'Header files were not read. Enter headers manually.');
          break;
        }
        request.headers.push(...parseHeaderLines(header));
        break;
      }
      case '-u':
      case '--user': {
        const credentials = take();
        const colon = credentials.indexOf(':');
        request.auth = {
          type: 'basic',
          username: colon < 0 ? credentials : credentials.slice(0, colon),
          password: colon < 0 ? '' : credentials.slice(colon + 1),
        };
        break;
      }
      case '--oauth2-bearer':
        request.auth = { type: 'bearer', token: take() };
        break;
      case '--digest':
        digest = true;
        break;
      case '--basic':
        digest = false;
        break;
      case '-I':
      case '--head':
        request.method = 'HEAD';
        explicitMethod = true;
        break;
      case '-G':
      case '--get':
        useGet = true;
        break;
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--json': {
        setBodyKind('raw');
        const value = take();
        if (rawOption && (option === '--json') !== (rawOption === '--json'))
          throw new Error(
            'Mixing --json with other cURL data options is not supported. Use one data encoding.',
          );
        rawOption = option;
        if (option !== '--data-raw' && value.startsWith('@')) {
          binary = true;
          warning(
            warnings,
            'Imported file references were removed. Select local files again before sending.',
          );
        } else data.push(value);
        if (option === '--json') json = true;
        break;
      }
      case '--data-urlencode': {
        setBodyKind('urlencoded');
        const value = take();
        const equals = value.indexOf('=');
        if ((equals < 0 && value.includes('@')) || value.startsWith('@')) {
          warning(
            warnings,
            'File-based URL-encoded data was omitted. Enter the field value manually.',
          );
          break;
        }
        if (equals <= 0)
          throw new Error('cURL --data-urlencode requires name=value for editable form fields.');
        encoded.push(pair(value.slice(0, equals), value.slice(equals + 1)));
        break;
      }
      case '-F':
      case '--form':
      case '--form-string': {
        setBodyKind('form');
        const value = take();
        const equals = value.indexOf('=');
        if (equals < 0) throw new Error('Multipart fields must use name=value.');
        const field = pair(value.slice(0, equals), value.slice(equals + 1));
        field.type = 'text';
        if (option !== '--form-string' && /^[<@]/.test(field.value)) {
          field.type = 'file';
          field.value = '';
          warning(
            warnings,
            'Imported file references were removed. Select local files again before sending.',
          );
        } else if (option !== '--form-string' && /;(?:type|filename|headers)=/.test(field.value)) {
          field.value = field.value.split(';')[0];
          warning(
            warnings,
            'Multipart Content-Type, filename, and header overrides are not supported.',
          );
        }
        form.push(field);
        break;
      }
      case '-A':
      case '--user-agent':
        request.headers.push(pair('User-Agent', take()));
        break;
      case '-e':
      case '--referer':
        request.headers.push(pair('Referer', take()));
        break;
      case '-b':
      case '--cookie': {
        const cookie = take();
        if (cookie.includes('=')) request.headers.push(pair('Cookie', cookie));
        else warning(warnings, 'Cookie files were not read. Configure cookies in Cookie manager.');
        break;
      }
      case '-k':
      case '--insecure':
        warning(
          warnings,
          'cURL insecure TLS option was not applied. TLS verification remains enabled in application settings.',
        );
        break;
      case '-L':
      case '--location':
        warning(warnings, 'Redirects use the application setting.');
        break;
      case '--compressed':
      case '-s':
      case '--silent':
      case '-S':
      case '--show-error':
      case '-v':
      case '--verbose':
      case '-i':
      case '--include':
        break;
      case '--connect-timeout':
      case '--max-time':
      case '--proxy':
      case '-x':
      case '--cert':
      case '--key':
      case '--cacert':
      case '--output':
      case '-o':
      case '--cookie-jar':
      case '-c':
      case '--user-agent-config':
        take();
        warning(
          warnings,
          `cURL option ${option} was not applied. Configure any corresponding application setting manually.`,
        );
        break;
      default:
        if (option.startsWith('-'))
          warning(warnings, `Unsupported cURL option ${option} was ignored.`);
        else if (/^(?:https?:\/\/|\{\{)/i.test(option)) {
          if (request.url) throw new Error('Only one cURL URL can be imported at a time.');
          request.url = option;
        } else
          warning(
            warnings,
            'An unrecognized cURL argument was ignored. Only explicit HTTP(S) URLs are accepted.',
          );
    }
  }
  if (!request.url)
    throw new Error('cURL command must contain an HTTP(S) URL or a {{variable}} URL.');
  if (!/^(?:https?:\/\/|\{\{)/i.test(request.url))
    throw new Error('Only HTTP(S) URLs and variable URLs can be imported.');
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(request.method)) throw new Error('Invalid HTTP method.');
  if (digest && request.auth.type === 'basic') request.auth.type = 'digest';
  request.params = parseQuery(request.url);
  if (useGet) {
    if (binary || form.length)
      throw new Error('File or multipart data cannot be imported with cURL --get.');
    request.params.push(...encoded, ...parseQuery('?' + data.join('&')));
    request.url = withQuery(request.url, request.params);
  } else if (bodyKind) {
    if (!explicitMethod) request.method = 'POST';
    if (binary && data.length)
      throw new Error('Mixed literal and file request bodies are not supported.');
    if (binary) request.body.mode = 'binary';
    else if (bodyKind === 'form') {
      request.body.mode = 'form-data';
      request.body.fields = form;
    } else if (bodyKind === 'urlencoded') {
      request.body.mode = 'urlencoded';
      request.body.fields = encoded;
    } else {
      request.body.mode = 'raw';
      request.body.raw = data.join(json ? '' : '&');
      request.body.language =
        json ||
        request.headers.some((h) => h.key.toLowerCase() === 'content-type' && /json/i.test(h.value))
          ? 'json'
          : 'text';
    }
    if (bodyKind === 'raw' && !request.headers.some((h) => h.key.toLowerCase() === 'content-type'))
      request.headers.push(
        pair('Content-Type', json ? 'application/json' : 'application/x-www-form-urlencoded'),
      );
    if (json && !request.headers.some((h) => h.key.toLowerCase() === 'accept'))
      request.headers.push(pair('Accept', 'application/json'));
  }
  return request;
}

const quoteShell = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const active = (rows: Pair[]) => rows.filter((row) => row.enabled && row.key);
function snippetParts(request: ApiRequest): { url: string; headers: Pair[] } {
  const params = request.params.length ? [...request.params] : parseQuery(request.url);
  const headers = active(request.headers).map((row) => ({ ...row }));
  const auth = request.auth;
  if (auth.type === 'apikey' && auth.key) {
    if (auth.addTo === 'query') params.push(pair(auth.key, auth.value ?? ''));
    else headers.push(pair(auth.key, auth.value ?? ''));
  } else if (auth.type === 'bearer' || auth.type === 'oauth2')
    headers.push(pair('Authorization', 'Bearer ' + (auth.token ?? '')));
  const contentTypes: Record<string, string> = {
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript',
  };
  const contentType =
    request.body.mode === 'raw'
      ? contentTypes[request.body.language]
      : request.body.mode === 'graphql'
        ? 'application/json'
        : request.body.mode === 'urlencoded'
          ? 'application/x-www-form-urlencoded'
          : '';
  if (contentType && !headers.some((h) => h.key.toLowerCase() === 'content-type'))
    headers.push(pair('Content-Type', contentType));
  return { url: withQuery(request.url, params), headers };
}

export function toCurl(request: ApiRequest): string {
  const { url, headers } = snippetParts(request);
  const parts = ['curl --request ' + quoteShell(request.method), '--url ' + quoteShell(url)];
  for (const header of headers)
    parts.push('--header ' + quoteShell(header.key + ': ' + header.value));
  if (request.auth.type === 'basic' || request.auth.type === 'digest') {
    if (request.auth.type === 'digest') parts.push('--digest');
    parts.push(
      '--user ' + quoteShell((request.auth.username ?? '') + ':' + (request.auth.password ?? '')),
    );
  }
  switch (request.body.mode) {
    case 'raw':
      parts.push('--data-raw ' + quoteShell(request.body.raw));
      break;
    case 'graphql':
      parts.push('--data-raw ' + quoteShell(graphqlBody(request.body)));
      break;
    case 'urlencoded':
      for (const row of active(request.body.fields))
        parts.push('--data-urlencode ' + quoteShell(row.key + '=' + row.value));
      break;
    case 'form-data':
      for (const row of active(request.body.fields))
        parts.push(
          (row.type === 'file' ? '--form ' : '--form-string ') +
            quoteShell(
              row.key +
                '=' +
                (row.type === 'file' ? '@' + (row.filePath ?? 'SELECT_FILE') : row.value),
            ),
        );
      break;
    case 'binary':
      parts.push('--data-binary ' + quoteShell('@' + (request.body.filePath ?? 'SELECT_FILE')));
      break;
  }
  return parts.join(' \\\n  ');
}

function graphqlBody(body: RequestBody): string {
  let variables: unknown;
  try {
    variables = JSON.parse(body.graphqlVariables || '{}');
  } catch {
    throw new Error('GraphQL variables must be valid JSON before generating a code snippet.');
  }
  return JSON.stringify({ query: body.graphqlQuery ?? '', variables }, null, 2);
}

export function toHttp(request: ApiRequest): string {
  const { url, headers } = snippetParts(request);
  if (request.auth.type === 'basic') {
    const bytes = new TextEncoder().encode(
      (request.auth.username ?? '') + ':' + (request.auth.password ?? ''),
    );
    headers.push(
      pair(
        'Authorization',
        'Basic ' + btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
      ),
    );
  }
  const lines = [
    `${request.method} ${url} HTTP/1.1`,
    ...headers.map((h) => h.key + ': ' + h.value),
    '',
  ];
  switch (request.body.mode) {
    case 'raw':
      lines.push(request.body.raw);
      break;
    case 'graphql':
      lines.push(graphqlBody(request.body));
      break;
    case 'urlencoded':
      lines.push(
        active(request.body.fields)
          .map((r) => encode(r.key) + '=' + encode(r.value))
          .join('&'),
      );
      break;
    case 'form-data':
      lines.push(
        '# Multipart boundaries and file bytes are generated when sending. Use the cURL snippet for this body.',
      );
      break;
    case 'binary':
      lines.push('< ' + (request.body.filePath ?? 'SELECT_FILE'));
      break;
  }
  if (request.auth.type === 'digest')
    lines.unshift('# Digest Authorization is computed after the server challenge.');
  if (request.auth.type === 'inherit')
    lines.unshift('# Parent authentication must be added when running this snippet independently.');
  return lines.join('\r\n');
}

const md = (text: string): string =>
  text.replace(/[\\`*_{}[\]<>#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const sensitive = (key: string): boolean =>
  /authorization|cookie|token|secret|password|api[-_]?key/i.test(key);

/** Offline documentation omits known credentials; collection/environment exports intentionally retain values. */
export function toMarkdown(collection: Collection): string {
  const lines = [
    `# ${md(collection.name)}`,
    '',
    collection.description,
    '',
    'Generated locally by SendIt!. Review descriptions and URLs for sensitive values before sharing.',
    '',
  ];
  for (const request of collection.requests) {
    const folderNames: string[] = [];
    let folderId = request.folderId;
    const visited = new Set<string>();
    while (folderId && !visited.has(folderId)) {
      visited.add(folderId);
      const folder = collection.folders.find((f) => f.id === folderId);
      if (!folder) break;
      folderNames.unshift(folder.name);
      folderId = folder.parentId;
    }
    lines.push(
      `## ${md(request.name)}`,
      '',
      ...(folderNames.length ? [`Folder: ${folderNames.map(md).join(' / ')}`, ''] : []),
      `**${md(request.method)}** ${md(request.url.replace(/([?&](?:token|key|api_key|password|secret|access_token)=)[^&#]*/gi, '$1[REDACTED]'))}`,
      '',
      request.description,
      '',
      `Authentication: ${request.auth.type}`,
      '',
    );
    if (request.params.length) {
      lines.push(
        '### Query parameters',
        '',
        '| Name | Value | Enabled | Description |',
        '| --- | --- | --- | --- |',
      );
      for (const row of request.params)
        lines.push(
          `| ${md(row.key)} | ${md(row.secret || sensitive(row.key) ? '[REDACTED]' : row.value)} | ${row.enabled ? 'Yes' : 'No'} | ${md(row.description ?? '')} |`,
        );
      lines.push('');
    }
    if (request.headers.length) {
      lines.push('### Headers', '', '| Name | Value | Enabled |', '| --- | --- | --- |');
      for (const row of request.headers)
        lines.push(
          `| ${md(row.key)} | ${md(row.secret || sensitive(row.key) ? '[REDACTED]' : row.value)} | ${row.enabled ? 'Yes' : 'No'} |`,
        );
      lines.push('');
    }
    lines.push(
      `Body format: ${request.body.mode}${request.body.mode === 'raw' ? ' (' + request.body.language + ')' : ''}`,
      '',
    );
    if (request.body.fields.length)
      lines.push('Body fields: ' + request.body.fields.map((row) => md(row.key)).join(', '), '');
  }
  return lines.join('\n');
}
