import { useState } from 'react';
import { FileKey2, Plus, Upload } from 'lucide-react';
import { certificateHost } from '../shared/certificates';
import {
  uid,
  type CertificateFile,
  type CertificateFileKind,
  type ClientCertificate,
} from '../shared/models';
import { Field, Toggle } from './components';
import { useStore } from './store';

export function CertificateSettings() {
  const store = useStore();
  const tls = store.data.settings.tls;
  const [draft, setDraft] = useState<ClientCertificate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const updateDraft = (patch: Partial<ClientCertificate>) =>
    setDraft((value) => value && { ...value, ...patch });

  const pick = async (kind: CertificateFileKind) => {
    setBusy(true);
    setError('');
    try {
      const file = await window.workbench.pickCertificate(kind);
      if (!file) return;
      if (kind === 'ca') {
        if (tls.caCertificates.some((item) => item.data === file.data)) {
          store.notify('This CA certificate is already added.');
          return;
        }
        store.change((state) => {
          state.settings.tls.caCertificates.push(file);
          state.settings.tls.caEnabled = true;
        });
      } else {
        const isPfx =
          file.name.toLowerCase().endsWith('.p12') || file.name.toLowerCase().endsWith('.pfx');
        if (isPfx) {
          updateDraft({ pfx: file, format: 'pfx' });
        } else {
          updateDraft({ [kind]: file });
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setError('');
    setBusy(true);
    try {
      const host = certificateHost(draft.host);
      const port = draft.port && draft.port > 0 ? draft.port : 443;
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Enter a port from 1 to 65535.');
      const certificate: ClientCertificate = {
        ...draft,
        host,
        port,
        passphrase: draft.passphrase || '',
      };
      if (
        tls.clientCertificates.some(
          (item) =>
            item.id !== certificate.id &&
            item.host === certificate.host &&
            item.port === certificate.port,
        )
      )
        throw new Error(
          'A client certificate already exists for this hostname and port. Edit that certificate instead.',
        );
      if (certificate.format === 'pem' && (!certificate.certificate || !certificate.privateKey))
        throw new Error('Choose both a client certificate and its private key.');
      if (certificate.format === 'pfx' && !certificate.pfx)
        throw new Error('Choose a PFX/P12 file.');

      await window.workbench.validateClientCertificate(certificate);

      store.change((state) => {
        const rows = state.settings.tls.clientCertificates;
        const at = rows.findIndex((item) => item.id === certificate.id);
        if (at >= 0) rows[at] = certificate;
        else rows.push(certificate);
      });
      setDraft(null);
      store.notify('Client certificate saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const fileControl = (label: string, kind: CertificateFileKind, file?: CertificateFile) => (
    <div className="field">
      <span>{label}</span>
      <div className="certificate-file-control">
        <button
          type="button"
          className="button secondary"
          onClick={() => void pick(kind)}
          disabled={busy}
        >
          <Upload size={13} />
          Choose {label.toLowerCase()}
        </button>
        <span className="certificate-filename" title={file?.name}>
          {file?.name || 'No file selected'}
        </span>
      </div>
    </div>
  );

  return (
    <div className="certificate-settings">
      <p className="help">
        Certificates apply to HTTPS requests, OAuth token requests, secure WebSocket and SSE
        connections. Changes apply to new connections.
      </p>
      <section aria-label="CA certificates">
        <h3>CA certificates</h3>
        <Toggle
          title="Use custom CA certificates"
          description="Trust your internal CA alongside the default trusted certificates. Keep SSL verification enabled."
          checked={tls.caEnabled}
          onChange={(caEnabled) =>
            store.change((state) => {
              state.settings.tls.caEnabled = caEnabled;
            })
          }
        />
        {tls.caCertificates.map((file, index) => (
          <div className="certificate-row" key={`${file.name}-${index}`}>
            <FileKey2 size={18} />
            <span className="certificate-filename" title={file.name}>
              {file.name}
            </span>
            <button
              className="text-button danger-text"
              aria-label={`Remove CA ${file.name}`}
              disabled={busy}
              onClick={() =>
                store.change((state) => {
                  state.settings.tls.caCertificates.splice(index, 1);
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="button secondary"
          onClick={() => void pick('ca')}
          disabled={busy || tls.caCertificates.length >= 10}
        >
          <Plus size={14} />
          Add CA certificate
        </button>
        <p className="help">
          PEM bundles or DER certificates (.pem, .crt, .cer). Up to 10 files, 256 KB each.
        </p>
      </section>
      <section aria-label="Client certificates">
        <h3>Client certificates (mTLS)</h3>
        <p className="help">
          Client certificates are used to authenticate your identity to the server (Mutual TLS).
          Supports domain names, IP addresses and wildcard domains (e.g. *.example.com). Default
          HTTPS port: 443.
        </p>
        {tls.clientCertificates.map((certificate) => (
          <div className="certificate-row" key={certificate.id}>
            <input
              type="checkbox"
              aria-label={`Use client certificate for ${certificate.host}:${certificate.port}`}
              checked={certificate.enabled}
              disabled={busy}
              onChange={(event) =>
                store.change((state) => {
                  state.settings.tls.clientCertificates.find(
                    (item) => item.id === certificate.id,
                  )!.enabled = event.target.checked;
                })
              }
            />
            <div className="certificate-details">
              <strong>
                {certificate.host}:{certificate.port}
              </strong>
              <span className="certificate-filename">
                {certificate.certificate?.name || certificate.pfx?.name}
              </span>
            </div>
            <button
              className="text-button"
              aria-label={`Edit client certificate for ${certificate.host}:${certificate.port}`}
              disabled={busy}
              onClick={() => {
                setDraft(structuredClone(certificate));
                setError('');
              }}
            >
              Edit
            </button>
            <button
              className="text-button danger-text"
              aria-label={`Remove client certificate for ${certificate.host}:${certificate.port}`}
              disabled={busy}
              onClick={() => {
                store.change((state) => {
                  state.settings.tls.clientCertificates =
                    state.settings.tls.clientCertificates.filter(
                      (item) => item.id !== certificate.id,
                    );
                });
                if (draft?.id === certificate.id) setDraft(null);
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {!draft && (
          <button
            className="button secondary"
            aria-label="Add client certificate"
            disabled={busy || tls.clientCertificates.length >= 20}
            onClick={() => {
              setDraft({
                id: uid(),
                enabled: true,
                host: '',
                port: 443,
                format: 'pem',
                passphrase: '',
              });
              setError('');
            }}
          >
            <Plus size={14} />
            Add Certificate
          </button>
        )}
        {draft && (
          <form
            className="certificate-form"
            aria-label="Client certificate configuration"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy}>
              <div className="two-fields">
                <Field label="Hostname">
                  <input
                    aria-label="Hostname"
                    value={draft.host}
                    placeholder="api.example.com, *.example.com, or *"
                    onChange={(event) => {
                      const val = event.target.value;
                      if (/^https?:\/\//i.test(val)) {
                        try {
                          const u = new URL(val);
                          updateDraft({
                            host: u.hostname,
                            port: u.port ? Number(u.port) : draft.port || 443,
                          });
                          return;
                        } catch {}
                      }
                      updateDraft({ host: val });
                    }}
                    spellCheck={false}
                  />
                  <p className="help" style={{ fontSize: 11, marginTop: 4 }}>
                    Destination server host (e.g. api.example.com), comma-separated hosts, or * for
                    all servers.
                  </p>
                </Field>
                <Field label="Port">
                  <input
                    aria-label="Port"
                    type="number"
                    min={1}
                    max={65535}
                    placeholder="443"
                    value={draft.port || ''}
                    onChange={(event) => updateDraft({ port: Number(event.target.value) })}
                  />
                </Field>
              </div>
              <Field label="Certificate format">
                <select
                  aria-label="Certificate format"
                  value={draft.format}
                  onChange={(event) => {
                    const { id, enabled, host, port } = draft;
                    setDraft({
                      id,
                      enabled,
                      host,
                      port,
                      format: event.target.value as 'pem' | 'pfx',
                      passphrase: '',
                    });
                  }}
                >
                  <option value="pem">CRT / PEM + KEY</option>
                  <option value="pfx">PFX / P12</option>
                </select>
              </Field>
              {draft.format === 'pem' ? (
                <>
                  {fileControl('Client certificate', 'certificate', draft.certificate)}
                  {fileControl('Private key', 'privateKey', draft.privateKey)}
                </>
              ) : (
                fileControl('PFX/P12 file', 'pfx', draft.pfx)
              )}
              <Field label="Passphrase (optional)">
                <input
                  aria-label="Passphrase (optional)"
                  type="password"
                  placeholder="Passphrase"
                  autoComplete="off"
                  value={draft.passphrase}
                  onChange={(event) => updateDraft({ passphrase: event.target.value })}
                />
                <p className="help" style={{ fontSize: 11, marginTop: 4 }}>
                  Passphrase required to decrypt the private key or PFX keystore, if protected.
                </p>
              </Field>
              <div className="inline-actions">
                <button type="submit" className="button primary">
                  Save client certificate
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setDraft(null);
                    setError('');
                  }}
                >
                  Cancel certificate editing
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
      {error && (
        <p className="certificate-error" role="alert">
          {error}
        </p>
      )}
      <p className="help">
        Private keys, PFX/P12 files and passphrases are protected for your Windows account. Exported
        backups include these secrets in plaintext.
      </p>
    </div>
  );
}
