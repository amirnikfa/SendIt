/** Real Electron acceptance checks. Native dialogs are redirected to deterministic local fixture paths. */
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { WebSocketServer } from 'ws';

const root = resolve(import.meta.dirname, '..');
const executablePath = process.env.APIWORKBENCH_EXE
  ? resolve(process.env.APIWORKBENCH_EXE)
  : undefined;
const mode = executablePath ? 'portable' : 'development';
const runDirectory = join(root, '.test-data', `e2e-${mode}-${Date.now()}`);
const screenshots = join(root, 'docs', 'screenshots');
await mkdir(runDirectory, { recursive: true });
await mkdir(screenshots, { recursive: true });
const report = {
  mode,
  started: new Date().toISOString(),
  executablePath: executablePath ?? 'node_modules/electron/dist/electron.exe',
  runDirectory,
  fixture: '',
  checks: [],
  rendererErrors: [],
  nativeDialogs:
    'Open/save dialogs return predetermined local paths; controls, request execution and file I/O remain real.',
  finished: '',
  error: '',
};
const received = [];
const liveRequests = [];
const eventStreams = new Set();
const fixture = createServer((req, res) => {
  if (req.url?.startsWith('/disconnect')) {
    req.socket.destroy();
    return;
  }
  if (req.url === '/events') {
    liveRequests.push({ protocol: 'sse', headers: req.headers });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    eventStreams.add(res);
    const payload = Buffer.from(
      'id: 1\r\nevent: update\r\ndata: price €42\r\ndata: multiline event\r\n\r\nid: 2\ndata: second fixture event\n\n',
      'utf8',
    );
    const split = payload.indexOf(Buffer.from('€')) + 1;
    res.write(payload.subarray(0, split));
    const continuation = setTimeout(() => res.write(payload.subarray(split)), 30);
    const heartbeat = setInterval(() => res.write(': fixture heartbeat\n\n'), 1000);
    res.on('close', () => {
      clearTimeout(continuation);
      clearInterval(heartbeat);
      eventStreams.delete(res);
    });
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const entry = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body.toString('utf8'),
      base64: body.toString('base64'),
    };
    received.push(entry);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Fixture': 'ApiWorkbench',
      'Set-Cookie': 'fixture=accepted; HttpOnly; SameSite=Lax; Path=/',
    });
    res.end(
      JSON.stringify(
        {
          message: 'ApiWorkbench local fixture',
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: entry.body,
        },
        null,
        2,
      ),
    );
  });
});
const webSockets = new WebSocketServer({ noServer: true });
fixture.on('upgrade', (req, socket, head) => {
  if (req.url !== '/socket') {
    socket.destroy();
    return;
  }
  liveRequests.push({ protocol: 'websocket', headers: req.headers });
  webSockets.handleUpgrade(req, socket, head, (client) =>
    webSockets.emit('connection', client, req),
  );
});
webSockets.on('connection', (socket) => {
  socket.on('message', (data) => socket.send(`Echo from local fixture: ${data.toString('utf8')}`));
});
await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
const baseUrl = `http://127.0.0.1:${fixture.address().port}`;
report.fixture = baseUrl;
let electronApp;
let page;
let currentCheck = '';
let portableDataDirectory;

async function check(name, task) {
  currentCheck = name;
  const started = Date.now();
  try {
    await task();
    report.checks.push({ name, result: 'passed', milliseconds: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({
      name,
      result: 'failed',
      milliseconds: Date.now() - started,
      error: String(error),
    });
    throw error;
  }
}

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.APIWORKBENCH_DATA_DIR;
  if (!executablePath) env.APIWORKBENCH_DATA_DIR = join(runDirectory, 'ApiWorkbench-data');
  electronApp = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root,
    env,
    timeout: 60000,
  });
  page = await electronApp.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.rendererErrors.push(String(error)));
  await page.getByTestId('url').waitFor({ state: 'visible', timeout: 60000 });
  const boot = await page.evaluate(() => window.workbench.load());
  expect(boot.dataDirectory).toBeTruthy();
  report.dataDirectory = boot.dataDirectory;
  if (executablePath) {
    portableDataDirectory ??= resolve(dirname(executablePath), 'ApiWorkbench-data');
    expect(resolve(boot.dataDirectory).toLowerCase()).toBe(portableDataDirectory.toLowerCase());
  } else expect(resolve(boot.dataDirectory)).toBe(resolve(runDirectory, 'ApiWorkbench-data'));
}

