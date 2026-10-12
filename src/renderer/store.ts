import { create } from 'zustand';
import {
  initialState,
  uid,
  newRequest,
  newCollection,
  type AppState,
  type ApiRequest,
  type ApiResponse,
  type Collection,
  type ExecutionInput,
  type Folder,
  type ImportResult,
  type Workspace,
} from '../shared/models';

export type Notice = { id: string; message: string; kind: 'success' | 'error' | 'info' };
export type LogEntry = { id: string; time: string; message: string; kind: 'info' | 'error' };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<void> = Promise.resolve();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function persist(state: AppState) {
  useStore.setState({ saveStatus: 'saving' });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => window.workbench.save(state))
      .then(() => {
        if (useStore.getState().data === state) useStore.setState({ saveStatus: 'saved' });
      })
      .catch((e) => {
        useStore.setState({ saveStatus: 'error' });
        useStore.getState().notify(`Could not save your changes: ${String(e)}`, 'error');
      });
  }, 200);
}
export async function flushSave() {
  if (!useStore.getState().ready) return;
  clearTimeout(saveTimer);
  await saveQueue.catch(() => {});
  await window.workbench.save(useStore.getState().data);
  useStore.setState({ saveStatus: 'saved' });
}
function mergeScriptRows(
  current: import('../shared/models').Pair[],
  before: import('../shared/models').Pair[],
  after: import('../shared/models').Pair[],
) {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const result = [...current];
  for (const previous of before) {
    const next = after.find((row) => row.key === previous.key);
    const index = result.findIndex((row) => row.key === previous.key);
    if (index >= 0 && equal(result[index], previous) && !equal(next, previous)) {
      if (next) result[index] = next;
      else result.splice(index, 1);
    }
  }
  for (const next of after)
    if (!before.some((row) => row.key === next.key) && !result.some((row) => row.key === next.key))
      result.push(next);
  return result;
}
export function activeWorkspace(data: AppState): Workspace {
  return data.workspaces.find((w) => w.id === data.activeWorkspaceId) || data.workspaces[0];
}
export function requestContext(
  data: AppState,
  request: ApiRequest,
  workspaceId = data.activeWorkspaceId,
): ExecutionInput {
  const ws = data.workspaces.find((w) => w.id === workspaceId) || activeWorkspace(data);
  const collection = ws.collections.find((c) => c.id === request.collectionId);
  const ancestors: Folder[] = [];
  let folder = collection?.folders.find((f) => f.id === request.folderId);
  const seen = new Set<string>();
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    ancestors.unshift(folder);
    folder = collection?.folders.find((f) => f.id === folder!.parentId);
  }
  let inheritedAuth = collection?.auth;
  for (const f of ancestors) if (f.auth.type !== 'inherit') inheritedAuth = f.auth;
  return {
    request,
    settings: data.settings,
    globals: ws.globals,
    environment: ws.environments.find((e) => e.id === ws.activeEnvironmentId)?.variables || [],
    collectionVariables: collection?.variables || [],
    inheritedAuth,
    preScripts: [collection?.preScript || '', ...ancestors.map((f) => f.preScript)].filter(Boolean),
    postScripts: [collection?.postScript || '', ...ancestors.map((f) => f.postScript)].filter(
      Boolean,
    ),
  };
}
interface Store {
  data: AppState;
  ready: boolean;
  bootError: string;
  dataDirectory: string;
  version: string;
  saveStatus: 'saving' | 'saved' | 'error';
  responses: Record<string, ApiResponse>;
  busy: string[];
  notices: Notice[];
  logs: LogEntry[];
  boot: () => Promise<void>;
  change: (fn: (data: AppState) => void) => void;
  notify: (message: string, kind?: Notice['kind']) => void;
  log: (message: string, kind?: LogEntry['kind']) => void;
  openRequest: (request?: ApiRequest) => string;
  editRequest: (patch: Partial<ApiRequest>) => void;
  closeTab: (id: string) => void;
  saveRequest: (collectionId: string, folderId?: string) => void;
  createCollection: (name: string) => string;
  execute: (tabId?: string) => Promise<ApiResponse | undefined>;
  executeRequest: (
    request: ApiRequest,
    operationId: string,
    workspaceId?: string,
  ) => Promise<ApiResponse>;
  importData: (data: ImportResult) => void;
}
export const useStore = create<Store>((set, get) => ({
  data: initialState(),
  ready: false,
  bootError: '',
  dataDirectory: '',
  version: '',
  saveStatus: 'saved',
  responses: {},
  busy: [],
  notices: [],
  logs: [],
  boot: async () => {
    try {
      const result = await window.workbench.load();
      set({
        data: result.state,
        dataDirectory: result.dataDirectory,
        version: result.version,
        ready: true,
        bootError: '',
        saveStatus: 'saved',
      });
    } catch (e) {
      set({ bootError: String(e) });
    }
  },
  change: (fn) => {
    const data = copy(get().data);
    fn(data);
    set({ data });
    if (get().ready) persist(data);
  },
  notify: (message, kind = 'success') => {
    const notice = { id: uid(), message, kind };
    set((s) => ({ notices: [...s.notices.slice(-3), notice] }));
    setTimeout(
      () => set((s) => ({ notices: s.notices.filter((n) => n.id !== notice.id) })),
      kind === 'error' ? 10000 : 4500,
    );
  },
  log: (message, kind = 'info') =>
    set((s) => ({
      logs: [
        ...s.logs.slice(-299),
        { id: uid(), time: new Date().toLocaleTimeString(), message, kind },
      ],
    })),
  openRequest: (request) => {
    const data = get().data;
    const existing =
      request &&
      data.tabs.find(
        (t) => t.request.id === request.id && t.workspaceId === data.activeWorkspaceId,
      );
    if (existing) {
      get().change((d) => {
        d.activeTabId = existing.id;
      });
      return existing.id;
    }
    const id = uid();
    get().change((d) => {
      d.tabs.push({
        id,
        request: request ? copy(request) : newRequest(),
        dirty: false,
        workspaceId: d.activeWorkspaceId,
      });
      d.activeTabId = id;
    });
    return id;
  },
  editRequest: (patch) =>
    get().change((d) => {
      const tab = d.tabs.find((t) => t.id === d.activeTabId);
      if (tab) {
        Object.assign(tab.request, patch);
        tab.dirty = true;
      }
    }),
  closeTab: (id) => {
    if (get().busy.includes(id)) void window.workbench.cancel(id);
    get().change((d) => {
      const index = d.tabs.findIndex((t) => t.id === id);
      d.tabs = d.tabs.filter((t) => t.id !== id);
      if (d.activeTabId === id)
        d.activeTabId =
          d.tabs.filter((t) => t.workspaceId === d.activeWorkspaceId)[Math.max(0, index - 1)]?.id ||
          d.tabs.find((t) => t.workspaceId === d.activeWorkspaceId)?.id ||
          '';
    });
    set((s) => {
      const responses = { ...s.responses };
      delete responses[id];
      return { responses };
    });
  },
  saveRequest: (collectionId, folderId) => {
    get().change((d) => {
      const tab = d.tabs.find((t) => t.id === d.activeTabId);
      const ws = activeWorkspace(d);
      const target = ws.collections.find((c) => c.id === collectionId);
      if (!tab || !target) return;
      const previous = ws.collections.find((c) => c.id === tab.request.collectionId);
      if (previous && previous.id !== target.id)
        previous.requests = previous.requests.filter((r) => r.id !== tab.request.id);
      tab.request.collectionId = collectionId;
      tab.request.folderId = folderId;
      const index = target.requests.findIndex((r) => r.id === tab.request.id);
      if (index >= 0) target.requests[index] = copy(tab.request);
      else target.requests.push(copy(tab.request));
      tab.dirty = false;
    });
    get().notify('Request saved');
  },
  createCollection: (name) => {
    const collection = newCollection(name);
    get().change((d) => activeWorkspace(d).collections.push(collection));
    return collection.id;
  },
  executeRequest: async (request, operationId, sourceWorkspaceId) => {
    const data = get().data;
    const workspaceId = sourceWorkspaceId || data.activeWorkspaceId;
    const environmentId = data.workspaces.find((w) => w.id === workspaceId)?.activeEnvironmentId;
    const context = requestContext(data, copy(request), workspaceId);
    get().log(`${request.method} ${request.name}`);
    const result = await window.workbench.execute(operationId, context);
    get().change((d) => {
      const ws = d.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      ws.globals = mergeScriptRows(ws.globals, context.globals, result.globals);
      const env = ws.environments.find((e) => e.id === environmentId);
      if (env)
        env.variables = mergeScriptRows(env.variables, context.environment, result.environment);
      const collection = ws.collections.find((c) => c.id === request.collectionId);
      if (collection)
        collection.variables = mergeScriptRows(
          collection.variables,
          context.collectionVariables,
          result.collectionVariables,
        );
      ws.history.unshift({
        id: uid(),
        at: new Date().toISOString(),
        request: copy(request),
        status: result.response.status,
        duration: result.response.duration,
        error: result.response.error,
      });
      ws.history = ws.history.slice(0, 300);
    });
    get().log(
      result.response.error
        ? `Request failed: ${result.response.error}`
        : `${result.response.status} ${result.response.statusText} · ${Math.round(result.response.duration)} ms · ${result.response.size.toLocaleString()} bytes`,
      result.response.error ? 'error' : 'info',
    );
    for (const line of result.response.logs) get().log(line);
    return result.response;
  },
  execute: async (tabId) => {
    const id = tabId || get().data.activeTabId;
    const tab = get().data.tabs.find((t) => t.id === id);
    if (!tab || get().busy.includes(id)) return;
    if (!tab.request.url.trim()) {
      get().notify('Enter a request URL first', 'error');
      return;
    }
    set((s) => ({ busy: [...s.busy, id] }));
    try {
      const response = await get().executeRequest(copy(tab.request), id, tab.workspaceId);
      set((s) => ({ responses: { ...s.responses, [id]: response } }));
      return response;
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, '');
      get().notify(message, 'error');
      get().log(message, 'error');
      const response: ApiResponse = {
        status: 0,
        statusText: 'Request failed',
        duration: 0,
        size: 0,
        headers: [],
        cookies: [],
        body: '',
        base64: '',
        contentType: '',
        url: tab.request.url,
        tests: [],
        logs: [],
        error: message,
      };
      set((s) => ({ responses: { ...s.responses, [id]: response } }));
      return response;
    } finally {
      set((s) => ({ busy: s.busy.filter((i) => i !== id) }));
    }
  },
  importData: (imported) => {
    get().change((d) => {
      const ws = activeWorkspace(d);
      ws.collections.push(...imported.collections);
      ws.environments.push(...imported.environments);
      for (const request of imported.requests) {
        const id = uid();
        d.tabs.push({ id, request, dirty: true, workspaceId: ws.id });
        d.activeTabId = id;
      }
    });
    get().notify(
      `Imported ${imported.collections.length} collection(s), ${imported.environments.length} environment(s), ${imported.requests.length} request(s)`,
    );
    for (const warning of imported.warnings) {
      get().log(warning);
      get().notify(warning, 'info');
    }
  },
}));
