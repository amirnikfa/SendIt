/** Extended real-window QA. All edits use UI controls; IPC reads observe persisted state. */
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runDirectory = join(root, '.test-data', `ui-interactions-${Date.now()}`);
const dataDirectory = join(runDirectory, 'SendIt-data');
const screenshots = join(root, 'docs', 'screenshots');
await mkdir(runDirectory, { recursive: true });
await mkdir(screenshots, { recursive: true });
const report = {
  started: new Date().toISOString(),
  runDirectory,
  dataDirectory,
  checks: [],
  rendererErrors: [],
  nativeDialogs:
    'Native open/save paths and restore confirmation are stubbed only inside this fresh QA workspace. Drag, editing, menus, scripts, networking and filesystem persistence remain real.',
  finished: '',
  error: '',
};
const calls = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    calls.push({
      method: request.method,
      path: request.url,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Interaction-Fixture': 'true',
    });
    response.end(JSON.stringify({ ok: true, endpoint: request.url, fixture: 'UI interactions' }));
  });
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let app;
let page;
let current = '';
let savedDimensions;

async function check(name, task) {
  current = name;
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
  const env = { ...process.env, SENDIT_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.rendererErrors.push(String(error)));
  await page.getByTestId('url').waitFor({ state: 'visible', timeout: 60000 });
}
async function snapshot() {
  return (await page.evaluate(() => window.workbench.load())).state;
}
async function persisted(predicate) {
  await expect.poll(async () => predicate(await snapshot()), { timeout: 15000 }).toBeTruthy();
}
const collection = (state) =>
  state.workspaces[0].collections.find((c) => c.name === 'Interaction collection');
const requestRow = (name) => page.locator('.request-row').filter({ hasText: name });
const folderRow = (name) => page.locator('.folder-row').filter({ hasText: name });
const tabRow = (name) =>
  page.locator('.request-tab').filter({ has: page.locator(`.tab-select[title="${name}"]`) });
async function menu(name, action) {
  await page.getByTitle(`Actions for ${name}`, { exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: typeof action === 'string' }).click();
}
async function nameDialog(title, label, name) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByLabel(label, { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
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
  await editor.click({ position: { x: 85, y: 24 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await page.keyboard.press('Escape');
}
async function settingsData() {
  await page.getByTestId('settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Data', exact: true }).click();
  return dialog;
}
async function saveTo(file) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, file);
}
async function openFrom(file) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, file);
}
async function closeApp() {
  if (!app) return;
  const closing = app.waitForEvent('close', { timeout: 15000 });
  closing.catch(() => {});
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Close window', exact: true })
    .click()
    .catch(() => {});
  await closing;
  app = undefined;
}

