import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Code2,
  Copy,
  Download,
  FileUp,
  Globe2,
  Info,
  Loader2,
  Play,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  ShieldOff,
  Square,
  Terminal,
  WandSparkles,
  XCircle,
} from 'lucide-react';
import {
  newCollection,
  pair,
  type ApiRequest,
  type ApiResponse,
  type Pair,
  type RequestTab,
} from '../shared/models';
import { CodeEditor } from './Editor';
import { toMarkdown } from '../services/interchange';
import { AuthEditor, Empty, Field, IconButton, PairTable, Toggle, copyText } from './components';
import { useStore } from './store';

const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const methodClass = (method: string) =>
  `method-${httpMethods.includes(method) ? method.toLowerCase() : 'custom'}`;

function MethodSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (method: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const show = () => {
    setHighlighted(Math.max(0, httpMethods.indexOf(value)));
    setOpen(true);
  };
  const choose = (method: string) => {
    onChange(method);
    input.current?.focus();
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div
      className="method-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        ref={input}
        className={`method-select ${methodClass(value)}`}
        data-testid="method"
        aria-label="HTTP method"
        role="combobox"
        aria-autocomplete="none"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={64}
        value={value}
        onChange={(event) => {
          onChange(event.target.value.toUpperCase().replace(/\s/g, ''));
          setOpen(false);
        }}
        onFocus={(event) => {
          event.currentTarget.select();
          show();
        }}
        onClick={show}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) show();
            else
              setHighlighted(
                (index) =>
                  (index + (event.key === 'ArrowDown' ? 1 : httpMethods.length - 1)) %
                  httpMethods.length,
              );
          } else if (event.key === 'Enter' && open) {
            event.preventDefault();
            choose(httpMethods[highlighted]);
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          } else if (event.key === 'Tab') setOpen(false);
        }}
      />
      <button
        type="button"
        className="method-picker-toggle"
        aria-label="Choose HTTP method"
        title="Choose HTTP method"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else {
            input.current?.focus();
            show();
          }
        }}
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="method-picker-menu">
          <div id={listId} role="listbox" aria-label="HTTP methods">
            {httpMethods.map((method, index) => (
              <div
                key={method}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={method === value}
                className={`method-picker-option ${methodClass(method)} ${index === highlighted ? 'highlighted' : ''}`}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(method)}
              >
                <span>{method}</span>
                {method === value && <Check size={13} />}
              </div>
            ))}
          </div>
          <div className="method-picker-hint">Or type a custom method</div>
        </div>
      )}
    </div>
  );
}
function queryRows(url: string, previous: Pair[]): Pair[] {
  const i = url.indexOf('?');
  if (i < 0) return previous.filter((p) => !p.enabled);
  const params = new URLSearchParams(url.slice(i + 1).split('#')[0]);
  return [
    ...Array.from(params.entries()).map(([key, value], index) => ({
      ...pair(key, value),
      ...previous.filter((p) => p.enabled)[index],
      key,
      value,
      enabled: true,
    })),
    ...previous.filter((p) => !p.enabled),
  ];
}
function paramsUrl(url: string, params: Pair[]) {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const base = url.split(/[?#]/)[0];
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/%7B/g, '{').replace(/%7D/g, '}');
  const query = params
    .filter((p) => p.enabled && p.key)
    .map((p) => `${encode(p.key)}=${encode(p.value)}`)
    .join('&');
  return base + (query ? `?${query}` : '') + hash;
}

export function RequestEditor({
  tab,
  onSave,
  onCode,
  onCookies,
  onSettings,
}: {
  tab: RequestTab;
  onSave: () => void;
  onCode: () => void;
  onCookies: () => void;
  onSettings: () => void;
}) {
  const request = tab.request;
  const edit = useStore((s) => s.editRequest);
  const execute = useStore((s) => s.execute);
  const busy = useStore((s) => s.busy.includes(tab.id));
  const settings = useStore((s) => s.data.settings);
  const change = useStore((s) => s.change);
  const notify = useStore((s) => s.notify);
  const [section, setSection] = useState('Params');
  const [scriptTab, setScriptTab] = useState<'preScript' | 'postScript'>('preScript');
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useStore(
    (s) => s.data.workspaces.find((w) => w.id === s.data.activeWorkspaceId)?.history || [],
  );
  const body = request.body;
  const bodyPatch = (patch: Partial<ApiRequest['body']>) => edit({ body: { ...body, ...patch } });
  const queryChange = (params: Pair[]) => edit({ params, url: paramsUrl(request.url, params) });
  const urlChange = (url: string) => edit({ url, params: queryRows(url, request.params) });
  const format = () => {
    try {
      const value = body.mode === 'graphql' ? body.graphqlVariables || '{}' : body.raw;
      const formatted = JSON.stringify(JSON.parse(value), null, 2);
      bodyPatch(body.mode === 'graphql' ? { graphqlVariables: formatted } : { raw: formatted });
      notify('JSON formatted');
    } catch (e) {
      notify(`Invalid JSON: ${String(e)}`, 'error');
    }
  };
  return (
    <div className="request-editor">
      <div className="request-heading">
        <div className="request-title">
          <span className={`method-label ${methodClass(request.method)}`}>{request.method}</span>
          <input
            aria-label="Request name"
            data-testid="request-name"
            value={request.name}
            onChange={(e) => edit({ name: e.target.value })}
          />
          <span className="request-type">HTTP</span>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className={`button small ${request.verifyTls === false || !settings.verifyTls ? 'secondary' : 'subtle'}`}
            title={
              request.verifyTls === false || !settings.verifyTls
                ? 'SSL certificate verification is disabled. Click to enable.'
                : 'SSL certificate verification is enabled. Click to disable for this request.'
            }
            onClick={() => {
              const current =
                request.verifyTls !== undefined ? request.verifyTls : settings.verifyTls;
              edit({ verifyTls: !current });
              notify(
                !current
                  ? 'SSL verification enabled for request'
                  : 'SSL verification disabled for request',
              );
            }}
          >
            <ShieldOff
              size={13}
              style={{ opacity: request.verifyTls === false || !settings.verifyTls ? 1 : 0.6 }}
            />
            SSL: {request.verifyTls === false || !settings.verifyTls ? 'Off' : 'On'}
          </button>
          <button className="text-button" onClick={onCode} title="Generate code snippet">
            <Code2 size={14} />
            Code
          </button>
          <button
            className={`button secondary small ${tab.dirty ? '' : 'subtle'}`}
            data-testid="save-request"
            onClick={onSave}
            title="Save request (Ctrl+S)"
          >
            <Download size={13} />
            Save{tab.dirty && <span className="dirty-dot" />}
          </button>
        </div>
      </div>
      <div className="address-row">
        <div className="address-box">
          <MethodSelector value={request.method} onChange={(method) => edit({ method })} />
          <div className="url-wrap">
            <input
              className="url-input"
              data-testid="url"
              aria-label="Request URL"
              placeholder="Enter URL or paste text"
              value={request.url}
              spellCheck={false}
              onChange={(e) => urlChange(e.target.value)}
              onFocus={() => setHistoryOpen(true)}
              onBlur={() => setTimeout(() => setHistoryOpen(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setHistoryOpen(false);
                  void execute();
                }
              }}
            />
            {historyOpen && request.url && (
              <div className="url-suggestions">
                {[...new Set(history.map((h) => h.request.url))]
                  .filter(
                    (url) =>
                      url !== request.url && url.toLowerCase().includes(request.url.toLowerCase()),
                  )
                  .slice(0, 5)
                  .map((url) => (
                    <button
                      key={url}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        urlChange(url);
                        setHistoryOpen(false);
                      }}
                    >
                      <Globe2 size={12} />
                      {url}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
        <button
          className={`button primary send-button ${busy ? 'sending' : ''}`}
          data-testid="send"
          onClick={() => {
            if (busy) void window.workbench.cancel(tab.id);
            else void execute();
          }}
          title={busy ? 'Cancel request' : 'Send request (Ctrl+Enter)'}
        >
          {busy ? (
            <>
              <Square size={12} fill="currentColor" />
              Cancel
            </>
          ) : (
            <>
              Send
              <Send size={15} />
            </>
          )}
        </button>
      </div>
      <div className="editor-nav">
        <div className="section-tabs">
          {['Params', 'Authorization', 'Headers', 'Body', 'Scripts', 'Variables', 'Docs'].map(
            (item) => (
              <button
                key={item}
                className={section === item ? 'active' : ''}
                onClick={() => setSection(item)}
              >
                {item}
                {item === 'Headers' &&
                  request.headers.filter((h) => h.enabled && h.key).length > 0 && (
                    <span className="tab-count">
                      {request.headers.filter((h) => h.enabled && h.key).length}
                    </span>
                  )}
                {item === 'Params' &&
                  request.params.filter((p) => p.enabled && p.key).length > 0 && (
                    <span className="tab-count">
                      {request.params.filter((p) => p.enabled && p.key).length}
                    </span>
                  )}
                {item === 'Body' && body.mode !== 'none' && <span className="tiny-dot" />}
                {item === 'Scripts' && (request.preScript || request.postScript) && (
                  <span className="tiny-dot" />
                )}
              </button>
            ),
          )}
        </div>
        <div className="inline-actions">
          <button className="text-button" onClick={onCookies}>
            Cookies
          </button>
          <IconButton title="Request settings" onClick={onSettings}>
            <Settings2 size={15} />
          </IconButton>
        </div>
      </div>
      <div className="request-section">
        {section === 'Params' && (
          <>
            <PairTable rows={request.params} onChange={queryChange} title="Query parameters" />
            <p className="section-hint">
              <Info size={12} />
              Parameters are encoded and synchronized with the request URL.
            </p>
          </>
        )}
        {section === 'Authorization' && (
          <AuthEditor auth={request.auth} onChange={(auth) => edit({ auth })} />
        )}
        {section === 'Headers' && (
          <>
            <PairTable
              rows={request.headers}
              onChange={(headers) => edit({ headers })}
              title="Request headers"
            />
            <p className="section-hint">
              <Info size={12} />
              Host, connection and content length are handled automatically. Body type sets
              Content-Type unless you override it.
            </p>
          </>
        )}
        {section === 'Variables' && (
          <>
            <PairTable
              rows={request.variables}
              onChange={(variables) => edit({ variables })}
              variables
              title="Request variables"
            />
            <p className="section-hint">
              <Info size={12} />
              Request variables override environment, collection, and global values.
            </p>
          </>
        )}
        {section === 'Body' && (
          <div className="body-section">
            <div className="body-toolbar">
              <div className="body-modes">
                {[
                  ['none', 'none'],
                  ['form-data', 'form-data'],
                  ['urlencoded', 'x-www-form-urlencoded'],
                  ['raw', 'raw'],
                  ['binary', 'binary'],
                  ['graphql', 'GraphQL'],
                ].map(([mode, label]) => (
                  <label key={mode}>
                    <input
                      type="radio"
                      name="body-mode"
                      checked={body.mode === mode}
                      onChange={() => bodyPatch({ mode: mode as ApiRequest['body']['mode'] })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="inline-actions">
                {body.mode === 'raw' && (
                  <select
                    aria-label="Body language"
                    value={body.language}
                    onChange={(e) =>
                      bodyPatch({ language: e.target.value as ApiRequest['body']['language'] })
                    }
                  >
                    {['json', 'text', 'xml', 'html', 'javascript'].map((l) => (
                      <option key={l} value={l}>
                        {l.toUpperCase()}
                      </option>
                    ))}
                  </select>
                )}
                {((body.mode === 'raw' && body.language === 'json') || body.mode === 'graphql') && (
                  <button className="text-button" onClick={format}>
                    <WandSparkles size={12} />
                    Format
                  </button>
                )}
              </div>
            </div>
            {body.mode === 'none' && (
              <Empty
                icon={<Braces size={25} />}
                title="This request does not have a body"
                description="Choose a body type to send data with your request."
              />
            )}
            {body.mode === 'raw' && (
              <div className="body-code" data-testid="body-editor">
                <CodeEditor
                  value={body.raw}
                  language={body.language}
                  onChange={(raw) => bodyPatch({ raw })}
                  label="Request body"
                />
              </div>
            )}
            {(body.mode === 'urlencoded' || body.mode === 'form-data') && (
              <PairTable
                rows={body.fields}
                onChange={(fields) => bodyPatch({ fields })}
                files={body.mode === 'form-data'}
                title={body.mode === 'form-data' ? 'Multipart fields' : 'Form fields'}
                bulk={body.mode !== 'form-data'}
              />
            )}
            {body.mode === 'binary' && (
              <div className="binary-upload">
                <FileUp size={26} />
                <strong>
                  {body.filePath?.split(/[\\/]/).at(-1) || 'Upload a file as the request body'}
                </strong>
                {body.filePath && <p>{body.filePath}</p>}
                <button
                  className="button secondary"
                  onClick={() =>
                    void window.workbench
                      .pickFile()
                      .then((path) => {
                        if (path) bodyPatch({ filePath: path });
                      })
                      .catch((e) => notify(String(e), 'error'))
                  }
                >
                  Select file
                </button>
                <span>The selected file is sent as the request body.</span>
              </div>
            )}
            {body.mode === 'graphql' && (
              <div className="graphql-editors">
                <div>
                  <div className="mini-heading">QUERY</div>
                  <CodeEditor
                    value={body.graphqlQuery || ''}
                    onChange={(graphqlQuery) => bodyPatch({ graphqlQuery })}
                    language="graphql"
                    label="GraphQL query"
                  />
                </div>
                <div>
                  <div className="mini-heading">VARIABLES</div>
                  <CodeEditor
                    value={body.graphqlVariables || '{}'}
                    onChange={(graphqlVariables) => bodyPatch({ graphqlVariables })}
                    label="GraphQL variables"
                  />
                </div>
              </div>
            )}
          </div>
        )}
        {section === 'Scripts' && (
          <div className="scripts-layout">
            <aside>
              <button
                className={scriptTab === 'preScript' ? 'active' : ''}
                onClick={() => setScriptTab('preScript')}
              >
                Pre-request
              </button>
              <button
                className={scriptTab === 'postScript' ? 'active' : ''}
                onClick={() => setScriptTab('postScript')}
              >
                Post-response
              </button>
              <p>Scripts run in an isolated JavaScript runtime.</p>
              <button
                className="text-button"
                onClick={() => {
                  const text =
                    scriptTab === 'postScript'
                      ? 'pm.test("Status is 200", () => {\n  pm.response.to.have.status(200);\n});\n'
                      : 'pm.environment.set("timestamp", Date.now().toString());\n';
                  edit({
                    [scriptTab]: request[scriptTab] + (request[scriptTab] ? '\n' : '') + text,
                  });
                }}
              >
                <PlusIcon />
                Insert example
              </button>
            </aside>
            <CodeEditor
              value={request[scriptTab]}
              onChange={(value) => edit({ [scriptTab]: value })}
              language="javascript"
              label={scriptTab === 'preScript' ? 'Pre-request script' : 'Post-response script'}
            />
          </div>
        )}
        {section === 'Docs' && (
          <div className="request-docs">
            <Field
              label="Description"
              hint="Saved with your request and included in collection exports."
            >
              <textarea
                value={request.description}
                onChange={(e) => edit({ description: e.target.value })}
                placeholder="Describe this endpoint, expected inputs, and how to use it…"
                rows={8}
              />
            </Field>
            <button
              className="button secondary small"
              onClick={() =>
                void window.workbench
                  .saveFile(
                    `${request.name.replace(/[^a-z0-9_-]/gi, '_')}.md`,
                    toMarkdown({ ...newCollection(request.name), requests: [request] }),
                  )
                  .catch((e) => notify(String(e), 'error'))
              }
            >
              <Download size={13} />
              Export documentation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
function PlusIcon() {
  return <span className="plus-sign">+</span>;
}

export function ResponseViewer({
  response,
  loading,
}: {
  response?: ApiResponse;
  loading: boolean;
}) {
  const [section, setSection] = useState('Body');
  const [mode, setMode] = useState<'Pretty' | 'Raw' | 'Preview'>('Pretty');
  const notify = useStore((s) => s.notify);
  const change = useStore((s) => s.change);
  const execute = useStore((s) => s.execute);
  const editRequest = useStore((s) => s.editRequest);
  const isJson = response?.contentType.includes('json') || /^[\s]*[\[{]/.test(response?.body || '');
  const isImage = response?.contentType.startsWith('image/');
  const formatted = useMemo(() => {
    if (!response) return '';
    if (mode === 'Raw' || !isJson) return response.body;
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }, [response, mode, isJson]);
  const language = isJson
    ? 'json'
    : response?.contentType.includes('html')
      ? 'html'
      : response?.contentType.includes('xml')
        ? 'xml'
        : 'text';
  const save = async () => {
    if (!response) return;
    try {
      const extension = isJson
        ? 'json'
        : isImage
          ? response.contentType.split('/')[1]?.split(';')[0] || 'png'
          : 'txt';
      if (await window.workbench.saveFile(`response.${extension}`, response.base64, true))
        notify('Response saved');
    } catch (e) {
      notify(String(e), 'error');
    }
  };
  const limit = 2_000_000;
  return (
    <section className="response-panel" aria-label="Response">
      <div className="response-heading">
        <div className="section-tabs">
          {['Body', 'Headers', 'Cookies', 'Test Results'].map((s) => (
            <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
              {s}
              {response && s === 'Headers' && (
                <span className="tab-count">{response.headers.length}</span>
              )}
              {response && s === 'Cookies' && response.cookies.length > 0 && (
                <span className="tab-count">{response.cookies.length}</span>
              )}
              {response && s === 'Test Results' && response.tests.length > 0 && (
                <span
                  className={`tab-count ${response.tests.some((t) => !t.passed) ? 'red' : 'green'}`}
                >
                  {response.tests.filter((t) => t.passed).length}/{response.tests.length}
                </span>
              )}
            </button>
          ))}
        </div>
        {response && !loading && (
          <div className="response-metrics">
            <span
              className={response.status >= 200 && response.status < 400 ? 'green' : 'red'}
              title="HTTP status"
              data-testid="response-status"
            >
              <span className="status-dot" />
              {response.status || 'Error'} {response.statusText}
            </span>
            <span title="Total request time">
              {Math.round(response.duration).toLocaleString()} <small>ms</small>
            </span>
            <span title={`${response.size.toLocaleString()} bytes`}>
              {response.size >= 1024
                ? `${(response.size / 1024).toFixed(2)} KB`
                : `${response.size} B`}
            </span>
          </div>
        )}
      </div>
      {loading ? (
        <div className="response-loading">
          <Loader2 className="spin" size={28} />
          <h3>Sending request…</h3>
          <p>Waiting for your server to respond</p>
        </div>
      ) : !response ? (
        <Empty
          icon={<Send size={31} strokeWidth={1.3} />}
          title="Ready when you are"
          description="Enter a URL and send your request to see the response here."
        >
          <span className="keyboard-hint">
            <kbd>Ctrl</kbd>
            <span>+</span>
            <kbd>Enter</kbd>
            <span>to send a request</span>
          </span>
        </Empty>
      ) : response.error ? (
        <div className="network-error">
          <XCircle size={26} />
          <div>
            <h3>Could not complete the request</h3>
            <pre data-testid="response-error">{response.error}</pre>
            <p>Check the URL, connection, and request settings, then try again.</p>
            {Boolean(response.error) &&
              /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify the first certificate|SELF_SIGNED_CERT|self.signed certificate|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID|CERT_SIGNATURE_FAILURE/i.test(
                response.error,
              ) && (
                <div style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="button secondary"
                    data-testid="disable-ssl-btn"
                    onClick={() => {
                      editRequest({ verifyTls: false });
                      change((d) => {
                        d.settings.verifyTls = false;
                      });
                      notify('SSL certificate verification disabled. Retrying request...');
                      void execute();
                    }}
                  >
                    <ShieldOff size={14} />
                    Disable SSL verification &amp; Retry
                  </button>
                  <p style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
                    Tip: You can also install the root CA into the Windows Certificate Store or add
                    it under Settings &gt; Certificates.
                  </p>
                </div>
              )}
          </div>
        </div>
      ) : section === 'Body' ? (
        <>
          <div className="response-toolbar">
            <div className="segmented">
              {(['Pretty', 'Raw', 'Preview'] as const).map((m) => (
                <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
                  {m}
                </button>
              ))}
            </div>
            <span className="response-language">
              {language === 'text'
                ? response.contentType.split(';')[0] || 'Text'
                : language.toUpperCase()}
            </span>
            <div className="spacer" />
            <span className="editor-search-hint">Ctrl+F to search</span>
            <IconButton title="Copy response" onClick={() => void copyText(response.body)}>
              <Copy size={14} />
            </IconButton>
            <IconButton title="Save response to file" onClick={() => void save()}>
              <Download size={14} />
            </IconButton>
          </div>
          {formatted.length > limit && (
            <div className="notice-bar">
              Showing the first 2 MB. Save the response to access all{' '}
              {Math.round(response.size / 1024)} KB.
            </div>
          )}
          <div className="response-content" data-testid="response-body">
            {!response.size ? (
              <Empty
                icon={<CheckCircle2 size={24} />}
                title="Empty response"
                description="The server returned no response body."
              />
            ) : mode === 'Preview' && isImage ? (
              <div className="image-preview">
                <img
                  alt="API response"
                  src={`data:${response.contentType.split(';')[0]};base64,${response.base64}`}
                />
              </div>
            ) : mode === 'Preview' && response.contentType.includes('html') ? (
              <iframe
                title="Response HTML preview"
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">${response.body.slice(0, limit)}`}
              />
            ) : (
              <CodeEditor
                value={formatted.slice(0, limit)}
                readOnly
                language={mode === 'Raw' ? 'text' : language}
                label="Response body"
              />
            )}
          </div>
        </>
      ) : section === 'Headers' ? (
        <div className="response-table-scroll">
          <table className="read-table">
            <thead>
              <tr>
                <th>KEY</th>
                <th>VALUE</th>
              </tr>
            </thead>
            <tbody>
              {response.headers.map((h, i) => (
                <tr key={i}>
                  <td>{h.key}</td>
                  <td>{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : section === 'Cookies' ? (
        response.cookies.length ? (
          <div className="response-table-scroll">
            <table className="read-table">
              <thead>
                <tr>
                  <th>SET-COOKIE</th>
                </tr>
              </thead>
              <tbody>
                {response.cookies.map((c, i) => (
                  <tr key={i}>
                    <td className="mono">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={<Circle size={23} />}
            title="No response cookies"
            description="This response did not include a Set-Cookie header."
          />
        )
      ) : (
        <div className="test-results">
          {response.tests.length ? (
            <>
              <div className="test-summary">
                <span className="green">
                  {response.tests.filter((t) => t.passed).length} passed
                </span>
                <span className={response.tests.some((t) => !t.passed) ? 'red' : 'muted'}>
                  {response.tests.filter((t) => !t.passed).length} failed
                </span>
              </div>
              {response.tests.map((test, index) => (
                <div className={`test-row ${test.passed ? 'passed' : 'failed'}`} key={index}>
                  {test.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                  <div>
                    <strong>{test.name}</strong>
                    {test.error && <pre>{test.error}</pre>}
                  </div>
                  <span>{test.passed ? 'PASS' : 'FAIL'}</span>
                </div>
              ))}
            </>
          ) : (
            <Empty
              icon={<CheckCircle2 size={25} />}
              title="Add your first test"
              description="Write assertions in Scripts → Post-response. Test results will appear here after you send the request."
            />
          )}
        </div>
      )}
    </section>
  );
}
