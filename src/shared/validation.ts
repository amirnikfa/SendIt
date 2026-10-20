import { z } from 'zod';
import { DEFAULT_APP_ZOOM } from './models';
import { certificateHost } from './certificates';
export const certificateFileSchema = z.object({
  name: z.string().min(1).max(255),
  data: z
    .string()
    .min(1)
    .max(349528)
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      'Invalid certificate encoding',
    ),
});
export const clientCertificateSchema = z
  .object({
    id: z.string().min(1).max(200),
    enabled: z.boolean(),
    host: z
      .string()
      .min(1)
      .max(253)
      .transform((host, context) => {
        try {
          return certificateHost(host);
        } catch (error) {
          context.addIssue({ code: 'custom', message: (error as Error).message });
          return z.NEVER;
        }
      }),
    port: z.number().int().min(1).max(65535).default(443),
    format: z.enum(['pem', 'pfx']),
    certificate: certificateFileSchema.optional(),
    privateKey: certificateFileSchema.optional(),
    pfx: certificateFileSchema.optional(),
    passphrase: z.string().max(4096).default(''),
  })
  .refine(
    (value) =>
      value.format === 'pem'
        ? !!value.certificate && !!value.privateKey && !value.pfx
        : !!value.pfx && !value.certificate && !value.privateKey,
    'Select a certificate and private key, or a PFX/P12 file.',
  );
export const tlsSettingsSchema = z
  .object({
    caEnabled: z.boolean().default(false),
    caCertificates: z.array(certificateFileSchema).max(10).default([]),
    clientCertificates: z.array(clientCertificateSchema).max(20).default([]),
  })
  .refine(
    (value) =>
      new Set(value.clientCertificates.map((item) => `${item.host}:${item.port}`)).size ===
      value.clientCertificates.length,
    'Only one client certificate may be configured for each hostname and port.',
  );
const text = z.string().max(8 * 1024 * 1024);
const id = z.string().min(1).max(200);
export const pairSchema = z.object({
  id,
  key: z.string().max(32768),
  value: text,
  enabled: z.boolean(),
  description: text.optional(),
  secret: z.boolean().optional(),
  type: z.enum(['text', 'file']).optional(),
  filePath: z.string().max(32768).optional(),
});
const pairs = z.array(pairSchema).max(10000);
export const authSchema = z.object({
  type: z.enum(['inherit', 'none', 'basic', 'bearer', 'apikey', 'oauth2', 'digest']),
  token: text.optional(),
  username: text.optional(),
  password: text.optional(),
  key: text.optional(),
  value: text.optional(),
  addTo: z.enum(['header', 'query']).optional(),
  tokenUrl: text.optional(),
  clientId: text.optional(),
  clientSecret: text.optional(),
  scope: text.optional(),
  refreshToken: text.optional(),
  grantType: z.enum(['client_credentials', 'refresh_token']).optional(),
});
export const requestSchema = z.object({
  id,
  name: text,
  description: text,
  method: z.string().max(64),
  url: z.string().max(65536),
  params: pairs,
  headers: pairs,
  body: z.object({
    mode: z.enum(['none', 'raw', 'urlencoded', 'form-data', 'binary', 'graphql']),
    raw: text,
    language: z.enum(['json', 'text', 'xml', 'html', 'javascript']),
    fields: pairs,
    filePath: z.string().max(32768).optional(),
    graphqlQuery: text.optional(),
    graphqlVariables: text.optional(),
  }),
  auth: authSchema,
  variables: pairs,
  preScript: text,
  postScript: text,
  collectionId: id.optional(),
  folderId: id.optional(),
  verifyTls: z.boolean().optional(),
});
const folderSchema = z.object({
  id,
  name: text,
  description: text,
  parentId: id.optional(),
  auth: authSchema,
  preScript: text,
  postScript: text,
});
export const collectionSchema = z.object({
  id,
  name: text,
  description: text,
  variables: pairs,
  auth: authSchema,
  folders: z.array(folderSchema).max(10000),
  requests: z.array(requestSchema).max(20000),
  preScript: text,
  postScript: text,
});
export const environmentSchema = z.object({ id, name: text, variables: pairs });
export const settingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'pink']),
  zoomPercent: z.number().int().min(75).max(200).default(DEFAULT_APP_ZOOM),
  timeoutMs: z.number().int().min(1).max(600000),
  followRedirects: z.boolean(),
  verifyTls: z.boolean(),
  tls: tlsSettingsSchema.default(() => ({
    caEnabled: false,
    caCertificates: [],
    clientCertificates: [],
  })),
  proxyUrl: z.string().max(8192),
  maxResponseMb: z.number().min(1).max(50),
  sidebarWidth: z.number().min(160).max(700),
  editorHeight: z.number().min(100).max(1600),
  sidebarCollapsed: z.boolean(),
  title: z.string().max(100),
});
export const stateSchema = z
  .object({
    version: z.literal(1),
    workspaces: z
      .array(
        z.object({
          id,
          name: text,
          collections: z.array(collectionSchema).max(2000),
          environments: z.array(environmentSchema).max(2000),
          globals: pairs,
          history: z
            .array(
              z.object({
                id,
                at: z.string(),
                request: requestSchema,
                status: z.number(),
                duration: z.number(),
                error: text.optional(),
              }),
            )
            .max(500),
          activeEnvironmentId: id.optional(),
        }),
      )
      .min(1)
      .max(100),
    activeWorkspaceId: id,
    tabs: z
      .array(z.object({ id, request: requestSchema, dirty: z.boolean(), workspaceId: id }))
      .max(200),
    activeTabId: z.string().max(200),
    settings: settingsSchema,
  })
  .superRefine((s, ctx) => {
    if (!s.workspaces.some((w) => w.id === s.activeWorkspaceId))
      ctx.addIssue({ code: 'custom', message: 'The active workspace does not exist.' });
    for (const w of s.workspaces)
      for (const c of w.collections) {
        const folders = new Map(c.folders.map((f) => [f.id, f]));
        for (const f of c.folders) {
          const seen = new Set<string>([f.id]);
          let parent = f.parentId;
          while (parent) {
            if (seen.has(parent)) {
              ctx.addIssue({ code: 'custom', message: 'Folder nesting must not contain a cycle.' });
              break;
            }
            seen.add(parent);
            parent = folders.get(parent)?.parentId;
          }
        }
      }
  });
export const executionSchema = z.object({
  request: requestSchema,
  settings: settingsSchema,
  globals: pairs,
  environment: pairs,
  collectionVariables: pairs,
  inheritedAuth: authSchema.optional(),
  preScripts: z.array(text).max(100).optional(),
  postScripts: z.array(text).max(100).optional(),
});
export function boundedInput(value: unknown, maxBytes = 32 * 1024 * 1024) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maxBytes)
    throw new Error('Input exceeds the 32 MB workspace limit. Export and split large collections.');
  return value;
}