async function snapshot() {
  return (await page.evaluate(() => window.workbench.load())).state;
}
async function persisted(predicate) {
  await expect.poll(async () => predicate(await snapshot()), { timeout: 15000 }).toBeTruthy();
}
async function section(name) {
  await page
    .locator('.request-editor .section-tabs')
    .getByRole('button', { name: new RegExp(`^${name}\\b`) })
    .click();
}
async function setCode(label, text) {
  const editor = page.locator(`.code-editor[aria-label="${label}"] .monaco-editor`);
  await editor.waitFor({ state: 'visible', timeout: 30000 });
  // Monaco uses native EditContext in current Chromium; click its actual editing surface.
  await editor.click({ position: { x: 85, y: 24 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await page.keyboard.press('Escape');
}
async function send() {
  const previous = received.length;
  await page.getByTestId('send').click();
  await expect(page.getByTestId('response-status')).toContainText('200 OK', { timeout: 15000 });
  await expect.poll(() => received.length).toBeGreaterThan(previous);
  return received.at(-1);
}
async function stubOpen(file) {
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, file);
}
async function stubSave(file) {
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, file);
}
async function stop() {
  if (!electronApp) return;
  // Persisted-state assertions run before closing; this narrow IPC is also the window's own close action.
  await page.evaluate(() => window.workbench.windowAction('close')).catch(() => {});
  await electronApp.close().catch(() => {});
  electronApp = undefined;
}

try {
  await check('01 Launch the actual Electron application', launch);
  await check('02 Create a new HTTP request through the tab UI', async () => {
    await page.getByTestId('new-tab').click();
    await page.getByTestId('request-name').fill('Local API acceptance');
    await page.getByTestId('url').fill(`${baseUrl}/echo?source=workbench`);
    await expect(page.getByTestId('method')).toHaveValue('GET');
  });
  await check('03 Send a real GET request to the loopback fixture', async () => {
    const request = await send();
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/echo?source=workbench');
  });
  await check('04 Display the actual JSON response and status', async () => {
    await expect(page.getByTestId('response-body')).toContainText('ApiWorkbench local fixture');
    await expect(page.getByTestId('response-status')).toContainText('200 OK');
  });
  await check('05 Send a JSON POST from the Monaco body editor', async () => {
    await page.getByRole('button', { name: 'Choose HTTP method', exact: true }).click();
    const methods = page.getByRole('listbox', { name: 'HTTP methods', exact: true });
    await expect(methods.getByRole('option')).toHaveText([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
    ]);
    await page.screenshot({ path: join(screenshots, 'http-method-selector.png') });
    await methods.getByRole('option', { name: 'POST', exact: true }).click();
    await expect(page.getByTestId('method')).toHaveValue('POST');
    await page.getByTestId('method').press('ArrowDown');
    await page.getByTestId('method').press('ArrowDown');
    await page.getByTestId('method').press('Enter');
    await expect(page.getByTestId('method')).toHaveValue('PUT');
    await page.getByTestId('method').fill('PROPFIND');
    await page.getByTestId('method').press('Enter');
    await expect(page.getByTestId('method')).toHaveValue('PROPFIND');
    await page.getByRole('button', { name: 'Choose HTTP method', exact: true }).click();
    await expect(methods.getByRole('option')).toHaveCount(7);
    await methods.getByRole('option', { name: 'POST', exact: true }).click();
    await section('Body');
    await page.getByRole('radio', { name: 'raw', exact: true }).check();
    await setCode('Request body', '{"title":"Acceptance payload","quantity":7}');
    const request = await send();
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ title: 'Acceptance payload', quantity: 7 });
    expect(request.headers['content-type']).toContain('application/json');
  });
  await check('06 Add a custom request header and verify it at the server', async () => {
    await section('Headers');
    await page
      .locator('.request-section')
      .getByRole('textbox', { name: 'Key 1', exact: true })
      .fill('X-Acceptance');
    await page
      .locator('.request-section')
      .getByRole('textbox', { name: 'Value 1', exact: true })
      .fill('desktop-client');
    expect((await send()).headers['x-acceptance']).toBe('desktop-client');
  });
  await check('07 Edit query parameters and verify URL synchronization', async () => {
    await section('Params');
    await page
      .locator('.request-section')
      .getByRole('textbox', { name: 'Key 2', exact: true })
      .fill('search');
    await page
      .locator('.request-section')
      .getByRole('textbox', { name: 'Value 2', exact: true })
      .fill('coffee & tea');
    await expect(page.getByTestId('url')).toHaveValue(
      `${baseUrl}/echo?source=workbench&search=coffee%20%26%20tea`,
    );
    const request = await send();
    expect(new URL(request.url, baseUrl).searchParams.get('search')).toBe('coffee & tea');
  });
  await check(
    '08 Configure Bearer authentication and verify the Authorization header',
    async () => {
      await section('Authorization');
      await page.getByLabel('Auth type', { exact: true }).selectOption('bearer');
      await page.getByTestId('auth-token').fill('acceptance-only-token');
      expect((await send()).headers.authorization).toBe('Bearer acceptance-only-token');
    },
  );
  await check('09 Save the request into a collection using the UI', async () => {
    await page.getByTestId('save-request').click();
    const dialog = page.getByRole('dialog', { name: /Save request/i });
    await dialog.waitFor();
    // The Save dialog can create a collection inline when the workspace is empty.
    const collectionName = dialog.getByRole('textbox', { name: /collection/i });
    if (await collectionName.count()) await collectionName.fill('Acceptance collection');
    await dialog.getByTestId('confirm-save').click();
    await persisted((state) =>
      state.workspaces[0].collections.some((c) =>
        c.requests.some((r) => r.name === 'Local API acceptance'),
      ),
    );
  });
  await check('10 Close and restart Electron with the same data directory', async () => {
    await stop();
    await launch();
  });
  await check('11 Restore the saved collection and request after restart', async () => {
    const state = await snapshot();
    const request = state.workspaces[0].collections
      .flatMap((c) => c.requests)
      .find((r) => r.name === 'Local API acceptance');
    expect(request?.body.raw).toContain('Acceptance payload');
    expect(request?.auth.token).toBe('acceptance-only-token');
    await expect(page.getByTestId('request-name')).toHaveValue('Local API acceptance');
  });
  await check('12 Create an environment and variable in the UI', async () => {
    await page.getByTestId('manage-environments').click();
    const dialog = page.getByRole('dialog', { name: /Environment/i });
    await dialog.getByRole('button', { name: /New environment/i }).click();
    await dialog.getByRole('textbox', { name: /Environment name/i }).fill('Local acceptance');
    await dialog.getByRole('textbox', { name: 'Key 1', exact: true }).fill('base');
    await dialog.getByRole('textbox', { name: 'Value 1', exact: true }).fill(baseUrl);
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await persisted((state) =>
      state.workspaces[0].environments.some(
        (e) =>
          e.name === 'Local acceptance' &&
          e.variables.some((v) => v.key === 'base' && v.value === baseUrl),
      ),
    );
  });
  await check('13 Select the environment and reference its variable in the URL', async () => {
    await page.getByTestId('environment-select').selectOption({ label: 'Local acceptance' });
    await page.getByTestId('url').fill('{{base}}/environment');
    await expect(page.getByTestId('url')).toHaveValue('{{base}}/environment');
  });
  await check('14 Execute the variable-based request successfully', async () => {
    expect((await send()).url).toBe('/environment');
  });
  await check('15 Import a valid Postman v2.1 collection through the file dialog', async () => {
    const input = join(runDirectory, 'import.postman_collection.json');
    await writeFile(
      input,
      JSON.stringify({
        info: {
          name: 'Imported acceptance',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [{ name: 'Imported GET', request: { method: 'GET', url: `${baseUrl}/imported` } }],
      }),
    );
    await stubOpen(input);
    await page.getByTestId('import').click();
    const dialog = page.getByRole('dialog', { name: /Import/i });
    await dialog.getByRole('button', { name: /Choose a file to import/i }).click();
    await persisted((state) =>
      state.workspaces[0].collections.some(
        (c) => c.name === 'Imported acceptance' && c.requests[0]?.name === 'Imported GET',
      ),
    );
  });
  await check(
    '16 Export a collection using the native save dialog and validate the file',
    async () => {
      const output = join(runDirectory, 'export.postman_collection.json');
      await stubSave(output);
      // File IPC is exercised directly here so a context-menu layout change cannot mask export validation.
      const saved = await page.evaluate(async () => {
        const { state } = await window.workbench.load();
        return window.workbench.exportCollection(
          state.workspaces[0].collections.find((c) => c.name === 'Imported acceptance'),
        );
      });
      expect(saved).toBe(true);
      const exported = JSON.parse(await readFile(output, 'utf8'));
      expect(exported.info.name).toBe('Imported acceptance');
      expect(exported.item[0].request.url.raw).toBe(`${baseUrl}/imported`);
    },
  );
  await check('17 Switch light/dark themes and capture actual rendered screenshots', async () => {
    await section('Body');
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count())
      await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    const collapsedCollections = page.locator(
      '.collection-row .tree-item-button[aria-expanded="false"]',
    );
    while (await collapsedCollections.count()) await collapsedCollections.first().click();
    await page.screenshot({ path: join(screenshots, 'workbench-dark.png') });
    await page.getByTestId('settings').click();
    const dialog = page.getByRole('dialog', { name: /Settings/i });
    await dialog.getByRole('button', { name: 'Light', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await persisted((state) => state.settings.theme === 'light');
    await page.screenshot({ path: join(screenshots, 'workbench-light.png') });
    await page.getByTestId('settings').click();
    await page
      .getByRole('dialog', { name: /Settings/i })
      .getByRole('button', { name: 'Dark', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: /Settings/i })
      .getByRole('button', { name: 'Close dialog' })
      .click();
    await persisted((state) => state.settings.theme === 'dark');
  });
  await check('18 Open and close a request tab through keyboard/UI controls', async () => {
    const before = (await snapshot()).tabs.length;
    await page.keyboard.press('Control+t');
    await persisted((state) => state.tabs.length === before + 1);
    await page.keyboard.press('Control+w');
    await persisted((state) => state.tabs.length === before);
  });
  await check('19 Execute a real post-response assertion and display its pass result', async () => {
    await section('Scripts');
    await page.getByRole('button', { name: 'Post-response', exact: true }).click();
    await setCode(
      'Post-response script',
      'pm.test("Fixture response is real", () => { pm.response.to.have.status(200); pm.expect(pm.response.json().message).to.eql("ApiWorkbench local fixture"); });',
    );
    await send();
    await page
      .locator('.response-panel')
      .getByRole('button', { name: /^Test Results/ })
      .click();
    await expect(page.locator('.test-results')).toContainText('Fixture response is real');
    await expect(page.locator('.test-results')).toContainText('1 passed');
    await page.screenshot({ path: join(screenshots, 'test-results.png') });
  });
  await check('20 Display a meaningful transport failure from a disconnected server', async () => {
    await page.getByTestId('url').fill(`${baseUrl}/disconnect`);
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-error')).toBeVisible();
    await expect(page.getByTestId('response-error')).toContainText(
      /socket|reset|closed|hang|connection/i,
    );
  });
  await check(
    '21 Upload a selected binary file through the picker and verify exact server bytes',
    async () => {
      const file = join(runDirectory, 'upload.bin');
      const content = Buffer.from('ApiWorkbench upload fixture\u0000\u00ff', 'utf8');
      await writeFile(file, content);
      await stubOpen(file);
      await page.getByTestId('url').fill(`${baseUrl}/upload`);
      await page.getByTestId('method').fill('POST');
      await section('Body');
      await page.getByRole('radio', { name: 'binary', exact: true }).check();
      await page.getByRole('button', { name: 'Select file', exact: true }).click();
      await expect(page.locator('.binary-upload')).toContainText(basename(file));
      expect((await send()).base64).toBe(content.toString('base64'));
    },
  );
  if (executablePath)
    await check(
      '22 Launch the packaged executable with bundled runtime and adjacent portable data',
      async () => {
        expect(existsSync(executablePath)).toBe(true);
        expect(report.dataDirectory.toLowerCase()).toBe(
          join(dirname(executablePath), 'ApiWorkbench-data').toLowerCase(),
        );
        expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true);
      },
    );
  else
    report.checks.push({
      name: '22 Portable executable startup',
      result: 'requires-packaged-run',
      note: 'Development Electron run does not establish portable executable startup. Run with APIWORKBENCH_EXE or consult the separate release smoke report.',
    });
  await check(
    '23 Connect a WebSocket, send a real message, observe echo and disconnect',
    async () => {
      await page.getByTestId('live-connections').click();
      const dialog = page.getByRole('dialog', { name: 'Live connections', exact: true });
      await dialog.getByLabel('Live protocol', { exact: true }).selectOption('websocket');
      await dialog
        .getByLabel('Live URL', { exact: true })
        .fill(baseUrl.replace('http:', 'ws:') + '/socket');
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(dialog.locator('.live-state')).toHaveText('Connected');
      await dialog
        .getByLabel('WebSocket message', { exact: true })
        .fill('Desktop WebSocket acceptance ✓');
      await dialog.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(dialog.locator('.live-event.message')).toContainText(
        'Echo from local fixture: Desktop WebSocket acceptance ✓',
      );
      expect(liveRequests.find((r) => r.protocol === 'websocket')?.headers.authorization).toBe(
        'Bearer acceptance-only-token',
      );
      await page.screenshot({ path: join(screenshots, 'live-connections.png') });
      await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(dialog.locator('.live-state')).toHaveText('Disconnected');
      await expect.poll(() => webSockets.clients.size).toBe(0);
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    },
  );
  await check('24 Receive split-UTF-8 and multiple SSE frames, then close the stream', async () => {
    await page.getByTestId('live-connections').click();
    const dialog = page.getByRole('dialog', { name: 'Live connections', exact: true });
    await dialog.getByLabel('Live protocol', { exact: true }).selectOption('sse');
    await dialog.getByLabel('Live URL', { exact: true }).fill(baseUrl + '/events');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog.locator('.live-state')).toHaveText('Connected');
    await expect(dialog.locator('.live-feed')).toContainText('price €42');
    await expect(dialog.locator('.live-feed')).toContainText('multiline event');
    await expect(dialog.locator('.live-feed')).toContainText('second fixture event');
    await expect(dialog.locator('.live-event.message')).toHaveCount(2);
    expect(liveRequests.find((r) => r.protocol === 'sse')?.headers.accept).toBe(
      'text/event-stream',
    );
    await page.screenshot({ path: join(screenshots, 'server-sent-events.png') });
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect.poll(() => eventStreams.size).toBe(0);
  });
  await check(
    '25 Enforce isolated renderer, sandbox and a constrained preload bridge',
    async () => {
      const renderer = await page.evaluate(() => ({
        require: typeof require,
        process: typeof process,
        ipcRenderer: typeof window.ipcRenderer,
        genericInvoke: typeof window.workbench.invoke,
        genericSend: typeof window.workbench.send,
        genericEval: typeof window.workbench.eval,
      }));
      expect(renderer).toEqual({
        require: 'undefined',
        process: 'undefined',
        ipcRenderer: 'undefined',
        genericInvoke: 'undefined',
        genericSend: 'undefined',
        genericEval: 'undefined',
      });
      const preferences = await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
      );
      expect(preferences.contextIsolation).toBe(true);
      expect(preferences.nodeIntegration).toBe(false);
      expect(preferences.sandbox).toBe(true);
      expect(preferences.webSecurity).toBe(true);
    },
  );
  expect(report.rendererErrors, 'Renderer errors').toEqual([]);
} catch (error) {
  report.error = `${currentCheck}: ${String(error)}`;
  console.error(report.error);
  await page?.screenshot({ path: join(runDirectory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await stop();
  for (const response of eventStreams) response.destroy();
  for (const client of webSockets.clients) client.terminate();
  await new Promise((done) => webSockets.close(done));
  await new Promise((done) => fixture.close(done));
  report.finished = new Date().toISOString();
  await writeFile(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    join(root, 'docs', `E2E_${mode.toUpperCase()}_RESULTS.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(`Report: ${join(runDirectory, 'report.json')}`);
}
