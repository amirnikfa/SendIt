import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Code2,
  Cookie,
  Download,
  FileJson2,
  FolderPlus,
  Globe2,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  Search,
  Settings2,
  Shield,
  Square,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  newCollection,
  ZOOM_LEVELS,
  DEFAULT_APP_ZOOM,
  pair,
  uid,
  type ApiRequest,
  type ApiResponse,
  type Collection,
  type CookieRecord,
  type Environment,
  type Pair,
} from '../shared/models';
import {
  AuthEditor,
  Empty,
  Field,
  IconButton,
  Modal,
  PairTable,
  Toggle,
  copyText,
} from './components';
import { CodeEditor } from './Editor';
import { CertificateSettings } from './CertificateSettings';
import { LiveDialog } from './LiveDialog';
import { toCurl, toHttp, toMarkdown } from '../services/interchange';
import { activeWorkspace, flushSave, requestContext, useStore } from './store';
import { methodClass } from './RequestEditor';

export type DialogState =
  | {
      kind: 'name';
      title: string;
      label: string;
      initial?: string;
      onSubmit: (name: string) => void;
    }
  | { kind: 'confirm'; title: string; message: string; action?: string; onConfirm: () => void }
  | { kind: 'collection'; id: string; folderId?: string }
  | { kind: 'save'; tabId: string }
  | { kind: 'environments'; id?: string }
  | {
      kind:
        'settings' | 'import' | 'cookies' | 'runner' | 'code' | 'search' | 'workspaces' | 'live';
    };