try {
  await check('01 Create a collection and nested folders through real context menus', async () => {
    await launch();
    expect((await snapshot()).settings.zoomPercent).toBe(125);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
        ),
      )
      .toBeCloseTo(1.25);
    // Existing drag/resize checks use a 100% coordinate baseline; zoom is exercised below.
    await page.getByTestId('settings').click();
    const initialSettings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(initialSettings.getByLabel('App zoom', { exact: true })).toHaveValue('125');
    await initialSettings.getByLabel('App zoom', { exact: true }).selectOption('100');
    await initialSettings.getByRole('button', { name: 'Done', exact: true }).click();
    await persisted((state) => state.settings.zoomPercent === 100);
    await page.getByTestId('new-collection').click();
    await nameDialog('Create collection', 'Collection name', 'Interaction collection');
    await menu('Interaction collection', 'Add folder');
    await nameDialog('Create folder', 'Folder name', 'Orders');
    await menu('Orders', 'Add nested folder');
    await nameDialog('Create folder', 'Folder name', 'Nested workflow');
    await persisted((state) => {
      const c = collection(state);
      return (
        c?.folders.find((f) => f.name === 'Nested workflow')?.parentId ===
        c?.folders.find((f) => f.name === 'Orders')?.id
      );
    });
    await expect(folderRow('Nested workflow')).toBeVisible();
  });
  await check('02 Save a scripted request in a nested folder and duplicate it', async () => {
    await menu('Nested workflow', 'Add request');
    await page.getByTestId('request-name').fill('First checkpoint');
    await page.getByTestId('url').fill(`${baseUrl}/first`);
    await section('Scripts');
    await page.getByRole('button', { name: 'Post-response', exact: true }).click();
    await setCode(
      'Post-response script',
      'pm.test("HTTP status is 200", () => { pm.response.to.have.status(200); pm.expect(pm.response.json().ok).to.eql(true); });',
    );
    await page.getByTestId('save-request').click();
    await persisted((state) =>
      collection(state)?.requests[0]?.postScript.includes('HTTP status is 200'),
    );
    await menu('First checkpoint', 'Duplicate request');
    await page.getByTestId('request-name').fill('Second checkpoint');
    await page.getByTestId('url').fill(`${baseUrl}/second`);
    await page.getByTestId('save-request').click();
    await persisted((state) => collection(state)?.requests.length === 2);
    const c = collection(await snapshot());
    expect(c.requests[0].id).not.toBe(c.requests[1].id);
    expect(
      c.requests.every(
        (r) => r.folderId === c.folders.find((f) => f.name === 'Nested workflow').id,
      ),
    ).toBe(true);
  });
  await check(
    '03 Move a request with a dialog, drag it between folders, and reorder requests',
    async () => {
      await menu('Second checkpoint', /^Move request/);
      const dialog = page.getByRole('dialog', { name: 'Save request', exact: true });
      await dialog.getByLabel('Folder', { exact: true }).selectOption({ label: 'Orders' });
      await dialog.getByTestId('confirm-save').click();
      await persisted((state) => {
        const c = collection(state);
        return (
          c.requests.find((r) => r.name === 'Second checkpoint').folderId ===
          c.folders.find((f) => f.name === 'Orders').id
        );
      });
      await requestRow('Second checkpoint').dragTo(folderRow('Nested workflow'));
      await persisted((state) => {
        const c = collection(state);
        return (
          c.requests.find((r) => r.name === 'Second checkpoint').folderId ===
          c.folders.find((f) => f.name === 'Nested workflow').id
        );
      });
      await requestRow('Second checkpoint').dragTo(requestRow('First checkpoint'));
      await persisted((state) => collection(state).requests[0].name === 'Second checkpoint');
      await folderRow('Orders').getByRole('button', { name: 'Orders', exact: true }).click();
      await expect(requestRow('First checkpoint')).toHaveCount(0);
      await folderRow('Orders').getByRole('button', { name: 'Orders', exact: true }).click();
      await expect(requestRow('First checkpoint')).toBeVisible();
    },
  );
  await check('04 Reorder request tabs with a real drag operation', async () => {
    await tabRow('Second checkpoint').dragTo(tabRow('First checkpoint'));
    await persisted(
      (state) =>
        state.tabs.findIndex((t) => t.request.name === 'Second checkpoint') <
        state.tabs.findIndex((t) => t.request.name === 'First checkpoint'),
    );
    await tabRow('First checkpoint').getByRole('tab').click();
    await expect(page.getByTestId('request-name')).toHaveValue('First checkpoint');
  });
  await check(
    '05 Resize and collapse panels; render at the minimum 900 by 640 window',
    async () => {
      const before = (await snapshot()).settings;
      const explorer = await page
        .getByRole('separator', { name: 'Resize explorer', exact: true })
        .boundingBox();
      await page.mouse.move(explorer.x + explorer.width / 2, explorer.y + 70);
      await page.mouse.down();
      await page.mouse.move(explorer.x + explorer.width / 2 + 48, explorer.y + 70, { steps: 8 });
      await page.mouse.up();
      await persisted((state) => state.settings.sidebarWidth >= before.sidebarWidth + 40);
      const response = await page
        .getByRole('separator', { name: 'Resize response panel', exact: true })
        .boundingBox();
      await page.mouse.move(response.x + response.width / 2, response.y + response.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        response.x + response.width / 2,
        response.y + response.height / 2 + 50,
        { steps: 8 },
      );
      await page.mouse.up();
      await persisted((state) => state.settings.editorHeight >= before.editorHeight + 40);
      await page.getByRole('button', { name: 'Collapse explorer', exact: true }).click();
      await expect(page.locator('.explorer')).toHaveCount(0);
      await page.getByRole('button', { name: 'Expand explorer', exact: true }).click();
      await expect(page.locator('.explorer')).toBeVisible();
      savedDimensions = (await snapshot()).settings;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([900, 640]);
      await expect(page.getByTestId('send')).toBeVisible();
      while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count())
        await page
          .getByRole('button', { name: 'Dismiss notification', exact: true })
          .first()
          .click();
      await page.screenshot({ path: join(screenshots, 'sendit-minimum-window.png') });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1440, 940),
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440);
    },
  );
  await check(
    '06 Run two saved requests sequentially and inspect genuine assertion results',
    async () => {
      const before = calls.length;
      await page
        .locator('.workspace-bar')
        .getByRole('button', { name: 'Runner', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Collection runner', exact: true });
      await dialog
        .getByLabel('Collection', { exact: true })
        .selectOption(collection(await snapshot()).id);
      await dialog.getByRole('button', { name: 'Run collection', exact: true }).click();
      await expect(dialog.locator('.runner-result')).toHaveCount(2);
      await expect(
        dialog.getByRole('button', { name: 'Run collection', exact: true }),
      ).toBeVisible();
      expect(calls.slice(before).map((r) => r.path)).toEqual(['/second', '/first']);
      await expect(dialog.locator('.runner-summary strong.green')).toHaveText('2');
      await dialog.locator('.runner-result summary').nth(0).click();
      await dialog.locator('.runner-result summary').nth(1).click();
      await expect(dialog.locator('.runner-test')).toHaveCount(2);
      await expect(dialog.locator('.runner-test .green')).toHaveCount(2);
      await page.screenshot({ path: join(screenshots, 'collection-runner.png') });
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    },
  );
  await check('07 Export and reimport an environment, including a secret variable', async () => {
    const file = join(runDirectory, 'environment.json');
    await saveTo(file);
    await page.getByTestId('manage-environments').click();
    const dialog = page.getByRole('dialog', { name: 'Environments & variables', exact: true });
    await dialog.getByRole('button', { name: 'New environment', exact: true }).click();
    await dialog
      .getByRole('textbox', { name: 'Environment name', exact: true })
      .fill('Interaction environment');
    await dialog.getByRole('textbox', { name: 'Key 1', exact: true }).fill('base');
    await dialog.getByRole('textbox', { name: 'Value 1', exact: true }).fill(baseUrl);
    await dialog.getByRole('textbox', { name: 'Key 2', exact: true }).fill('api_token');
    await dialog.getByRole('textbox', { name: 'Value 2', exact: true }).fill('fixture-secret-only');
    await dialog.getByRole('checkbox', { name: 'Mark api_token secret', exact: true }).check();
    await dialog.getByRole('button', { name: 'Set active', exact: true }).click();
    await dialog.getByRole('button', { name: 'Export environment', exact: true }).click();
    await expect.poll(() => existsSync(file)).toBe(true);
    const exported = JSON.parse(await readFile(file, 'utf8'));
    expect(exported.values.find((v) => v.key === 'api_token')).toMatchObject({
      type: 'secret',
      value: 'fixture-secret-only',
    });
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await openFrom(file);
    await page.getByTestId('import').click();
    await page
      .getByRole('dialog', { name: 'Import into your workspace', exact: true })
      .getByRole('button', { name: /Choose a file to import/ })
      .click();
    await persisted(
      (state) =>
        state.workspaces[0].environments.filter((e) => e.name === 'Interaction environment')
          .length === 2,
    );
    const environments = (await snapshot()).workspaces[0].environments;
    expect(environments[0].id).not.toBe(environments[1].id);
    expect(environments[1].variables.find((v) => v.key === 'api_token').secret).toBe(true);
  });
  await check(
    '08 Export a backup, change the workspace, and restore the original data',
    async () => {
      const file = join(runDirectory, 'backup.json');
      await saveTo(file);
      let dialog = await settingsData();
      await dialog.getByRole('button', { name: 'Export backup', exact: true }).click();
      await expect.poll(() => existsSync(file)).toBe(true);
      const backup = JSON.parse(await readFile(file, 'utf8'));
      expect(backup.format).toBe('sendit-backup');
      expect(collection(backup.state).requests).toHaveLength(2);
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await page.getByTestId('new-collection').click();
      await nameDialog('Create collection', 'Collection name', 'Temporary change to restore');
      await persisted((state) => state.workspaces[0].collections.length === 2);
      await openFrom(file);
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      });
      dialog = await settingsData();
      await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click();
      await dialog.getByRole('button', { name: 'Choose backup and restore', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await persisted(
        (state) =>
          state.workspaces[0].collections.length === 1 &&
          collection(state)?.requests.length === 2 &&
          state.workspaces[0].environments.length === 2,
      );
      await expect(
        page.getByTitle('Actions for Temporary change to restore', { exact: true }),
      ).toHaveCount(0);
    },
  );
  await check(
    '09 Flush an immediately edited tab on native close and restore it on restart',
    async () => {
      await page.getByTestId('request-name').fill('Pending close preserved');
      // Deliberately do not wait for autosave: exercise the application's native close-event flush.
      const closed = app.waitForEvent('close', { timeout: 15000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
      app = undefined;
      await launch();
      const state = await snapshot();
      expect(state.tabs.some((t) => t.request.name === 'Pending close preserved' && t.dirty)).toBe(
        true,
      );
      expect(state.settings.sidebarWidth).toBe(savedDimensions.sidebarWidth);
      expect(state.settings.editorHeight).toBe(savedDimensions.editorHeight);
      await expect(page.getByTestId('request-name')).toHaveValue('Pending close preserved');
      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()),
      ).toEqual([1440, 940]);
    },
  );
  await check(
    '10 Pink theme styles the app and Monaco editors and preserves theme switching',
    async () => {
      await page.getByTestId('settings').click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      for (const [name, theme] of [
        ['Pink', 'pink'],
        ['Light', 'light'],
        ['Dark', 'dark'],
        ['Pink', 'pink'],
      ]) {
        await dialog.getByRole('button', { name, exact: true }).click();
        await expect(dialog.getByRole('button', { name, exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await persisted((state) => state.settings.theme === theme);
      }
      await page.screenshot({ path: join(screenshots, 'appearance-settings.png') });
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await section('Scripts');
      await page.getByRole('button', { name: 'Post-response', exact: true }).click();
      const editor = page.locator('.code-editor[aria-label="Post-response script"] .monaco-editor');
      await expect(editor).toBeVisible();
      await expect(editor).toHaveCSS('background-color', 'rgb(255, 249, 252)');
      await page.screenshot({ path: join(screenshots, 'sendit-pink.png') });
    },
  );
  await check(
    '11 App zoom scales the native window, works inside editors, and rejects invalid values',
    async () => {
      const zoom = () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
        );
      const baselineDpr = (await page.evaluate(() => devicePixelRatio)) / (await zoom());
      await page.getByTestId('settings').click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      const control = dialog.getByLabel('App zoom', { exact: true });
      await expect(
        control.getByRole('option', { name: '125% (default, recommended)', exact: true }),
      ).toHaveAttribute('value', '125');
      for (const level of [75, 150, 200, 125]) {
        await control.selectOption(String(level));
        await expect.poll(zoom).toBeCloseTo(level / 100);
        await persisted((state) => state.settings.zoomPercent === level);
      }
      await expect
        .poll(() => page.evaluate(() => devicePixelRatio))
        .toBeCloseTo(baselineDpr * 1.25);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      const editor = page.locator('.code-editor[aria-label="Post-response script"] .monaco-editor');
      await editor.click({ position: { x: 80, y: 25 } });
      const beforeState = await snapshot();
      const before = beforeState.tabs.find((tab) => tab.id === beforeState.activeTabId)?.request
        .postScript;
      await page.keyboard.press('Control+=');
      await expect.poll(zoom).toBeCloseTo(1.5);
      await page.keyboard.press('Control+-');
      await expect.poll(zoom).toBeCloseTo(1.25);
      await page.keyboard.press('Control+0');
      await expect.poll(zoom).toBeCloseTo(1.25);
      const after = await snapshot();
      expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.request.postScript).toBe(
        before,
      );
      for (const invalid of [0, 74, 201, '125']) {
        expect(
          await page.evaluate(async (value) => {
            try {
              await window.workbench.setZoom(value);
              return false;
            } catch {
              return true;
            }
          }, invalid),
        ).toBe(true);
      }
      await expect.poll(zoom).toBeCloseTo(1.25);
      await page.getByTestId('settings').click();
      await dialog.getByLabel('App zoom', { exact: true }).selectOption('125');
      await expect.poll(zoom).toBeCloseTo(1.25);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await persisted((state) => state.settings.zoomPercent === 125);
      // Electron's native capture includes the entire window at non-default page zoom.
      const zoomScreenshot = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'),
      );
      await writeFile(
        join(screenshots, 'sendit-zoom125.png'),
        Buffer.from(zoomScreenshot, 'base64'),
      );
    },
  );
  await check(
    '12 Pink theme and native zoom persist after restart and remain adjustable in a small window',
    async () => {
      await closeApp();
      await launch();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'pink');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
          ),
        )
        .toBe(1.25);
      expect((await snapshot()).settings.zoomPercent).toBe(125);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
      await page.getByTestId('settings').click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await dialog.getByLabel('App zoom', { exact: true }).selectOption('200');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
          ),
        )
        .toBe(2);
      const close = await page
        .getByRole('button', { name: 'Close window', exact: true })
        .boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(close.x + close.width).toBeLessThanOrEqual(viewport.width);
      await page.keyboard.press('Control+0');
      await expect(dialog.getByLabel('App zoom', { exact: true })).toHaveValue('125');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByTestId('send')).toBeVisible();
    },
  );
  expect(report.rendererErrors).toEqual([]);
} catch (error) {
  report.error = `${current}: ${String(error)}`;
  console.error(report.error);
  await page?.screenshot({ path: join(runDirectory, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await closeApp().catch(async () => {
    await app?.close().catch(() => {});
  });
  await new Promise((done) => server.close(done));
  report.finished = new Date().toISOString();
  await writeFile(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    join(root, 'docs', 'UI_INTERACTIONS_RESULTS.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`Report: ${join(runDirectory, 'report.json')}`);
}
