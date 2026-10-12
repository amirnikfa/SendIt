import { _electron as electron, expect } from '@playwright/test';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runDirectory = join(root, '.test-data', `certificates-ui-${Date.now()}`);
const dataDirectory = join(runDirectory, 'SendIt-data');
await mkdir(runDirectory, { recursive: true });
const report = {
  started: new Date().toISOString(),
  checks: [],
  rendererErrors: [],
  error: '',
  finished: '',
  nativeDialogs:
    'Native file selectors use real test certificate files; requests, TLS handshakes, persistence and Windows DPAPI are real.',
};
const fixture = (name) => join(root, 'tests', 'fixtures', name);
const cert = await readFile(fixture('localhost-cert.pem'));
const key = await readFile(fixture('localhost-key.pem'));
const server = https.createServer(
  { cert, key, ca: cert, requestCert: true, rejectUnauthorized: true },
  (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          client: req.socket.getPeerCertificate().subject.CN,
          authorized: req.socket.authorized,
          tls: true,
        },
        null,
        2,
      ),
    );
  },
);
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `https://127.0.0.1:${port}/identity`;
let app, page;
let current = '';
const snapshot = () => page.evaluate(async () => (await window.workbench.load()).state);
const persisted = (predicate) => expect.poll(async () => predicate(await snapshot())).toBeTruthy();
async function check(name, action) {
  current = name;
  try {
    await action();
    report.checks.push({ name, result: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, result: 'failed', error: String(error) });
    throw error;
  }
}
async function launch() {
  const env = { ...process.env, SENDIT_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.rendererErrors.push(String(error)));
  await page.getByTestId('url').waitFor({ timeout: 60000 });
}
async function close() {
  const closed = app.waitForEvent('close');
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await closed;
  app = undefined;
}
async function settings(tab = 'Certificates') {
  await page.getByTestId('settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: tab, exact: true }).click();
  return dialog;
}
async function openFrom(path) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
}
async function sendSuccess() {
  await page.getByTestId('send').click();
  await expect(page.getByTestId('response-status')).toContainText('200 OK');
  await expect(page.getByTestId('response-body')).toContainText('SendIt Test Client');
}
try {
  await check('01 Default TLS verification rejects the private test CA', async () => {
    await launch();
    await page.getByTestId('url').fill(url);
    await page.getByTestId('request-name').fill('Verified mutual TLS');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-error')).toContainText(/self.signed|unable to verify/i);
  });
  await check(
    '02 Import a CA file and reject malformed certificate files without changing saved trust',
    async () => {
      const dialog = await settings();
      await openFrom(fixture('localhost-cert.pem'));
      await dialog.getByRole('button', { name: 'Add CA certificate', exact: true }).click();
      await persisted(
        (state) =>
          state.settings.tls.caEnabled &&
          state.settings.tls.caCertificates.length === 1 &&
          state.settings.verifyTls,
      );
      const invalid = join(runDirectory, 'invalid.pem');
      await writeFile(invalid, 'not a certificate');
      await openFrom(invalid);
      await dialog.getByRole('button', { name: 'Add CA certificate', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('valid PEM or DER');
      expect((await snapshot()).settings.tls.caCertificates).toHaveLength(1);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByTestId('send').click();
      await expect(page.getByTestId('response-error')).toBeVisible();
      await expect(page.getByTestId('response-error')).not.toContainText(
        /self.signed|unable to verify/i,
      );
    },
  );
  await check(
    '03 Add a CRT/KEY identity through native file selectors and complete a real mTLS request',
    async () => {
      const dialog = await settings();
      await dialog.getByRole('button', { name: 'Add client certificate', exact: true }).click();
      await dialog.getByLabel('Hostname', { exact: true }).fill('127.0.0.1');
      await dialog.getByLabel('Port', { exact: true }).fill(String(port));
      await openFrom(fixture('client-cert.pem'));
      await dialog.getByRole('button', { name: 'Choose client certificate', exact: true }).click();
      await expect(dialog.getByText('client-cert.pem', { exact: true })).toBeVisible();
      await openFrom(fixture('client-key.pem'));
      await dialog.getByRole('button', { name: 'Choose private key', exact: true }).click();
      await expect(dialog.getByText('client-key.pem', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Save client certificate', exact: true }).click();
      await persisted((state) => state.settings.tls.clientCertificates[0]?.format === 'pem');
      await expect(
        dialog.getByRole('form', { name: 'Client certificate configuration' }),
      ).toHaveCount(0);
      await page.screenshot({ path: join(root, 'docs', 'screenshots', 'tls-certificates.png') });
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await sendSuccess();
      await page.screenshot({ path: join(root, 'docs', 'screenshots', 'mtls-response.png') });
    },
  );
  await check(
    '04 Edit to PFX/P12, reject a wrong passphrase, then authenticate with the correct passphrase',
    async () => {
      const dialog = await settings();
      await dialog
        .getByRole('button', { name: `Edit client certificate for 127.0.0.1:${port}`, exact: true })
        .click();
      await dialog.getByLabel('Certificate format', { exact: true }).selectOption('pfx');
      await openFrom(fixture('client-identity.p12'));
      await dialog.getByRole('button', { name: 'Choose pfx/p12 file', exact: true }).click();
      await expect(dialog.getByText('client-identity.p12', { exact: true })).toBeVisible();
      await dialog.getByLabel('Passphrase (optional)', { exact: true }).fill('wrong-passphrase');
      await dialog.getByRole('button', { name: 'Save client certificate', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText(
        'Client certificate could not be loaded',
      );
      expect((await snapshot()).settings.tls.clientCertificates[0].format).toBe('pem');
      await dialog.getByLabel('Passphrase (optional)', { exact: true }).fill('fixture-passphrase');
      await dialog.getByRole('button', { name: 'Save client certificate', exact: true }).click();
      await persisted((state) => state.settings.tls.clientCertificates[0]?.format === 'pfx');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await sendSuccess();
    },
  );
  await check(
    '05 Disabling and re-enabling a client certificate affects the next handshake',
    async () => {
      let dialog = await settings();
      await dialog
        .getByRole('checkbox', {
          name: `Use client certificate for 127.0.0.1:${port}`,
          exact: true,
        })
        .uncheck();
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByTestId('send').click();
      await expect(page.getByTestId('response-error')).toBeVisible();
      dialog = await settings();
      await dialog
        .getByRole('checkbox', {
          name: `Use client certificate for 127.0.0.1:${port}`,
          exact: true,
        })
        .check();
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await sendSuccess();
    },
  );
  await check(
    '06 Windows-protected client credentials survive restart without plaintext in SQLite',
    async () => {
      await close();
      const database = new DatabaseSync(join(dataDirectory, 'workbench.sqlite'));
      const raw = database.prepare("SELECT value FROM documents WHERE key='state'").get().value;
      database.close();
      expect(raw).not.toContain('fixture-passphrase');
      expect(raw).not.toContain(
        (await readFile(fixture('client-identity.p12'))).toString('base64'),
      );
      expect(raw).toContain('__aw_sealed');
      await launch();
      await expect(page.getByTestId('url')).toHaveValue(url);
      await sendSuccess();
    },
  );
  await check(
    '07 Explicit backup includes certificate credentials and restores deleted TLS settings',
    async () => {
      const backupPath = join(runDirectory, 'tls-backup.json');
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      }, backupPath);
      let dialog = await settings('Data');
      await dialog.getByRole('button', { name: 'Export backup', exact: true }).click();
      await expect
        .poll(async () => {
          try {
            return JSON.parse(await readFile(backupPath, 'utf8')).state.settings.tls
              .clientCertificates[0].passphrase;
          } catch {
            return '';
          }
        })
        .toBe('fixture-passphrase');
      await dialog.getByRole('button', { name: 'Certificates', exact: true }).click();
      await dialog
        .getByRole('button', {
          name: `Remove client certificate for 127.0.0.1:${port}`,
          exact: true,
        })
        .click();
      await dialog
        .getByRole('button', { name: 'Remove CA localhost-cert.pem', exact: true })
        .click();
      await persisted(
        (state) =>
          !state.settings.tls.clientCertificates.length &&
          !state.settings.tls.caCertificates.length,
      );
      await dialog.getByRole('button', { name: 'Data', exact: true }).click();
      await openFrom(backupPath);
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      });
      await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click();
      await dialog.getByRole('button', { name: 'Choose backup and restore', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await persisted(
        (state) =>
          state.settings.tls.clientCertificates.length === 1 &&
          state.settings.tls.caCertificates.length === 1,
      );
      await sendSuccess();
    },
  );
  expect(report.rendererErrors).toEqual([]);
} catch (error) {
  report.error = `${current}: ${String(error)}`;
  console.error(report.error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(runDirectory, 'failure.png') }).catch(() => {});
} finally {
  if (app) await close().catch(() => app?.close());
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  report.finished = new Date().toISOString();
  await writeFile(
    join(root, 'docs', 'CERTIFICATES_UI_RESULTS.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`Report: ${join(root, 'docs', 'CERTIFICATES_UI_RESULTS.json')}`);
}