export function DialogHost({ dialog, close }: { dialog: DialogState; close: () => void }) {
  if (dialog.kind === 'live') return <LiveDialog onClose={close} />;
  if (dialog.kind === 'name') return <NameDialog {...dialog} close={close} />;
  if (dialog.kind === 'confirm')
    return (
      <Modal
        title={dialog.title}
        onClose={close}
        width={460}
        footer={
          <>
            <button className="button secondary" onClick={close}>
              Cancel
            </button>
            <button
              className="button danger"
              onClick={() => {
                dialog.onConfirm();
                close();
              }}
            >
              {dialog.action || 'Delete'}
            </button>
          </>
        }
      >
        <p className="confirm-message">{dialog.message}</p>
      </Modal>
    );
  if (dialog.kind === 'save') return <SaveDialog tabId={dialog.tabId} close={close} />;
  if (dialog.kind === 'collection')
    return <CollectionDialog id={dialog.id} folderId={dialog.folderId} close={close} />;
  if (dialog.kind === 'environments')
    return <EnvironmentsDialog initialId={dialog.id} close={close} />;
  if (dialog.kind === 'settings') return <SettingsDialog close={close} />;
  if (dialog.kind === 'import') return <ImportDialog close={close} />;
  if (dialog.kind === 'cookies') return <CookiesDialog close={close} />;
  if (dialog.kind === 'runner') return <RunnerDialog close={close} />;
  if (dialog.kind === 'code') return <CodeDialog close={close} />;
  if (dialog.kind === 'search') return <SearchDialog close={close} />;
  return <WorkspacesDialog close={close} />;
}
function NameDialog({
  title,
  label,
  initial = '',
  onSubmit,
  close,
}: Extract<DialogState, { kind: 'name' }> & { close: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal
      title={title}
      onClose={close}
      width={450}
      footer={
        <>
          <button className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!name.trim()}
            onClick={() => {
              onSubmit(name.trim());
              close();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Field label={label}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              onSubmit(name.trim());
              close();
            }
          }}
        />
      </Field>
    </Modal>
  );
}
function SaveDialog({ tabId, close }: { tabId: string; close: () => void }) {
  const data = useStore((s) => s.data);
  const store = useStore();
  const ws = activeWorkspace(data);
  const tab = data.tabs.find((t) => t.id === tabId);
  const [collectionId, setCollectionId] = useState(
    tab?.request.collectionId || ws.collections[0]?.id || '',
  );
  const [folderId, setFolderId] = useState(tab?.request.folderId || '');
  const [name, setName] = useState(tab?.request.name || '');
  const [newName, setNewName] = useState('');
  const collection = ws.collections.find((c) => c.id === collectionId);
  return (
    <Modal
      title="Save request"
      subtitle="Keep your request organized in a collection."
      width={520}
      onClose={close}
      footer={
        <>
          <button className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            data-testid="confirm-save"
            className="button primary"
            disabled={!name.trim() || (!collectionId && !newName.trim())}
            onClick={() => {
              const target = newName.trim() ? store.createCollection(newName.trim()) : collectionId;
              store.change((d) => {
                d.activeTabId = tabId;
              });
              store.editRequest({ name: name.trim() });
              store.saveRequest(target, newName ? undefined : folderId || undefined);
              close();
            }}
          >
            Save request
          </button>
        </>
      }
    >
      <Field label="Request name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Collection">
        <select
          aria-label="Collection"
          value={newName ? '' : collectionId}
          onChange={(e) => {
            setCollectionId(e.target.value);
            setNewName('');
            setFolderId('');
          }}
        >
          <option value="">Choose a collection</option>
          {ws.collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {collection && !newName && (
        <Field label="Folder">
          <select
            aria-label="Folder"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">Collection root</option>
            {collection.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderPath(collection, f.id)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="or-divider">
        <span>or create a new collection</span>
      </div>
      <Field label="New collection name">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g. Payments API"
        />
      </Field>
    </Modal>
  );
}
function folderPath(collection: Collection, id: string): string {
  const parts: string[] = [];
  const visited = new Set<string>();
  let folder = collection.folders.find((f) => f.id === id);
  while (folder && !visited.has(folder.id)) {
    visited.add(folder.id);
    parts.unshift(folder.name);
    folder = collection.folders.find((f) => f.id === folder!.parentId);
  }
  return parts.join(' / ');
}
function CollectionDialog({
  id,
  folderId,
  close,
}: {
  id: string;
  folderId?: string;
  close: () => void;
}) {
  const store = useStore();
  const ws = activeWorkspace(store.data);
  const collection = ws.collections.find((c) => c.id === id);
  const entity = folderId ? collection?.folders.find((f) => f.id === folderId) : collection;
  const [tab, setTab] = useState('Overview');
  if (!entity || !collection) return null;
  const update = (patch: Record<string, unknown>) =>
    store.change((d) => {
      const c = activeWorkspace(d).collections.find((c) => c.id === id)!;
      Object.assign(folderId ? c.folders.find((f) => f.id === folderId)! : c, patch);
    });
  return (
    <Modal
      title={folderId ? 'Folder settings' : 'Collection settings'}
      subtitle="Changes are saved automatically to this workspace."
      onClose={close}
      width={880}
      footer={
        <>
          <span className="footer-note">
            <CheckCircle2 size={13} />
            Saved locally
          </span>
          <button className="button secondary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="dialog-tabs">
        {[
          'Overview',
          'Authorization',
          ...(!folderId ? ['Variables'] : []),
          'Pre-request',
          'Post-response',
        ].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Overview' && (
        <>
          <Field label="Name">
            <input value={entity.name} onChange={(e) => update({ name: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea
              rows={5}
              value={entity.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="Describe this API and how to use it…"
            />
          </Field>
          {!folderId && (
            <div className="inline-actions">
              <button
                className="button secondary"
                onClick={() =>
                  void window.workbench
                    .exportCollection(collection)
                    .then((saved) => {
                      if (saved) store.notify('Collection exported');
                    })
                    .catch((e) => store.notify(String(e), 'error'))
                }
              >
                <Download size={14} />
                Export v2.1 JSON
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  const markdown = toMarkdown(collection);
                  void window.workbench
                    .saveFile(`${collection.name.replace(/[^a-z0-9_-]/gi, '_')}.md`, markdown)
                    .catch((e) => store.notify(String(e), 'error'));
                }}
              >
                <BookOpen size={14} />
                Export API docs
              </button>
            </div>
          )}
        </>
      )}
      {tab === 'Authorization' && (
        <AuthEditor inherit={!!folderId} auth={entity.auth} onChange={(auth) => update({ auth })} />
      )}
      {tab === 'Variables' && (
        <PairTable
          rows={collection.variables}
          onChange={(variables) => update({ variables })}
          variables
        />
      )}
      {tab === 'Pre-request' && (
        <CodeEditor
          height={310}
          value={entity.preScript}
          language="javascript"
          onChange={(preScript) => update({ preScript })}
        />
      )}
      {tab === 'Post-response' && (
        <CodeEditor
          height={310}
          value={entity.postScript}
          language="javascript"
          onChange={(postScript) => update({ postScript })}
        />
      )}
    </Modal>
  );
}
function EnvironmentsDialog({ initialId, close }: { initialId?: string; close: () => void }) {
  const store = useStore();
  const ws = activeWorkspace(store.data);
  const [selected, setSelected] = useState(initialId || ws.activeEnvironmentId || 'globals');
  const [confirm, setConfirm] = useState(false);
  const env = ws.environments.find((e) => e.id === selected);
  const variables = selected === 'globals' ? ws.globals : env?.variables || [];
  const update = (rows: Pair[]) =>
    store.change((d) => {
      const w = activeWorkspace(d);
      if (selected === 'globals') w.globals = rows;
      else {
        const e = w.environments.find((e) => e.id === selected);
        if (e) e.variables = rows;
      }
    });
  return (
    <Modal
      title="Environments & variables"
      subtitle="Switch contexts without changing your requests. Use {{variable}} anywhere."
      width={940}
      onClose={close}
      footer={
        <>
          <span className="footer-note">
            <LockKeyhole size={13} />
            Secret values are encrypted at rest for this Windows account.
          </span>
          <button className="button secondary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="manager-layout">
        <aside className="manager-sidebar">
          <button
            className={selected === 'globals' ? 'active' : ''}
            onClick={() => {
              setSelected('globals');
              setConfirm(false);
            }}
          >
            <Globe2 size={15} />
            Globals
          </button>
          <div className="sidebar-label">
            ENVIRONMENTS
            <IconButton
              title="Create environment"
              onClick={() => {
                const id = uid();
                store.change((d) =>
                  activeWorkspace(d).environments.push({
                    id,
                    name: 'New environment',
                    variables: [],
                  }),
                );
                setSelected(id);
              }}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          {ws.environments.map((e) => (
            <button
              key={e.id}
              className={selected === e.id ? 'active' : ''}
              onClick={() => {
                setSelected(e.id);
                setConfirm(false);
              }}
            >
              <span className={`status-dot ${ws.activeEnvironmentId === e.id ? 'green' : ''}`} />
              {e.name}
            </button>
          ))}
          <button
            className="text-button"
            onClick={() => {
              const id = uid();
              store.change((d) =>
                activeWorkspace(d).environments.push({
                  id,
                  name: 'New environment',
                  variables: [],
                }),
              );
              setSelected(id);
            }}
          >
            <Plus size={14} />
            New environment
          </button>
        </aside>
        <div className="manager-main">
          {selected === 'globals' ? (
            <div className="manager-heading">
              <h3>Global variables</h3>
              <span className="muted">Available throughout this workspace</span>
            </div>
          ) : (
            env && (
              <div className="manager-heading">
                <input
                  aria-label="Environment name"
                  value={env.name}
                  onChange={(e) =>
                    store.change((d) => {
                      activeWorkspace(d).environments.find((v) => v.id === selected)!.name =
                        e.target.value;
                    })
                  }
                />
                <div className="inline-actions">
                  <button
                    className={`button ${ws.activeEnvironmentId === selected ? 'secondary' : 'primary'} small`}
                    onClick={() =>
                      store.change((d) => {
                        activeWorkspace(d).activeEnvironmentId = selected;
                      })
                    }
                  >
                    {ws.activeEnvironmentId === selected ? (
                      <>
                        <CheckCircle2 size={13} />
                        Active
                      </>
                    ) : (
                      'Set active'
                    )}
                  </button>
                  <IconButton
                    title="Export environment"
                    onClick={() =>
                      void window.workbench
                        .exportEnvironment(env)
                        .then((ok) => {
                          if (ok) store.notify('Environment exported');
                        })
                        .catch((e) => store.notify(String(e), 'error'))
                    }
                  >
                    <Download size={15} />
                  </IconButton>
                  <IconButton title="Delete environment" onClick={() => setConfirm(true)}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </div>
            )
          )}
          {confirm ? (
            <div className="inline-confirm">
              <p>Delete this environment and its variables?</p>
              <button className="button secondary small" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="button danger small"
                onClick={() => {
                  store.change((d) => {
                    const w = activeWorkspace(d);
                    w.environments = w.environments.filter((e) => e.id !== selected);
                    if (w.activeEnvironmentId === selected) w.activeEnvironmentId = undefined;
                  });
                  setSelected('globals');
                  setConfirm(false);
                }}
              >
                Delete environment
              </button>
            </div>
          ) : (
            <PairTable rows={variables} onChange={update} variables />
          )}
          <p className="help scope-help">
            Scope precedence: global → collection → environment → request/local. The narrowest
            matching scope wins. JSON exports contain plaintext values.
          </p>
        </div>
      </div>
    </Modal>
  );
}
function SettingsDialog({ close }: { close: () => void }) {
  const store = useStore();
  const settings = store.data.settings;
  const [tab, setTab] = useState('General');
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const update = (patch: Partial<typeof settings>) =>
    store.change((d) => {
      Object.assign(d.settings, patch);
    });
  return (
    <Modal
      title="Settings"
      subtitle={`SendIt! ${store.version} · Local by design`}
      width={700}
      onClose={close}
      footer={
        <>
          <span className="footer-note">Changes save automatically</span>
          <button className="button secondary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="dialog-tabs">
        {['General', 'Network', 'Certificates', 'Data', 'Shortcuts'].map((t) => (
          <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'General' && (
        <>
          <Field label="Appearance">
            <div className="theme-picker">
              {(['dark', 'light', 'pink'] as const).map((theme) => (
                <button
                  key={theme}
                  aria-label={theme.charAt(0).toUpperCase() + theme.slice(1)}
                  aria-pressed={settings.theme === theme}
                  className={`theme-card ${theme} ${settings.theme === theme ? 'selected' : ''}`}
                  onClick={() => update({ theme })}
                >
                  <div className="theme-swatch">
                    <i />
                    <div>
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <span>
                    {theme.charAt(0).toUpperCase() + theme.slice(1)}
                    {settings.theme === theme && <CheckCircle2 size={14} />}
                  </span>
                </button>
              ))}
            </div>
          </Field>
          <Field
            label="App zoom"
            hint="Resize text, controls and code editors. Ctrl + / Ctrl − to zoom; Ctrl 0 to reset."
          >
            <select
              aria-label="App zoom"
              value={settings.zoomPercent}
              onChange={(event) => update({ zoomPercent: Number(event.target.value) })}
            >
              {ZOOM_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}%{level === DEFAULT_APP_ZOOM ? ' (default, recommended)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Window title">
            <input value={settings.title} onChange={(e) => update({ title: e.target.value })} />
          </Field>
          <Toggle
            title="Collapse explorer"
            description="Give the request editor more room."
            checked={settings.sidebarCollapsed}
            onChange={(sidebarCollapsed) => update({ sidebarCollapsed })}
          />
        </>
      )}
      {tab === 'Network' && (
        <>
          <Toggle
            title="Verify SSL certificates"
            description="Validate server certificates and hostnames. Keep enabled for normal use."
            checked={settings.verifyTls}
            onChange={(verifyTls) => update({ verifyTls })}
          />
          {!settings.verifyTls && (
            <p className="warning">
              <Shield size={14} />
              Certificate verification is disabled for requests.
            </p>
          )}
          <Toggle
            title="Follow redirects"
            description="Follow HTTP redirects automatically, up to the engine's redirect limit."
            checked={settings.followRedirects}
            onChange={(followRedirects) => update({ followRedirects })}
          />
          <div className="two-fields">
            <Field label="Request timeout (milliseconds)">
              <input
                type="number"
                min={100}
                max={300000}
                value={settings.timeoutMs}
                onChange={(e) =>
                  update({
                    timeoutMs: Math.min(300000, Math.max(100, Number(e.target.value) || 100)),
                  })
                }
              />
            </Field>
            <Field label="Maximum response size (MB)">
              <input
                type="number"
                min={1}
                max={50}
                value={settings.maxResponseMb}
                onChange={(e) =>
                  update({ maxResponseMb: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </Field>
          </div>
          <Field
            label="HTTP / HTTPS proxy"
            hint="Optional. Requests use this proxy; leave empty for direct connections."
          >
            <input
              value={settings.proxyUrl}
              onChange={(e) => update({ proxyUrl: e.target.value })}
              placeholder="http://127.0.0.1:8080"
              spellCheck={false}
            />
          </Field>
        </>
      )}
      {tab === 'Certificates' && <CertificateSettings />}
      {tab === 'Data' && (
        <>
          <div className="data-location">
            <FolderPlus size={22} />
            <div>
              <strong>Your data lives on this computer</strong>
              <code>{store.dataDirectory}</code>
            </div>
          </div>
          <p className="help">
            Collections, environments, open tabs, cookies, and history persist locally. No account
            or application server is required. Secrets are encrypted for this Windows account.
            Export a backup before moving to a different computer; backup JSON contains plaintext
            secrets.
          </p>
          <div className="inline-actions">
            <button
              className="button secondary"
              onClick={() =>
                void flushSave()
                  .then(() => window.workbench.backup())
                  .then((ok) => {
                    if (ok) store.notify('Backup exported');
                  })
                  .catch((e) => store.notify(String(e), 'error'))
              }
            >
              <Download size={14} />
              Export backup
            </button>
            <button
              className="button secondary"
              disabled={restoring}
              onClick={() => setConfirmRestore(true)}
            >
              <Upload size={14} />
              Restore backup
            </button>
          </div>
          {confirmRestore && (
            <div className="inline-confirm">
              <p>
                Restore replaces all current workspaces. Export a backup first if you want to keep
                them.
              </p>
              <button className="button secondary small" onClick={() => setConfirmRestore(false)}>
                Cancel
              </button>
              <button
                className="button danger small"
                onClick={async () => {
                  setRestoring(true);
                  try {
                    await flushSave();
                    if (await window.workbench.restore()) {
                      await store.boot();
                      store.notify('Backup restored');
                      close();
                    }
                  } catch (e) {
                    store.notify(String(e), 'error');
                  } finally {
                    setRestoring(false);
                    setConfirmRestore(false);
                  }
                }}
              >
                Choose backup and restore
              </button>
            </div>
          )}
        </>
      )}
      {tab === 'Shortcuts' && (
        <div className="shortcut-list">
          {[
            ['New request', 'Ctrl + T'],
            ['Save request', 'Ctrl + S'],
            ['Send request', 'Ctrl + Enter'],
            ['Close request tab', 'Ctrl + W'],
            ['Search workspace', 'Ctrl + K'],
            ['Search in code or response', 'Ctrl + F'],
            ['Zoom in', 'Ctrl + +'],
            ['Zoom out', 'Ctrl + −'],
            ['Reset app zoom', 'Ctrl + 0'],
            ['Format code', 'Shift + Alt + F'],
            ['Close dialog', 'Esc'],
          ].map(([label, keys]) => (
            <div key={label}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
function ImportDialog({ close }: { close: () => void }) {
  const store = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const file = async () => {
    setBusy(true);
    try {
      const imported = await window.workbench.importFile();
      if (imported) {
        store.importData(imported);
        close();
      }
    } catch (e) {
      store.notify(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Import into your workspace"
      subtitle="Bring your existing API workflows with you."
      width={700}
      onClose={close}
      footer={
        <>
          <span className="footer-note">Postman Collection v2.1 · Environments · cURL</span>
          <button
            className="button primary"
            disabled={busy || !text.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                store.importData(await window.workbench.importText(text));
                close();
              } catch (e) {
                store.notify(String(e), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}Import text
          </button>
        </>
      }
    >
      <button className="import-dropzone" disabled={busy} onClick={() => void file()}>
        <div>
          <Upload size={23} />
        </div>
        <strong>Choose a file to import</strong>
        <span>Postman collections or environment JSON files</span>
      </button>
      <div className="or-divider">
        <span>or paste raw text</span>
      </div>
      <textarea
        className="import-text mono"
        aria-label="Import text"
        placeholder={
          "curl --request GET 'https://api.example.com/users'\n\nOr paste collection / environment JSON…"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={8}
      />
    </Modal>
  );
}
function CookiesDialog({ close }: { close: () => void }) {
  const notify = useStore((s) => s.notify);
  const [cookies, setCookies] = useState<CookieRecord[]>([]);
  const [url, setUrl] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const refresh = () =>
    void window.workbench
      .cookies()
      .then(setCookies)
      .catch((e) => setError(String(e)));
  useEffect(refresh, []);
  return (
    <Modal
      title="Cookie manager"
      subtitle="Cookies are stored locally and sent automatically for matching domains."
      width={840}
      onClose={close}
      footer={
        <button className="button secondary" onClick={close}>
          Done
        </button>
      }
    >
      {error && <p className="warning">{error}</p>}
      <div className="cookie-list">
        {cookies.length ? (
          <table className="read-table">
            <thead>
              <tr>
                <th>DOMAIN / PATH</th>
                <th>NAME</th>
                <th>VALUE</th>
                <th>FLAGS</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cookies.map((c, i) => (
                <tr key={i}>
                  <td>
                    {c.domain}
                    <small>{c.path}</small>
                  </td>
                  <td>{c.key}</td>
                  <td>
                    <input
                      type="password"
                      aria-label={`Cookie ${c.key}`}
                      value={c.value}
                      readOnly
                    />
                  </td>
                  <td>
                    {[c.secure ? 'Secure' : '', c.httpOnly ? 'HttpOnly' : '']
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </td>
                  <td>
                    <IconButton
                      title={`Delete cookie ${c.key}`}
                      onClick={() =>
                        void window.workbench
                          .deleteCookie(c.domain, c.path, c.key)
                          .then(refresh)
                          .catch((e) => notify(String(e), 'error'))
                      }
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<Cookie size={25} />}
            title="No stored cookies"
            description="Send a request to a server that sets cookies, or add one below."
          />
        )}
      </div>
      <div className="two-fields">
        <Field label="URL">
          <input
            placeholder="https://api.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Cookie (Set-Cookie format)">
          <input
            placeholder="session=value; Path=/; Secure"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      </div>
      <button
        className="button secondary"
        disabled={!url.trim() || !value.trim()}
        onClick={() =>
          void window.workbench
            .setCookie(url, value)
            .then(() => {
              setValue('');
              refresh();
              notify('Cookie added');
            })
            .catch((e) => notify(String(e), 'error'))
        }
      >
        <Plus size={14} />
        Add cookie
      </button>
    </Modal>
  );
}
function RunnerDialog({ close }: { close: () => void }) {
  const store = useStore();
  const ws = activeWorkspace(store.data);
  const [collectionId, setCollectionId] = useState(ws.collections[0]?.id || '');
  const [iterations, setIterations] = useState(1);
  const [delay, setDelay] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<
    { request: string; method: string; response: ApiResponse; iteration: number }[]
  >([]);
  const cancelled = useRef(false);
  const operation = useRef('');
  useEffect(
    () => () => {
      cancelled.current = true;
      if (operation.current) void window.workbench.cancel(operation.current);
    },
    [],
  );
  const collection = ws.collections.find((c) => c.id === collectionId);
  const run = async () => {
    if (!collection) return;
    setRunning(true);
    setResults([]);
    cancelled.current = false;
    const requests = JSON.parse(JSON.stringify(collection.requests)) as ApiRequest[];
    try {
      for (let iteration = 1; iteration <= iterations; iteration++) {
        for (const request of requests) {
          if (cancelled.current) return;
          operation.current = uid();
          const response = await useStore
            .getState()
            .executeRequest(request, operation.current, ws.id);
          setResults((current) => [
            ...current,
            { request: request.name, method: request.method, response, iteration },
          ]);
          if (delay > 0 && !cancelled.current)
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } catch (e) {
      store.notify(String(e), 'error');
    } finally {
      setRunning(false);
      operation.current = '';
    }
  };
  const tests = results.flatMap((r) => r.response.tests);
  const duration = results.reduce((sum, r) => sum + r.response.duration, 0);
  return (
    <Modal
      title="Collection runner"
      subtitle="Run your requests in sequence against the selected environment."
      width={880}
      onClose={close}
      footer={
        <>
          <span className="footer-note">
            {ws.environments.find((e) => e.id === ws.activeEnvironmentId)?.name || 'No environment'}{' '}
            · Changes to variables carry between requests.
          </span>
          <button
            className="button primary"
            disabled={!collection?.requests.length}
            onClick={() => {
              if (running) {
                cancelled.current = true;
                void window.workbench.cancel(operation.current);
              } else void run();
            }}
          >
            {running ? (
              <>
                <Square size={13} />
                Stop run
              </>
            ) : (
              <>
                <Play size={13} fill="currentColor" />
                Run collection
              </>
            )}
          </button>
        </>
      }
    >
      <div className="runner-controls">
        <Field label="Collection">
          <select
            aria-label="Collection"
            value={collectionId}
            disabled={running}
            onChange={(e) => setCollectionId(e.target.value)}
          >
            <option value="">Choose collection</option>
            {ws.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.requests.length} requests)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Iterations">
          <input
            type="number"
            min={1}
            max={100}
            disabled={running}
            value={iterations}
            onChange={(e) => setIterations(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
          />
        </Field>
        <Field label="Delay (ms)">
          <input
            type="number"
            min={0}
            max={10000}
            disabled={running}
            value={delay}
            onChange={(e) => setDelay(Math.max(0, Math.min(10000, Number(e.target.value))))}
          />
        </Field>
      </div>
      {results.length > 0 ? (
        <>
          <div className="runner-summary">
            <div>
              <strong>{results.length}</strong>
              <span>REQUESTS</span>
            </div>
            <div>
              <strong className="green">{tests.filter((t) => t.passed).length}</strong>
              <span>TESTS PASSED</span>
            </div>
            <div>
              <strong className={tests.some((t) => !t.passed) ? 'red' : ''}>
                {tests.filter((t) => !t.passed).length}
              </strong>
              <span>TESTS FAILED</span>
            </div>
            <div>
              <strong>
                {(duration / 1000).toFixed(2)}
                <small>s</small>
              </strong>
              <span>TOTAL TIME</span>
            </div>
          </div>
          <div className="runner-results">
            {results.map((r, i) => (
              <details className="runner-result" key={i}>
                <summary>
                  <span className={`method-label ${methodClass(r.method)}`}>{r.method}</span>
                  <strong>{r.request}</strong>
                  <small>#{r.iteration}</small>
                  <span className={r.response.error || r.response.status >= 400 ? 'red' : 'green'}>
                    {r.response.status || 'ERROR'}
                  </span>
                  <span>{Math.round(r.response.duration)} ms</span>
                </summary>
                {r.response.error && <p className="red">{r.response.error}</p>}
                {r.response.tests.map((t, j) => (
                  <div className="runner-test" key={j}>
                    {t.passed ? (
                      <CheckCircle2 size={13} className="green" />
                    ) : (
                      <XCircle size={13} className="red" />
                    )}
                    <span>
                      {t.name}
                      {t.error && ` — ${t.error}`}
                    </span>
                  </div>
                ))}
              </details>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() =>
              void window.workbench
                .saveFile(
                  'collection-run.json',
                  JSON.stringify(
                    results.map(({ request, method, iteration, response }) => ({
                      request,
                      method,
                      iteration,
                      status: response.status,
                      duration: response.duration,
                      error: response.error,
                      tests: response.tests,
                    })),
                    null,
                    2,
                  ),
                )
                .catch((e) => store.notify(String(e), 'error'))
            }
          >
            <Download size={13} />
            Export run results
          </button>
        </>
      ) : (
        <Empty
          icon={<Play size={24} />}
          title={running ? 'Running collection…' : 'Test an entire workflow'}
          description="Requests run in collection order with inherited authentication and scripts. Inspect each request’s test results when the run completes."
        />
      )}
      {running && (
        <div className="runner-progress">
          <Loader2 className="spin" size={14} />
          Running {results.length + 1} of {(collection?.requests.length || 0) * iterations}…
        </div>
      )}
    </Modal>
  );
}
function CodeDialog({ close }: { close: () => void }) {
  const data = useStore((s) => s.data);
  const request = data.tabs.find((t) => t.id === data.activeTabId)?.request;
  const [format, setFormat] = useState('cURL');
  if (!request) return null;
  const ctx = requestContext(data, request);
  const vars = Object.fromEntries(
    [...ctx.globals, ...ctx.collectionVariables, ...ctx.environment, ...request.variables]
      .filter((v) => v.enabled)
      .map((v) => [v.key, v.value]),
  );
  const interpolate = (input: string) => {
    let result = input;
    for (let i = 0; i < 8; i++) {
      const next = result.replace(
        /\{\{([^{}]+)\}\}/g,
        (raw, name: string) => vars[name.trim()] ?? raw,
      );
      if (next === result) break;
      result = next;
    }
    return result;
  };
  function resolve(value: unknown): unknown {
    if (typeof value === 'string') return interpolate(value);
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    return value;
  }
  const resolved = resolve({
    ...request,
    auth: request.auth.type === 'inherit' ? ctx.inheritedAuth || { type: 'none' } : request.auth,
  }) as ApiRequest;
  const basicSnippet =
    ['none', 'raw', 'graphql'].includes(request.body.mode) && resolved.auth.type !== 'digest';
  let code = '',
    error = '';
  try {
    if (format === 'cURL') code = toCurl(resolved);
    else if (format === 'HTTP') code = toHttp(resolved);
    else {
      const http = toHttp(resolved);
      const [head, ...bodyParts] = http.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const address = lines
        .shift()!
        .replace(/^[^ ]+ /, '')
        .replace(/ HTTP\/1\.1$/, '');
      const headers = Object.fromEntries(
        lines.filter(Boolean).map((line) => {
          const index = line.indexOf(':');
          return [line.slice(0, index), line.slice(index + 1).trim()];
        }),
      );
      code =
        'const response = await fetch(' +
        JSON.stringify(address) +
        ', {\n  method: ' +
        JSON.stringify(resolved.method) +
        ',\n  headers: ' +
        JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ') +
        (bodyParts.length ? ',\n  body: ' + JSON.stringify(bodyParts.join('\r\n\r\n')) : '') +
        '\n});\nconsole.log(response.status, await response.text());';
    }
  } catch (e) {
    error = String(e);
  }
  return (
    <Modal
      title="Code snippet"
      subtitle="Generated from the current request and resolved variable values."
      width={850}
      onClose={close}
      footer={
        <>
          <span className="footer-note">Snippets include credentials. Share with care.</span>
          <button
            className="button secondary"
            disabled={!!error}
            onClick={() => void copyText(code)}
          >
            <Clipboard size={14} />
            Copy code
          </button>
        </>
      }
    >
      <div className="dialog-tabs">
        {['cURL', 'HTTP', ...(basicSnippet ? ['JavaScript'] : [])].map((f) => (
          <button key={f} className={format === f ? 'active' : ''} onClick={() => setFormat(f)}>
            {f}
          </button>
        ))}
      </div>
      {error ? (
        <p className="warning">{error}</p>
      ) : (
        <CodeEditor
          value={code}
          readOnly
          height={370}
          language={format === 'JavaScript' ? 'javascript' : 'shell'}
        />
      )}
      <p className="help">
        {format === 'cURL'
          ? 'POSIX shell quoting (Bash / Git Bash / WSL). Uploaded files must be available at their original paths.'
          : format === 'JavaScript'
            ? 'Fetch uses browser CORS rules when run in a browser. Scripts, cookies, and desktop network settings are not included.'
            : 'HTTP reference format. Scripts and desktop network settings are not included.'}
      </p>
    </Modal>
  );
}
function SearchDialog({ close }: { close: () => void }) {
  const store = useStore();
  const ws = activeWorkspace(store.data);
  const [query, setQuery] = useState('');
  const requests = ws.collections
    .flatMap((c) => c.requests.map((r) => ({ request: r, collection: c.name })))
    .filter(({ request, collection }) =>
      `${request.name} ${request.method} ${request.url} ${collection}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 60);
  return (
    <Modal title="Search workspace" width={700} onClose={close}>
      <div className="search-input">
        <Search size={17} />
        <input
          autoFocus
          aria-label="Search workspace"
          placeholder="Search requests, URLs, collections…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="search-results">
        {requests.length ? (
          requests.map(({ request, collection }) => (
            <button
              key={request.id}
              onClick={() => {
                store.openRequest(request);
                close();
              }}
            >
              <span className={`method-label ${methodClass(request.method)}`}>
                {request.method}
              </span>
              <div>
                <strong>{request.name}</strong>
                <span>
                  {collection} · {request.url || 'No URL'}
                </span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))
        ) : (
          <Empty
            icon={<Search size={24} />}
            title="No matching requests"
            description="Try a different search or save your first request to a collection."
          />
        )}
      </div>
    </Modal>
  );
}
function WorkspacesDialog({ close }: { close: () => void }) {
  const store = useStore();
  const [selected, setSelected] = useState(store.data.activeWorkspaceId);
  const [confirm, setConfirm] = useState(false);
  const ws = store.data.workspaces.find((w) => w.id === selected);
  if (!ws) return null;
  return (
    <Modal
      title="Local workspaces"
      subtitle="Organize independent projects, environments, and history."
      width={760}
      onClose={close}
      footer={
        <button className="button secondary" onClick={close}>
          Done
        </button>
      }
    >
      <div className="manager-layout">
        <aside className="manager-sidebar">
          {store.data.workspaces.map((w) => (
            <button
              key={w.id}
              className={selected === w.id ? 'active' : ''}
              onClick={() => {
                setSelected(w.id);
                setConfirm(false);
              }}
            >
              <Globe2 size={14} />
              {w.name}
            </button>
          ))}
          <button
            onClick={() => {
              const id = uid();
              store.change((d) =>
                d.workspaces.push({
                  id,
                  name: 'New workspace',
                  collections: [],
                  environments: [],
                  globals: [],
                  history: [],
                }),
              );
              setSelected(id);
            }}
          >
            <Plus size={14} />
            New workspace
          </button>
        </aside>
        <div className="manager-main">
          <Field label="Workspace name">
            <input
              value={ws.name}
              onChange={(e) =>
                store.change((d) => {
                  d.workspaces.find((w) => w.id === selected)!.name = e.target.value;
                })
              }
            />
          </Field>
          <p className="help">
            {ws.collections.length} collections · {ws.environments.length} environments ·{' '}
            {ws.history.length} history entries
          </p>
          <div className="inline-actions">
            <button
              className="button primary"
              onClick={() => {
                store.change((d) => {
                  d.activeWorkspaceId = selected;
                  d.activeTabId = d.tabs.find((t) => t.workspaceId === selected)?.id || '';
                });
                close();
              }}
            >
              {selected === store.data.activeWorkspaceId ? 'Open workspace' : 'Switch workspace'}
            </button>
            <button
              className="button secondary"
              disabled={store.data.workspaces.length === 1}
              onClick={() => setConfirm(true)}
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
          {confirm && (
            <div className="inline-confirm">
              <p>Delete “{ws.name}” and all of its data? This cannot be undone.</p>
              <button className="button secondary small" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="button danger small"
                onClick={() => {
                  store.change((d) => {
                    d.workspaces = d.workspaces.filter((w) => w.id !== selected);
                    d.tabs = d.tabs.filter((t) => t.workspaceId !== selected);
                    if (d.activeWorkspaceId === selected) {
                      d.activeWorkspaceId = d.workspaces[0].id;
                      d.activeTabId =
                        d.tabs.find((t) => t.workspaceId === d.activeWorkspaceId)?.id || '';
                    }
                  });
                  setSelected(store.data.workspaces.find((w) => w.id !== selected)!.id);
                  setConfirm(false);
                }}
              >
                Delete workspace
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
