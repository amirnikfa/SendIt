import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { pair, uid, type Auth, type Pair } from '../shared/models';
import { requestContext, useStore } from './store';

export function IconButton({
  children,
  title,
  onClick,
  className = '',
  disabled = false,
  ...rest
}: {
  children: ReactNode;
  title: string;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  'data-testid'?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}
export function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  width = 680,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLInputElement>('input, textarea, select, button')?.focus(),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('.monaco-editor')) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const elements = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || []),
        ].filter((n) => n.offsetParent !== null);
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        ref={ref}
      >
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton title="Close dialog" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
export function PairTable({
  rows,
  onChange,
  variables = false,
  files = false,
  title = '',
  bulk = true,
}: {
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  variables?: boolean;
  files?: boolean;
  title?: string;
  bulk?: boolean;
}) {
  const [mode, setMode] = useState<'table' | 'bulk'>('table');
  const [showSecrets, setShowSecrets] = useState(false);
  const [emptyId, setEmptyId] = useState(uid);
  const [bulkText, setBulkText] = useState('');
  const patch = (id: string, value: Partial<Pair>) => {
    if (id === emptyId) {
      onChange([...rows, { ...pair(), id, ...value }]);
      setEmptyId(uid());
    } else onChange(rows.map((r) => (r.id === id ? { ...r, ...value } : r)));
  };
  const swap = (index: number, direction: number) => {
    const result = [...rows];
    [result[index], result[index + direction]] = [result[index + direction], result[index]];
    onChange(result);
  };
  const display = [...rows, { id: emptyId, key: '', value: '', enabled: true } as Pair];
  return (
    <div className="pair-section">
      <div className="table-toolbar">
        <span>
          {title || (variables ? 'Variables' : 'Key-value editor')}
          {rows.filter((r) => r.enabled && r.key).length > 0 && (
            <b className="count">{rows.filter((r) => r.enabled && r.key).length}</b>
          )}
        </span>
        <div className="inline-actions">
          {variables && (
            <button className="text-button" onClick={() => setShowSecrets(!showSecrets)}>
              {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
              {showSecrets ? 'Hide secrets' : 'Show secrets'}
            </button>
          )}
          {bulk && (
            <button
              className="text-button"
              onClick={() => {
                if (mode === 'table')
                  setBulkText(
                    rows.map((r) => `${r.enabled ? '' : '// '}${r.key}: ${r.value}`).join('\n'),
                  );
                setMode(mode === 'table' ? 'bulk' : 'table');
              }}
            >
              {mode === 'table' ? 'Bulk edit' : 'Key-value edit'}
            </button>
          )}
        </div>
      </div>
      {mode === 'bulk' ? (
        <div className="bulk-editor">
          <p className="help">
            One key: value per line. Start a line with // to disable it. Apply replaces the table;
            descriptions and secret flags are preserved for matching keys.
          </p>
          <textarea
            aria-label="Bulk key values"
            spellCheck={false}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
          />
          <button
            className="button secondary small"
            onClick={() => {
              onChange(
                bulkText
                  .split('\n')
                  .filter((l) => l.trim())
                  .map((line) => {
                    const enabled = !line.startsWith('//');
                    const clean = enabled ? line : line.slice(2).trim();
                    const i = clean.indexOf(':');
                    const key = (i < 0 ? clean : clean.slice(0, i)).trim();
                    return {
                      ...pair(),
                      ...rows.find((r) => r.key === key),
                      key,
                      value: i < 0 ? '' : clean.slice(i + 1).trim(),
                      enabled,
                    };
                  }),
              );
              setMode('table');
            }}
          >
            Apply changes
          </button>
        </div>
      ) : (
        <div className="table-scroll">
          <table className={`pair-table ${variables ? 'variables' : ''}`}>
            <thead>
              <tr>
                <th className="check-cell" />
                <th>KEY</th>
                <th>VALUE</th>
                <th>DESCRIPTION</th>
                {variables && <th className="secret-cell">SECRET</th>}
                <th className="row-actions" />
              </tr>
            </thead>
            <tbody>
              {display.map((row, index) => (
                <tr
                  key={row.id}
                  className={`${!row.enabled ? 'disabled-row' : ''} ${index === rows.length ? 'empty-row' : ''}`}
                >
                  <td className="check-cell">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${row.key || 'row'}`}
                      checked={row.enabled}
                      onChange={(e) => patch(row.id, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Key ${index + 1}`}
                      placeholder="Key"
                      value={row.key}
                      onChange={(e) => patch(row.id, { key: e.target.value })}
                      spellCheck={false}
                    />
                  </td>
                  <td className="value-cell">
                    <div>
                      {files && (
                        <select
                          className="file-type"
                          aria-label={`Value type ${index + 1}`}
                          value={row.type || 'text'}
                          onChange={(e) =>
                            patch(row.id, { type: e.target.value as 'text' | 'file' })
                          }
                        >
                          <option value="text">Text</option>
                          <option value="file">File</option>
                        </select>
                      )}
                      {row.type === 'file' ? (
                        <button
                          className="file-pick"
                          title={row.filePath}
                          onClick={() =>
                            void window.workbench
                              .pickFile()
                              .then((path) => {
                                if (path)
                                  patch(row.id, {
                                    filePath: path,
                                    value: path.split(/[\\/]/).at(-1) || '',
                                    type: 'file',
                                  });
                              })
                              .catch((e) => useStore.getState().notify(String(e), 'error'))
                          }
                        >
                          <FileUp size={13} />
                          {row.filePath?.split(/[\\/]/).at(-1) || 'Select file'}
                        </button>
                      ) : (
                        <input
                          aria-label={`Value ${index + 1}`}
                          placeholder="Value"
                          type={row.secret && !showSecrets ? 'password' : 'text'}
                          value={row.value}
                          spellCheck={false}
                          onChange={(e) => patch(row.id, { value: e.target.value })}
                        />
                      )}
                    </div>
                  </td>
                  <td>
                    <input
                      aria-label={`Description ${index + 1}`}
                      placeholder="Description"
                      value={row.description || ''}
                      onChange={(e) => patch(row.id, { description: e.target.value })}
                    />
                  </td>
                  {variables && (
                    <td className="secret-cell">
                      <input
                        type="checkbox"
                        aria-label={`Mark ${row.key || 'row'} secret`}
                        checked={!!row.secret}
                        onChange={(e) => patch(row.id, { secret: e.target.checked })}
                      />
                    </td>
                  )}
                  <td className="row-actions">
                    {index < rows.length && (
                      <div>
                        <IconButton
                          title="Move row up"
                          onClick={() => swap(index, -1)}
                          disabled={index === 0}
                        >
                          <ArrowUp size={11} />
                        </IconButton>
                        <IconButton
                          title="Move row down"
                          onClick={() => swap(index, 1)}
                          disabled={index === rows.length - 1}
                        >
                          <ArrowDown size={11} />
                        </IconButton>
                        <IconButton
                          title="Delete row"
                          onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
export function AuthEditor({
  auth,
  onChange,
  inherit = true,
}: {
  auth: Auth;
  onChange: (auth: Auth) => void;
  inherit?: boolean;
}) {
  const settings = useStore((s) => s.data.settings);
  const notify = useStore((s) => s.notify);
  const [loading, setLoading] = useState(false);
  const patch = (value: Partial<Auth>) => onChange({ ...auth, ...value });
  const input = (key: keyof Auth, label: string, secret = false, placeholder = '') => (
    <Field label={label}>
      <input
        data-testid={`auth-${key}`}
        value={String(auth[key] || '')}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => patch({ [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <div className="auth-editor">
      <div className="auth-summary">
        <KeyRound size={21} />
        <Field label="Auth type">
          <select
            aria-label="Auth type"
            value={auth.type}
            onChange={(e) => patch({ type: e.target.value as Auth['type'] })}
          >
            {inherit && <option value="inherit">Inherit auth from parent</option>}
            <option value="none">No Auth</option>
            <option value="apikey">API Key</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="digest">Digest Auth</option>
            <option value="oauth2">OAuth 2.0</option>
          </select>
        </Field>
        <p>
          Authorization is applied when you send the request. Use <code>{'{{variables}}'}</code> to
          reference your environment.
        </p>
      </div>
      <div className="auth-fields">
        {auth.type === 'none' && (
          <Empty
            icon={<ShieldCheck size={24} />}
            title="No authorization"
            description="This request does not add authentication. Any custom Authorization header is still sent."
          />
        )}
        {auth.type === 'inherit' && (
          <Empty
            icon={<KeyRound size={24} />}
            title="Use parent authorization"
            description="Authentication comes from the nearest folder or collection. Configure it in the parent's settings."
          />
        )}
        {auth.type === 'bearer' && input('token', 'Token', true, '{{access_token}}')}
        {(auth.type === 'basic' || auth.type === 'digest') && (
          <>
            {input('username', 'Username')}
            {input('password', 'Password', true)}
          </>
        )}
        {auth.type === 'apikey' && (
          <>
            {input('key', 'Key', false, 'X-API-Key')}
            {input('value', 'Value', true, '{{api_key}}')}
            <Field label="Add to">
              <select
                value={auth.addTo || 'header'}
                onChange={(e) => patch({ addTo: e.target.value as 'header' | 'query' })}
              >
                <option value="header">Header</option>
                <option value="query">Query parameters</option>
              </select>
            </Field>
          </>
        )}
        {auth.type === 'oauth2' && (
          <>
            <Field label="Grant type">
              <select
                value={auth.grantType || 'client_credentials'}
                onChange={(e) => patch({ grantType: e.target.value as Auth['grantType'] })}
              >
                <option value="client_credentials">Client credentials</option>
                <option value="refresh_token">Refresh token</option>
              </select>
            </Field>
            {input('tokenUrl', 'Access token URL', false, 'https://api.example.com/oauth/token')}
            {input('clientId', 'Client ID')}
            {input('clientSecret', 'Client secret', true)}
            {auth.grantType === 'refresh_token' && input('refreshToken', 'Refresh token', true)}
            {input('scope', 'Scope', false, 'Optional space-separated scopes')}
            {input('token', 'Access token', true)}
            <button
              className="button secondary"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  const data = useStore.getState().data;
                  const active = data.tabs.find((t) => t.id === data.activeTabId);
                  const scopes = active ? requestContext(data, active.request) : undefined;
                  const values = Object.fromEntries(
                    [
                      ...(scopes?.globals || []),
                      ...(scopes?.collectionVariables || []),
                      ...(scopes?.environment || []),
                      ...(active?.request.variables || []),
                    ]
                      .filter((v) => v.enabled)
                      .map((v) => [v.key, v.value]),
                  );
                  const resolved = { ...auth };
                  for (const key of [
                    'tokenUrl',
                    'clientId',
                    'clientSecret',
                    'scope',
                    'refreshToken',
                  ] as const) {
                    let value = resolved[key] || '';
                    for (let n = 0; n < 10; n++) {
                      const next = value.replace(/\{\{([^{}]+)\}\}/g, (_, name: string) => {
                        if (!(name.trim() in values))
                          throw new Error('Unresolved variable: ' + name);
                        return values[name.trim()];
                      });
                      if (next === value) break;
                      value = next;
                    }
                    if (/\{\{/.test(value))
                      throw new Error('Circular variable in OAuth credentials');
                    resolved[key] = value;
                  }
                  const result = await window.workbench.oauth(resolved, settings);
                  onChange({
                    ...auth,
                    token: result.token,
                    refreshToken: result.refreshToken || auth.refreshToken,
                  });
                  notify('Access token received');
                } catch (e) {
                  notify(String(e), 'error');
                } finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}Get access
              token
            </button>
            <p className="help">
              Client credentials and refresh-token grants. Token endpoint credentials are sent using
              HTTP Basic authentication.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
export async function copyText(value: string, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(value);
    useStore.getState().notify(label);
  } catch (e) {
    useStore.getState().notify(`Clipboard unavailable: ${String(e)}`, 'error');
  }
}
export function Toggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description?: string;
}) {
  return (
    <label className="toggle-row">
      <div>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
    </label>
  );
}
export function Pill({ children, good = false }: { children: ReactNode; good?: boolean }) {
  return <span className={`pill ${good ? 'good' : ''}`}>{children}</span>;
}
