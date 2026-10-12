import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Box,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Code2,
  Copy,
  Download,
  Ellipsis,
  FileJson2,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe2,
  History,
  Layers3,
  Loader2,
  Maximize2,
  Minus,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Search,
  Settings,
  Terminal,
  Trash2,
  Upload,
  Wifi,
  X,
} from 'lucide-react';
import {
  newRequest,
  uid,
  type ApiRequest,
  type Collection,
  type Folder as ApiFolder,
} from '../shared/models';
import { IconButton, Empty } from './components';
import { DialogHost, type DialogState } from './dialogs';
import { methodClass, RequestEditor, ResponseViewer } from './RequestEditor';
import { activeWorkspace, flushSave, useStore } from './store';
import logo from '../../assets/icon.png';

type Context = {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean; icon?: ReactNode }[];
};
type DragItem = {
  type: 'request' | 'folder' | 'collection' | 'tab';
  id: string;
  collectionId?: string;
};
const readDrag = (e: DragEvent): DragItem | null => {
  try {
    return JSON.parse(e.dataTransfer.getData('application/x-sendit'));
  } catch {
    return null;
  }
};
const drag = (e: DragEvent, item: DragItem) => {
  e.dataTransfer.setData('application/x-sendit', JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'move';
};
const stopDrop = (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
};
export default function App() {
  const store = useStore();
  const { data } = store;
  const ws = activeWorkspace(data);
  const settings = data.settings;
  const tab = data.tabs.find((t) => t.id === data.activeTabId && t.workspaceId === ws.id);
  const tabs = data.tabs.filter((t) => t.workspaceId === ws.id);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [nav, setNav] = useState('collections');
  const [filter, setFilter] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('aw-expanded') || '[]'));
    } catch {
      return new Set();
    }
  });
  const [dragging, setDragging] = useState(false);
  const closing = useRef(false);
  useEffect(() => {
    void store.boot();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.title = settings.title || 'SendIt!';
  }, [settings.theme, settings.title]);
  useEffect(() => {
    localStorage.setItem('aw-expanded', JSON.stringify([...expanded]));
  }, [expanded]);
  const closeWindow = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      if (useStore.getState().ready) await flushSave();
      await window.workbench.windowAction('close');
    } catch (e) {
      closing.current = false;
      useStore.getState().notify(`Could not save before closing: ${String(e)}`, 'error');
    }
  }, []);
  useEffect(() => window.workbench.onClosing(() => void closeWindow()), [closeWindow]);
  useEffect(() => {
    const listener = () => setContext(null);
    window.addEventListener('click', listener);
    window.addEventListener('resize', listener);
    return () => {
      window.removeEventListener('click', listener);
      window.removeEventListener('resize', listener);
    };
  }, []);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = () => {
    if (!tab) return;
    if (tab.request.collectionId && ws.collections.some((c) => c.id === tab.request.collectionId))
      store.saveRequest(tab.request.collectionId, tab.request.folderId);
    else setDialog({ kind: 'save', tabId: tab.id });
  };
  const closeTab = (id: string) => {
    const current = data.tabs.find((t) => t.id === id);
    if (current?.dirty)
      setDialog({
        kind: 'confirm',
        title: 'Discard unsaved changes?',
        message: `“${current.request.name}” has unsaved changes. Save the request first to keep it in your collection. Your other tabs are preserved.`,
        action: 'Discard and close',
        onConfirm: () => store.closeTab(id),
      });
    else store.closeTab(id);
  };
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContext(null);
      if (!(e.ctrlKey || e.metaKey) || dialog) return;
      const key = e.key.toLowerCase();
      if (['t', 's', 'enter', 'w', 'k'].includes(key)) e.preventDefault();
      if (key === 't') store.openRequest();
      else if (key === 's') save();
      else if (key === 'enter') void store.execute();
      else if (key === 'w' && tab) closeTab(tab.id);
      else if (key === 'k') setDialog({ kind: 'search' });
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  const nameDialog = (
    title: string,
    label: string,
    submit: (name: string) => void,
    initial?: string,
  ) => setDialog({ kind: 'name', title, label, initial, onSubmit: submit });
  const createCollection = () =>
    nameDialog('Create collection', 'Collection name', (name) => {
      const id = store.createCollection(name);
      setExpanded((current) => new Set([...current, id]));
    });
  const newSavedRequest = (collection: Collection, folderId?: string) => {
    const request = newRequest();
    request.collectionId = collection.id;
    request.folderId = folderId;
    store.openRequest(request);
    store.editRequest({});
    setExpanded((current) => new Set([...current, collection.id, ...(folderId ? [folderId] : [])]));
  };
  const createFolder = (collection: Collection, parentId?: string) =>
    nameDialog('Create folder', 'Folder name', (name) => {
      const id = uid();
      store.change((d) =>
        activeWorkspace(d)
          .collections.find((c) => c.id === collection.id)!
          .folders.push({
            id,
            name,
            description: '',
            parentId,
            auth: { type: 'inherit' },
            preScript: '',
            postScript: '',
          }),
      );
      setExpanded(
        (current) => new Set([...current, collection.id, ...(parentId ? [parentId] : []), id]),
      );
    });
  const duplicateRequest = (request: ApiRequest) => {
    const next = JSON.parse(JSON.stringify(request)) as ApiRequest;
    next.id = uid();
    next.name += ' copy';
    store.openRequest(next);
    store.editRequest({});
  };
  const removeRequest = (collection: Collection, request: ApiRequest) =>
    setDialog({
      kind: 'confirm',
      title: 'Delete request?',
      message: `Delete “${request.name}” from this collection? Its open tab will also close.`,
      onConfirm: () =>
        store.change((d) => {
          activeWorkspace(d).collections.find((c) => c.id === collection.id)!.requests =
            collection.requests.filter((r) => r.id !== request.id);
          d.tabs = d.tabs.filter((t) => t.request.id !== request.id);
          if (!d.tabs.some((t) => t.id === d.activeTabId))
            d.activeTabId = d.tabs.find((t) => t.workspaceId === d.activeWorkspaceId)?.id || '';
        }),
    });
  const openContext = (e: React.MouseEvent, items: Context['items']) => {
    e.preventDefault();
    e.stopPropagation();
    setContext({
      x: Math.min(e.clientX, window.innerWidth - 230),
      y: Math.min(e.clientY, window.innerHeight - Math.min(items.length * 34 + 12, 310)),
      items,
    });
  };
  const collectionMenu = (collection: Collection): Context['items'] => [
    { label: 'Add request', icon: <Plus size={13} />, action: () => newSavedRequest(collection) },
    { label: 'Add folder', icon: <FolderPlus size={13} />, action: () => createFolder(collection) },
    {
      label: 'Collection settings',
      icon: <Settings size={13} />,
      action: () => setDialog({ kind: 'collection', id: collection.id }),
    },
    {
      label: 'Export collection',
      icon: <Download size={13} />,
      action: () =>
        void window.workbench
          .exportCollection(collection)
          .then((ok) => {
            if (ok) store.notify('Collection exported');
          })
          .catch((e) => store.notify(String(e), 'error')),
    },
    {
      label: 'Run collection',
      icon: <Play size={13} />,
      action: () => setDialog({ kind: 'runner' }),
    },
    {
      label: 'Delete collection',
      danger: true,
      icon: <Trash2 size={13} />,
      action: () =>
        setDialog({
          kind: 'confirm',
          title: 'Delete collection?',
          message: `Delete “${collection.name}”, its folders and requests? Open requests in this collection will also close.`,
          onConfirm: () =>
            store.change((d) => {
              activeWorkspace(d).collections = activeWorkspace(d).collections.filter(
                (c) => c.id !== collection.id,
              );
              d.tabs = d.tabs.filter((t) => t.request.collectionId !== collection.id);
              if (!d.tabs.some((t) => t.id === d.activeTabId))
                d.activeTabId = d.tabs.find((t) => t.workspaceId === d.activeWorkspaceId)?.id || '';
            }),
        }),
    },
  ];
  const folderMenu = (collection: Collection, folder: ApiFolder): Context['items'] => [
    {
      label: 'Add request',
      action: () => newSavedRequest(collection, folder.id),
      icon: <Plus size={13} />,
    },
    {
      label: 'Add nested folder',
      action: () => createFolder(collection, folder.id),
      icon: <FolderPlus size={13} />,
    },
    {
      label: 'Folder settings',
      action: () => setDialog({ kind: 'collection', id: collection.id, folderId: folder.id }),
      icon: <Settings size={13} />,
    },
    {
      label: 'Delete folder',
      danger: true,
      icon: <Trash2 size={13} />,
      action: () =>
        setDialog({
          kind: 'confirm',
          title: 'Delete folder?',
          message: `Delete “${folder.name}” and all nested requests and folders?`,
          onConfirm: () =>
            store.change((d) => {
              const c = activeWorkspace(d).collections.find((c) => c.id === collection.id)!;
              const ids = descendants(c, folder.id);
              const reqIds = new Set(
                c.requests.filter((r) => r.folderId && ids.has(r.folderId)).map((r) => r.id),
              );
              c.folders = c.folders.filter((f) => !ids.has(f.id));
              c.requests = c.requests.filter((r) => !reqIds.has(r.id));
              d.tabs = d.tabs.filter((t) => !reqIds.has(t.request.id));
              if (!d.tabs.some((t) => t.id === d.activeTabId))
                d.activeTabId = d.tabs.find((t) => t.workspaceId === d.activeWorkspaceId)?.id || '';
            }),
        }),
    },
  ];
  const requestMenu = (collection: Collection, request: ApiRequest): Context['items'] => [
    {
      label: 'Open request',
      action: () => store.openRequest(request),
      icon: <FileJson2 size={13} />,
    },
    {
      label: 'Duplicate request',
      action: () => duplicateRequest(request),
      icon: <Copy size={13} />,
    },
    {
      label: 'Move request…',
      action: () => {
        const id = store.openRequest(request);
        setDialog({ kind: 'save', tabId: id });
      },
      icon: <Folder size={13} />,
    },
    {
      label: 'Rename request',
      action: () =>
        nameDialog(
          'Rename request',
          'Request name',
          (name) =>
            store.change((d) => {
              activeWorkspace(d)
                .collections.find((c) => c.id === collection.id)!
                .requests.find((r) => r.id === request.id)!.name = name;
              for (const t of d.tabs) if (t.request.id === request.id) t.request.name = name;
            }),
          request.name,
        ),
      icon: <Code2 size={13} />,
    },
    {
      label: 'Delete request',
      danger: true,
      action: () => removeRequest(collection, request),
      icon: <Trash2 size={13} />,
    },
  ];
  const drop = (e: DragEvent, target: Collection, folderId?: string, beforeId?: string) => {
    stopDrop(e);
    const item = readDrag(e);
    if (!item) return;
    store.change((d) => {
      const workspace = activeWorkspace(d);
      const dest = workspace.collections.find((c) => c.id === target.id)!;
      if (item.type === 'collection') {
        const old = workspace.collections.findIndex((c) => c.id === item.id);
        const at = workspace.collections.findIndex((c) => c.id === dest.id);
        if (old >= 0 && at >= 0) {
          const [c] = workspace.collections.splice(old, 1);
          workspace.collections.splice(at, 0, c);
        }
        return;
      }
      const source = workspace.collections.find((c) => c.id === item.collectionId);
      if (!source) return;
      if (item.type === 'request') {
        const request = source.requests.find((r) => r.id === item.id);
        if (!request || beforeId === request.id) return;
        source.requests = source.requests.filter((r) => r.id !== item.id);
        request.collectionId = dest.id;
        request.folderId = folderId;
        const index = beforeId ? dest.requests.findIndex((r) => r.id === beforeId) : -1;
        if (index < 0) dest.requests.push(request);
        else dest.requests.splice(index, 0, request);
        for (const t of d.tabs)
          if (t.request.id === item.id) {
            t.request.collectionId = dest.id;
            t.request.folderId = folderId;
          }
      } else if (item.type === 'folder') {
        const ids = descendants(source, item.id);
        if (folderId && ids.has(folderId)) return;
        const root = source.folders.find((f) => f.id === item.id);
        if (!root) return;
        root.parentId = folderId;
        if (source.id !== dest.id) {
          const folders = source.folders.filter((f) => ids.has(f.id));
          const requests = source.requests.filter((r) => r.folderId && ids.has(r.folderId));
          source.folders = source.folders.filter((f) => !ids.has(f.id));
          source.requests = source.requests.filter((r) => !r.folderId || !ids.has(r.folderId));
          dest.folders.push(...folders);
          dest.requests.push(...requests.map((r) => ({ ...r, collectionId: dest.id })));
          for (const t of d.tabs)
            if (t.request.folderId && ids.has(t.request.folderId)) t.request.collectionId = dest.id;
        }
      }
    });
    setExpanded((current) => new Set([...current, target.id, ...(folderId ? [folderId] : [])]));
  };
  const matches = (request: ApiRequest) =>
    `${request.name} ${request.method} ${request.url}`.toLowerCase().includes(filter.toLowerCase());
  const renderRequest = (collection: Collection, request: ApiRequest, depth: number) => (
    <div
      key={request.id}
      className={`tree-row request-row ${tab?.request.id === request.id ? 'selected' : ''}`}
      style={{ paddingLeft: 13 + depth * 16 }}
      draggable
      onDragStart={(e) => drag(e, { type: 'request', id: request.id, collectionId: collection.id })}
      onDragOver={stopDrop}
      onDrop={(e) => drop(e, collection, request.folderId, request.id)}
      onContextMenu={(e) => openContext(e, requestMenu(collection, request))}
    >
      <button
        className="tree-item-button"
        onClick={() => store.openRequest(request)}
        title={`${request.method} ${request.url || request.name}`}
      >
        <span className={`method-label ${methodClass(request.method)}`}>{request.method}</span>
        <span>{request.name || 'Untitled request'}</span>
      </button>
      <button
        className="tree-more"
        title={`Actions for ${request.name}`}
        onClick={(e) => openContext(e, requestMenu(collection, request))}
      >
        <Ellipsis size={15} />
      </button>
    </div>
  );
  const renderFolder = (
    collection: Collection,
    folder: ApiFolder,
    depth: number,
    visited = new Set<string>(),
  ): ReactNode => {
    if (visited.has(folder.id)) return null;
    const seen = new Set([...visited, folder.id]);
    const open = expanded.has(folder.id) || !!filter;
    const nested = collection.folders.filter((f) => f.parentId === folder.id);
    const requests = collection.requests.filter((r) => r.folderId === folder.id && matches(r));
    if (
      filter &&
      !collection.requests.some(
        (r) => r.folderId && descendants(collection, folder.id).has(r.folderId) && matches(r),
      )
    )
      return null;
    return (
      <div key={folder.id}>
        <div
          className="tree-row folder-row"
          style={{ paddingLeft: 10 + depth * 16 }}
          draggable
          onDragStart={(e) =>
            drag(e, { type: 'folder', id: folder.id, collectionId: collection.id })
          }
          onDragOver={stopDrop}
          onDrop={(e) => drop(e, collection, folder.id)}
          onContextMenu={(e) => openContext(e, folderMenu(collection, folder))}
        >
          <button className="tree-item-button" onClick={() => toggle(folder.id)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {open ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span>{folder.name}</span>
          </button>
          <button
            className="tree-more"
            title={`Actions for ${folder.name}`}
            onClick={(e) => openContext(e, folderMenu(collection, folder))}
          >
            <Ellipsis size={15} />
          </button>
        </div>
        {open && (
          <>
            {nested.map((f) => renderFolder(collection, f, depth + 1, seen))}
            {requests.map((r) => renderRequest(collection, r, depth + 1))}
            {!nested.length && !requests.length && (
              <button
                className="tree-empty"
                style={{ paddingLeft: 28 + depth * 16 }}
                onClick={() => newSavedRequest(collection, folder.id)}
              >
                + Add a request
              </button>
            )}
          </>
        )}
      </div>
    );
  };
  const resize = (kind: 'sidebar' | 'editor', e: React.PointerEvent) => {
    e.preventDefault();
    const start = kind === 'sidebar' ? e.clientX : e.clientY;
    const initial = kind === 'sidebar' ? settings.sidebarWidth : settings.editorHeight;
    setDragging(true);
    const move = (event: PointerEvent) =>
      store.change((d) => {
        if (kind === 'sidebar')
          d.settings.sidebarWidth = Math.max(190, Math.min(480, initial + event.clientX - start));
        else
          d.settings.editorHeight = Math.max(
            230,
            Math.min(window.innerHeight - 245, initial + event.clientY - start),
          );
      });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  if (!store.ready)
    return (
      <div className="boot-screen">
        <div className="brand-symbol">
          <img src={logo} alt="SendIt! logo" />
        </div>
        <h1>SendIt!</h1>
        {store.bootError ? (
          <>
            <p className="red">{store.bootError}</p>
            <button
              className="button secondary"
              onClick={() =>
                void window.workbench
                  .restore()
                  .then((ok) => {
                    if (ok) return store.boot();
                  })
                  .catch((e) => store.notify(String(e), 'error'))
              }
            >
              Restore backup
            </button>
            <button
              className="button secondary"
              onClick={() => void window.workbench.windowAction('close')}
            >
              Close application
            </button>
            <button className="button secondary" onClick={() => void store.boot()}>
              Try again
            </button>
          </>
        ) : (
          <>
            <Loader2 className="spin" size={20} />
            <p>Opening your local workspace…</p>
          </>
        )}
      </div>
    );
  return (
    <div className={`app ${dragging ? 'resizing' : ''}`}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-symbol">
            <img src={logo} alt="SendIt! logo" />
          </span>
          <strong>{settings.title || 'SendIt!'}</strong>
          <span className="local-badge">LOCAL</span>
        </div>
        <button className="global-search" onClick={() => setDialog({ kind: 'search' })}>
          <Search size={13} />
          <span>Search your workspace</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="titlebar-end">
          <span className="private-indicator">
            <span />
            Offline first
          </span>
          <div className="window-controls">
            <button
              aria-label="Minimize window"
              onClick={() => void window.workbench.windowAction('minimize')}
            >
              <Minus size={14} />
            </button>
            <button
              aria-label="Maximize window"
              onClick={() => void window.workbench.windowAction('maximize')}
            >
              <Maximize2 size={12} />
            </button>
            <button
              className="window-close"
              aria-label="Close window"
              onClick={() => void closeWindow()}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </header>
      <div className="workspace-bar">
        <button className="workspace-switcher" onClick={() => setDialog({ kind: 'workspaces' })}>
          <Layers3 size={16} />
          <strong>{ws.name}</strong>
          <ChevronDown size={12} />
        </button>
        <div className="workspace-actions">
          <button
            className="button secondary small"
            data-testid="new-request"
            onClick={() => store.openRequest()}
          >
            <Plus size={13} />
            New
          </button>
          <button
            className="button secondary small"
            data-testid="import"
            onClick={() => setDialog({ kind: 'import' })}
          >
            <Upload size={13} />
            Import
          </button>
        </div>
        <div className="spacer" />
        <button
          className="text-button"
          data-testid="live-connections"
          onClick={() => setDialog({ kind: 'live' })}
        >
          <Wifi size={13} />
          Live connections
        </button>
        <button className="text-button run-button" onClick={() => setDialog({ kind: 'runner' })}>
          <Play size={13} />
          Runner
        </button>
        <div className="env-selector">
          <Globe2 size={15} />
          <select
            data-testid="environment-select"
            aria-label="Active environment"
            value={ws.activeEnvironmentId || ''}
            onChange={(e) =>
              store.change((d) => {
                activeWorkspace(d).activeEnvironmentId = e.target.value || undefined;
              })
            }
          >
            <option value="">No environment</option>
            {ws.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <IconButton
            data-testid="manage-environments"
            title="Manage environments"
            onClick={() => setDialog({ kind: 'environments' })}
          >
            <Settings size={14} />
          </IconButton>
        </div>
      </div>
      <div className="workspace-body">
        <nav className="navigation-rail" aria-label="Main navigation">
          <div>
            {[
              { id: 'collections', label: 'Collections', icon: <Folder size={20} /> },
              { id: 'environments', label: 'Environments', icon: <Globe2 size={20} /> },
              { id: 'history', label: 'History', icon: <History size={20} /> },
            ].map((item) => (
              <button
                key={item.id}
                className={nav === item.id ? 'active' : ''}
                onClick={() => {
                  setNav(item.id);
                  setFilter('');
                  if (settings.sidebarCollapsed)
                    store.change((d) => {
                      d.settings.sidebarCollapsed = false;
                    });
                }}
                title={item.label}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div>
            <button
              data-testid="settings"
              onClick={() => setDialog({ kind: 'settings' })}
              title="Settings"
            >
              <Settings size={19} />
              <span>Settings</span>
            </button>
          </div>
        </nav>
        {!settings.sidebarCollapsed && (
          <>
            <aside className="explorer" style={{ width: settings.sidebarWidth }}>
              <div className="explorer-heading">
                <strong>
                  {nav === 'collections'
                    ? 'Collections'
                    : nav === 'environments'
                      ? 'Environments'
                      : 'History'}
                </strong>
                <div className="inline-actions">
                  {nav === 'collections' && (
                    <IconButton
                      data-testid="new-collection"
                      title="Create collection"
                      onClick={createCollection}
                    >
                      <Plus size={16} />
                    </IconButton>
                  )}
                  {nav === 'environments' && (
                    <IconButton
                      title="Manage environments"
                      onClick={() => setDialog({ kind: 'environments' })}
                    >
                      <Plus size={16} />
                    </IconButton>
                  )}
                  {nav === 'history' && (
                    <IconButton
                      title="Clear history"
                      disabled={!ws.history.length}
                      onClick={() =>
                        setDialog({
                          kind: 'confirm',
                          title: 'Clear request history?',
                          message:
                            'Remove the request history for this workspace? Saved collections will remain available.',
                          action: 'Clear history',
                          onConfirm: () =>
                            store.change((d) => {
                              activeWorkspace(d).history = [];
                            }),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                  <IconButton
                    title="Collapse explorer"
                    onClick={() =>
                      store.change((d) => {
                        d.settings.sidebarCollapsed = true;
                      })
                    }
                  >
                    <PanelLeftClose size={15} />
                  </IconButton>
                </div>
              </div>
              <div className="explorer-filter">
                <Search size={13} />
                <input
                  aria-label={`Filter ${nav}`}
                  placeholder={
                    nav === 'collections'
                      ? 'Filter collections and requests'
                      : nav === 'history'
                        ? 'Filter request history'
                        : 'Filter environments'
                  }
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <IconButton title="Clear filter" onClick={() => setFilter('')}>
                    <X size={12} />
                  </IconButton>
                )}
              </div>
              <div className="explorer-content">
                {nav === 'collections' && (
                  <>
                    {ws.collections.length ? (
                      ws.collections
                        .filter(
                          (c) =>
                            c.name.toLowerCase().includes(filter.toLowerCase()) ||
                            c.requests.some(matches),
                        )
                        .map((collection) => {
                          const open = expanded.has(collection.id) || !!filter;
                          return (
                            <div className="collection" key={collection.id}>
                              <div
                                className="tree-row collection-row"
                                draggable
                                onDragStart={(e) =>
                                  drag(e, { type: 'collection', id: collection.id })
                                }
                                onDragOver={stopDrop}
                                onDrop={(e) => drop(e, collection)}
                                onContextMenu={(e) => openContext(e, collectionMenu(collection))}
                              >
                                <button
                                  className="tree-item-button"
                                  onClick={() => toggle(collection.id)}
                                  aria-expanded={open}
                                >
                                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  <Box size={15} />
                                  <span>{collection.name}</span>
                                  <small>{collection.requests.length}</small>
                                </button>
                                <button
                                  className="tree-more"
                                  title={`Actions for ${collection.name}`}
                                  onClick={(e) => openContext(e, collectionMenu(collection))}
                                >
                                  <Ellipsis size={16} />
                                </button>
                              </div>
                              {open && (
                                <div className="collection-children">
                                  {collection.folders
                                    .filter(
                                      (f) =>
                                        !f.parentId ||
                                        !collection.folders.some((p) => p.id === f.parentId),
                                    )
                                    .map((folder) => renderFolder(collection, folder, 1))}
                                  {collection.requests
                                    .filter(
                                      (r) =>
                                        (!r.folderId ||
                                          !collection.folders.some((f) => f.id === r.folderId)) &&
                                        (matches(r) ||
                                          collection.name
                                            .toLowerCase()
                                            .includes(filter.toLowerCase())),
                                    )
                                    .map((request) => renderRequest(collection, request, 1))}
                                  {!collection.requests.length && !collection.folders.length && (
                                    <button
                                      className="tree-empty"
                                      onClick={() => newSavedRequest(collection)}
                                    >
                                      + Add your first request
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                    ) : (
                      <div className="sidebar-empty">
                        <div className="sidebar-empty-icon">
                          <FolderPlus size={23} />
                        </div>
                        <h3>A home for your APIs</h3>
                        <p>Group requests into collections and keep your workflow organized.</p>
                        <button className="button secondary small" onClick={createCollection}>
                          <Plus size={12} />
                          Create collection
                        </button>
                      </div>
                    )}
                    <button className="add-collection" onClick={createCollection}>
                      <Plus size={14} />
                      New collection
                    </button>
                  </>
                )}
                {nav === 'environments' && (
                  <>
                    <button
                      className="environment-tree-row"
                      onClick={() => setDialog({ kind: 'environments', id: 'globals' })}
                    >
                      <Globe2 size={15} />
                      <span>Globals</span>
                      <small>{ws.globals.length}</small>
                    </button>
                    {ws.environments
                      .filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
                      .map((env) => (
                        <button
                          className={`environment-tree-row ${ws.activeEnvironmentId === env.id ? 'selected' : ''}`}
                          key={env.id}
                          onClick={() => setDialog({ kind: 'environments', id: env.id })}
                        >
                          <span
                            className={`status-dot ${ws.activeEnvironmentId === env.id ? 'green' : ''}`}
                          />
                          <span>{env.name}</span>
                          <small>{env.variables.length}</small>
                        </button>
                      ))}
                    <button
                      className="add-collection"
                      onClick={() => setDialog({ kind: 'environments' })}
                    >
                      <Plus size={14} />
                      Manage environments
                    </button>
                    <p className="sidebar-help">
                      Keep base URLs, tokens, and other values separate from your requests.
                    </p>
                  </>
                )}
                {nav === 'history' && (
                  <>
                    {ws.history
                      .filter((h) =>
                        `${h.request.name} ${h.request.url}`
                          .toLowerCase()
                          .includes(filter.toLowerCase()),
                      )
                      .map((h) => (
                        <button
                          className="history-row"
                          key={h.id}
                          onClick={() => {
                            const r = {
                              ...h.request,
                              id: uid(),
                              collectionId: undefined,
                              folderId: undefined,
                            };
                            store.openRequest(r);
                          }}
                          title={`${h.request.url}\n${new Date(h.at).toLocaleString()}`}
                        >
                          <div>
                            <span className={`method-label ${methodClass(h.request.method)}`}>
                              {h.request.method}
                            </span>
                            <strong>{h.request.name}</strong>
                            <span className={h.status >= 200 && h.status < 400 ? 'green' : 'red'}>
                              {h.status || 'ERR'}
                            </span>
                          </div>
                          <p>{h.request.url}</p>
                          <small>
                            {new Date(h.at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}{' '}
                            · {Math.round(h.duration)} ms
                          </small>
                        </button>
                      ))}
                    {!ws.history.length && (
                      <div className="sidebar-empty">
                        <History size={25} />
                        <h3>Your recent requests</h3>
                        <p>Send a request and it will appear here, ready to run again.</p>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="explorer-footer">
                <span
                  className={`status-dot ${store.saveStatus === 'error' ? 'red' : store.saveStatus === 'saved' ? 'green' : ''}`}
                />
                {store.saveStatus === 'saving'
                  ? 'Saving changes?'
                  : store.saveStatus === 'error'
                    ? 'Changes could not be saved'
                    : 'All changes saved locally'}
              </div>
            </aside>
            <div
              className="resize-sidebar"
              role="separator"
              aria-label="Resize explorer"
              aria-orientation="vertical"
              onPointerDown={(e) => resize('sidebar', e)}
            />
          </>
        )}
        <main className="main-workspace">
          <div className="request-tabs-bar">
            {settings.sidebarCollapsed && (
              <IconButton
                title="Expand explorer"
                onClick={() =>
                  store.change((d) => {
                    d.settings.sidebarCollapsed = false;
                  })
                }
              >
                <PanelLeftOpen size={16} />
              </IconButton>
            )}
            <div className="request-tabs">
              {tabs.map((t) => (
                <div
                  key={t.id}
                  className={`request-tab ${tab?.id === t.id ? 'active' : ''}`}
                  onContextMenu={(e) =>
                    openContext(e, [
                      {
                        label: 'Save request',
                        icon: <Download size={13} />,
                        action: () => {
                          store.change((d) => {
                            d.activeTabId = t.id;
                          });
                          if (t.request.collectionId)
                            store.saveRequest(t.request.collectionId, t.request.folderId);
                          else setDialog({ kind: 'save', tabId: t.id });
                        },
                      },
                      {
                        label: 'Duplicate request',
                        icon: <Copy size={13} />,
                        action: () => duplicateRequest(t.request),
                      },
                      { label: 'Close tab', icon: <X size={13} />, action: () => closeTab(t.id) },
                    ])
                  }
                  draggable
                  onDragStart={(e) => drag(e, { type: 'tab', id: t.id })}
                  onDragOver={stopDrop}
                  onDrop={(e) => {
                    stopDrop(e);
                    const item = readDrag(e);
                    if (item?.type === 'tab')
                      store.change((d) => {
                        const from = d.tabs.findIndex((t) => t.id === item.id);
                        const to = d.tabs.findIndex((v) => v.id === t.id);
                        const [moving] = d.tabs.splice(from, 1);
                        if (moving) d.tabs.splice(to, 0, moving);
                      });
                  }}
                >
                  <button
                    className="tab-select"
                    role="tab"
                    aria-selected={tab?.id === t.id}
                    onClick={() =>
                      store.change((d) => {
                        d.activeTabId = t.id;
                      })
                    }
                    title={t.request.name}
                  >
                    <span className={`method-label ${methodClass(t.request.method)}`}>
                      {t.request.method}
                    </span>
                    <span>{t.request.name}</span>
                  </button>
                  {t.dirty && <span className="dirty-dot" />}
                  <button
                    className="tab-close"
                    data-testid={`close-tab-${t.id}`}
                    title={`Close ${t.request.name}`}
                    aria-label={`Close ${t.request.name}`}
                    onClick={() => closeTab(t.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            <IconButton
              data-testid="new-tab"
              title="New request (Ctrl+T)"
              onClick={() => store.openRequest()}
            >
              <Plus size={17} />
            </IconButton>
            <div className="spacer" />
            <span className="protocol-label">HTTP CLIENT</span>
          </div>
          {tab ? (
            <>
              <div
                className="request-upper"
                style={{ height: Math.min(settings.editorHeight, window.innerHeight - 245) }}
              >
                <RequestEditor
                  key={tab.id}
                  tab={tab}
                  onSave={save}
                  onCode={() => setDialog({ kind: 'code' })}
                  onCookies={() => setDialog({ kind: 'cookies' })}
                  onSettings={() => setDialog({ kind: 'settings' })}
                />
              </div>
              <div
                className="resize-response"
                role="separator"
                aria-label="Resize response panel"
                aria-orientation="horizontal"
                onPointerDown={(e) => resize('editor', e)}
              >
                <span />
              </div>
              <ResponseViewer
                key={tab.id}
                response={store.responses[tab.id]}
                loading={store.busy.includes(tab.id)}
              />
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-symbol">
                <Braces size={44} strokeWidth={1.4} />
              </div>
              <span className="eyebrow">YOUR LOCAL API WORKSPACE</span>
              <h1>Good APIs start here.</h1>
              <p>
                Build, explore, and test your APIs.
                <br />
                Everything you need, right on your desktop.
              </p>
              <div className="inline-actions">
                <button className="button primary" onClick={() => store.openRequest()}>
                  <Plus size={16} />
                  Create a request
                </button>
                <button className="button secondary" onClick={() => setDialog({ kind: 'import' })}>
                  <Upload size={15} />
                  Import collection
                </button>
              </div>
              <div className="welcome-details">
                <span>
                  <CheckCircle2 size={14} />
                  No account required
                </span>
                <span>
                  <LockIcon />
                  Stored on your computer
                </span>
              </div>
            </div>
          )}
        </main>
      </div>
      {consoleOpen && (
        <div className="console-panel">
          <div className="console-heading">
            <strong>
              <Terminal size={14} />
              API Console <span className="count">{store.logs.length}</span>
            </strong>
            <span>Request activity & script output</span>
            <div className="spacer" />
            <button className="text-button" onClick={() => useStore.setState({ logs: [] })}>
              <Trash2 size={12} />
              Clear
            </button>
            <IconButton title="Close console" onClick={() => setConsoleOpen(false)}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="console-lines">
            {store.logs.length ? (
              store.logs.map((log) => (
                <div key={log.id} className={log.kind}>
                  <time>{log.time}</time>
                  <ChevronRight size={12} />
                  <pre>{log.message}</pre>
                </div>
              ))
            ) : (
              <p>Send a request to inspect activity. Script console output appears here.</p>
            )}
          </div>
        </div>
      )}
      <footer className="statusbar">
        <button
          onClick={() => setConsoleOpen(!consoleOpen)}
          className={consoleOpen ? 'active' : ''}
        >
          <Terminal size={12} />
          Console{store.logs.some((l) => l.kind === 'error') && <span className="tiny-dot red" />}
        </button>
        <button onClick={() => setDialog({ kind: 'runner' })}>
          <Play size={11} />
          Runner
        </button>
        <span className="statusbar-divider" />
        <span className="workspace-count">
          {ws.collections.length} collections · {ws.environments.length} environments
        </span>
        <div className="spacer" />
        <span className="storage-status">
          <span className="status-dot green" />
          Local workspace
        </span>
        {!settings.verifyTls && (
          <button className="red" onClick={() => setDialog({ kind: 'settings' })}>
            TLS verification off
          </button>
        )}
        <button
          title="Keyboard shortcuts and settings"
          onClick={() => setDialog({ kind: 'settings' })}
        >
          <CircleHelp size={12} />
        </button>
        <button
          title="Toggle explorer"
          onClick={() =>
            store.change((d) => {
              d.settings.sidebarCollapsed = !d.settings.sidebarCollapsed;
            })
          }
        >
          <PanelLeftOpen size={12} />
        </button>
      </footer>
      {context && (
        <div
          className="context-menu"
          role="menu"
          style={{ left: context.x, top: context.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {context.items.map((item) => (
            <button
              role="menuitem"
              key={item.label}
              className={item.danger ? 'danger-text' : ''}
              onClick={() => {
                setContext(null);
                item.action();
              }}
            >
              {item.icon || <span style={{ width: 13 }} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
      {dialog && <DialogHost dialog={dialog} close={closeDialog} />}
      <div className="toast-stack" aria-live="polite">
        {store.notices.map((n) => (
          <div key={n.id} className={`toast ${n.kind}`}>
            {n.kind === 'error' ? <X size={15} /> : <CheckCircle2 size={15} />}
            <span>{n.message}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() =>
                useStore.setState((s) => ({ notices: s.notices.filter((v) => v.id !== n.id) }))
              }
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
function descendants(collection: Collection, folderId: string) {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of collection.folders)
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
  }
  return ids;
}
function LockIcon() {
  return <CheckCircle2 size={14} />;
}
