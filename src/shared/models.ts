export interface Pair {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  secret?: boolean;
  type?: 'text' | 'file';
  filePath?: string;
}
export type AuthType = 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey' | 'oauth2' | 'digest';
export interface Auth {
  type: AuthType;
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  addTo?: 'header' | 'query';
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  refreshToken?: string;
  grantType?: 'client_credentials' | 'refresh_token';
}
export type BodyMode = 'none' | 'raw' | 'urlencoded' | 'form-data' | 'binary' | 'graphql';
export interface RequestBody {
  mode: BodyMode;
  raw: string;
  language: 'json' | 'text' | 'xml' | 'html' | 'javascript';
  fields: Pair[];
  filePath?: string;
  graphqlQuery?: string;
  graphqlVariables?: string;
}
export interface ApiRequest {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  params: Pair[];
  headers: Pair[];
  body: RequestBody;
  auth: Auth;
  variables: Pair[];
  preScript: string;
  postScript: string;
  collectionId?: string;
  folderId?: string;
}
export interface Folder {
  id: string;
  name: string;
  description: string;
  parentId?: string;
  auth: Auth;
  preScript: string;
  postScript: string;
}
export interface Collection {
  id: string;
  name: string;
  description: string;
  variables: Pair[];
  auth: Auth;
  folders: Folder[];
  requests: ApiRequest[];
  preScript: string;
  postScript: string;
}
export interface Environment {
  id: string;
  name: string;
  variables: Pair[];
}
export interface HistoryEntry {
  id: string;
  at: string;
  request: ApiRequest;
  status: number;
  duration: number;
  error?: string;
}
export interface Workspace {
  id: string;
  name: string;
  collections: Collection[];
  environments: Environment[];
  globals: Pair[];
  history: HistoryEntry[];
  activeEnvironmentId?: string;
}
export interface RequestTab {
  id: string;
  request: ApiRequest;
  dirty: boolean;
  workspaceId: string;
}
export interface CertificateFile {
  name: string;
  data: string;
}
export type CertificateFileKind = 'ca' | 'certificate' | 'privateKey' | 'pfx';
export interface ClientCertificate {
  id: string;
  enabled: boolean;
  host: string;
  port: number;
  format: 'pem' | 'pfx';
  certificate?: CertificateFile;
  privateKey?: CertificateFile;
  pfx?: CertificateFile;
  passphrase: string;
}
export interface TlsSettings {
  caEnabled: boolean;
  caCertificates: CertificateFile[];
  clientCertificates: ClientCertificate[];
}
export interface Settings {
  theme: 'dark' | 'light' | 'pink';
  zoomPercent: number;
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  tls: TlsSettings;
  proxyUrl: string;
  maxResponseMb: number;
  sidebarWidth: number;
  editorHeight: number;
  sidebarCollapsed: boolean;
  title: string;
}
export interface AppState {
  version: 1;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  tabs: RequestTab[];
  activeTabId: string;
  settings: Settings;
}
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}
export interface ApiResponse {
  status: number;
  statusText: string;
  duration: number;
  size: number;
  headers: Pair[];
  cookies: string[];
  body: string;
  base64: string;
  contentType: string;
  url: string;
  tests: TestResult[];
  logs: string[];
  error?: string;
}
export interface ExecutionInput {
  request: ApiRequest;
  settings: Settings;
  globals: Pair[];
  environment: Pair[];
  collectionVariables: Pair[];
  inheritedAuth?: Auth;
  preScripts?: string[];
  postScripts?: string[];
}
export interface ExecutionResult {
  response: ApiResponse;
  globals: Pair[];
  environment: Pair[];
  collectionVariables: Pair[];
}
export interface ImportResult {
  collections: Collection[];
  environments: Environment[];
  requests: ApiRequest[];
  warnings: string[];
}
export interface CookieRecord {
  domain: string;
  path: string;
  key: string;
  value: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: string;
}
export interface BootResult {
  state: AppState;
  dataDirectory: string;
  version: string;
}
export interface LiveEvent {
  id: string;
  type: 'open' | 'message' | 'sent' | 'close' | 'error';
  data: string;
  at: string;
}
export interface Bridge {
  load(): Promise<BootResult>;
  save(state: AppState): Promise<void>;
  setZoom(percent: number): Promise<void>;
  pickCertificate(kind: CertificateFileKind): Promise<CertificateFile | null>;
  validateClientCertificate(certificate: ClientCertificate): Promise<void>;
  execute(id: string, input: ExecutionInput): Promise<ExecutionResult>;
  cancel(id: string): Promise<void>;
  pickFile(): Promise<string | null>;
  importFile(): Promise<ImportResult | null>;
  importText(text: string): Promise<ImportResult>;
  exportCollection(collection: Collection): Promise<boolean>;
  exportEnvironment(environment: Environment): Promise<boolean>;
  saveFile(name: string, content: string, base64?: boolean): Promise<boolean>;
  backup(): Promise<boolean>;
  restore(): Promise<boolean>;
  cookies(): Promise<CookieRecord[]>;
  setCookie(url: string, cookie: string): Promise<void>;
  deleteCookie(domain: string, path: string, key: string): Promise<void>;
  oauth(auth: Auth, settings: Settings): Promise<{ token: string; refreshToken?: string }>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  onClosing(listener: () => void): () => void;
  liveConnect(id: string, protocol: 'websocket' | 'sse', input: ExecutionInput): Promise<void>;
  liveSend(id: string, text: string): Promise<void>;
  liveDisconnect(id: string): Promise<void>;
  onLive(listener: (event: LiveEvent) => void): () => void;
}
declare global {
  interface Window {
    workbench: Bridge;
  }
}
export const uid = () => crypto.randomUUID();
export const pair = (key = '', value = ''): Pair => ({ id: uid(), key, value, enabled: true });
export const newRequest = (name = 'Untitled request'): ApiRequest => ({
  id: uid(),
  name,
  description: '',
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  body: { mode: 'none', raw: '', language: 'json', fields: [] },
  auth: { type: 'inherit' },
  variables: [],
  preScript: '',
  postScript: '',
});
export const newCollection = (name: string): Collection => ({
  id: uid(),
  name,
  description: '',
  variables: [],
  auth: { type: 'none' },
  folders: [],
  requests: [],
  preScript: '',
  postScript: '',
});
export const ZOOM_LEVELS = [75, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_APP_ZOOM = 125;
export const defaultSettings: Settings = {
  theme: 'dark',
  zoomPercent: DEFAULT_APP_ZOOM,
  timeoutMs: 30000,
  followRedirects: true,
  verifyTls: true,
  tls: { caEnabled: false, caCertificates: [], clientCertificates: [] },
  proxyUrl: '',
  maxResponseMb: 50,
  sidebarWidth: 272,
  editorHeight: 300,
  sidebarCollapsed: false,
  title: 'SendIt!',
};
export function initialState(): AppState {
  const workspace: Workspace = {
    id: uid(),
    name: 'Personal workspace',
    collections: [],
    environments: [],
    globals: [],
    history: [],
  };
  const tab: RequestTab = {
    id: uid(),
    request: newRequest(),
    dirty: false,
    workspaceId: workspace.id,
  };
  return {
    version: 1,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    tabs: [tab],
    activeTabId: tab.id,
    settings: structuredClone(defaultSettings),
  };
}
