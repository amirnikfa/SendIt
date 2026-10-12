import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { release, arch } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const artifact = join(root, 'dist', 'SendIt-Portable-Win-x64.exe');
const folder = join(root, '.test-data', `portable-release-${Date.now()}`);
await mkdir(folder, { recursive: true });
const executable = join(folder, 'SendIt-Portable-Win-x64.exe');
await copyFile(artifact, executable);
const report = {
  artifact,
  size: (await stat(artifact)).size,
  sha256: createHash('sha256')
    .update(await readFile(artifact))
    .digest('hex'),
  started: new Date().toISOString(),
  checks: [],
  runtime: '',
  dataDirectory: '',
  error: '',
  windowsVersion: release(),
  architecture: arch(),
};
const fixture = createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'x-verified-by': 'local-release-fixture',
  });
  res.end(
    JSON.stringify(
      {
        service: 'SendIt! release verification',
        status: 'operational',
        method: req.method,
        path: req.url,
        checks: { realNetwork: true, packagedRuntime: true, portableStorage: true },
      },
      null,
      2,
    ),
  );
});
await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
const portServer = createServer();
await new Promise((done) => portServer.listen(0, '127.0.0.1', done));
const debugPort = portServer.address().port;
await new Promise((done) => portServer.close(done));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SENDIT_DATA_DIR;
delete env.NODE_PATH;
let child;
let browser;
let page;
async function check(name, action) {
  try {
    await action();
    report.checks.push({ name, result: 'passed' });
    console.log('PASS ' + name);
  } catch (e) {
    report.checks.push({ name, result: 'failed', error: String(e) });
    throw e;
  }
}
async function launchPortable() {
  child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    windowsHide: true,
    env,
    cwd: folder,
    stdio: 'ignore',
  });
  child.on('error', (e) => {
    report.error = String(e);
  });
  const until = Date.now() + 120000;
  let ready = false;
  while (Date.now() < until) {
    try {
      const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (result.ok) {
        ready = true;
        report.runtime = (await result.json()).Browser;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 400));
  }
  if (!ready)
    throw new Error(
      'Portable launcher did not expose a running Chromium window within 120 seconds. ' +
        report.error,
    );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  page =
    context.pages().find((p) => p.url().includes('index.html')) ||
    (await context.waitForEvent('page'));
  await page.getByTestId('url').waitFor({ state: 'visible', timeout: 30000 });
  expect(page.url()).toContain('app.asar');
}
async function closePortable() {
  const closed = page.waitForEvent('close', { timeout: 15000 });
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await closed;
  await browser.close();
  browser = undefined;
  if (child.exitCode === null) {
    await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Portable launcher did not exit cleanly.')),
        15000,
      );
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}
try {
  await check('Portable launcher starts directly with its bundled runtime', launchPortable);
  await check('Persistent data is adjacent to the actual portable EXE', async () => {
    const boot = await page.evaluate(() => window.workbench.load());
    report.dataDirectory = boot.dataDirectory;
    expect(resolve(boot.dataDirectory).toLowerCase()).toBe(
      join(folder, 'SendIt-data').toLowerCase(),
    );
    expect((await stat(join(boot.dataDirectory, 'workbench.sqlite'))).size).toBeGreaterThan(0);
  });
  await check('Packaged request executes real native HTTP and renders its response', async () => {
    await page.getByTestId('request-name').fill('Verify portable release');
    await page
      .getByTestId('url')
      .fill(`http://127.0.0.1:${fixture.address().port}/release?source=portable`);
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-status')).toContainText('200 OK', { timeout: 30000 });
    await expect(page.getByTestId('response-body')).toContainText(
      'SendIt! release verification',
    );
  });
  await check('Packaged selector shows all methods and executes a real POST', async () => {
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
    await methods.getByRole('option', { name: 'POST', exact: true }).click();
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-body')).toContainText('"method": "POST"');
    await page.getByRole('button', { name: 'Choose HTTP method', exact: true }).click();
    await methods.getByRole('option', { name: 'GET', exact: true }).click();
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-body')).toContainText('"method": "GET"');
  });
  await check('Bundled QuickJS executes a real assertion inside the portable build', async () => {
    await expect
      .poll(async () => {
        const state = (await page.evaluate(() => window.workbench.load())).state;
        return state.tabs.find((t) => t.id === state.activeTabId).request.url;
      })
      .toContain('/release?source=portable');
    const boot = await page.evaluate(() => window.workbench.load());
    const request = boot.state.tabs.find((t) => t.id === boot.state.activeTabId).request;
    request.postScript =
      'pm.test("Bundled sandbox works", () => { pm.response.to.have.status(200); });';
    const result = await page.evaluate(
      (input) => window.workbench.execute('portable-script-check', input),
      {
        request,
        settings: boot.state.settings,
        globals: [],
        environment: [],
        collectionVariables: [],
      },
    );
    expect(result.response.error, JSON.stringify(result.response)).toBeUndefined();
    expect(result.response.tests).toEqual([{ name: 'Bundled sandbox works', passed: true }]);
  });
  await check('Production renderer has no Node globals', async () => {
    expect(
      await page.evaluate(() => ({
        require: typeof globalThis.require,
        process: typeof globalThis.process,
      })),
    ).toEqual({ require: 'undefined', process: 'undefined' });
  });
  await page.getByTestId('save-request').click();
  const save = page.getByRole('dialog', { name: 'Save request', exact: true });
  await save.getByRole('textbox', { name: 'New collection name' }).fill('Portable verification');
  await save.getByTestId('confirm-save').click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.workbench.load())).state.workspaces[0].collections.length,
    )
    .toBe(1);
  await check('Portable application closes cleanly', closePortable);
  await check('Portable restart restores its saved collection and request', async () => {
    await launchPortable();
    const state = (await page.evaluate(() => window.workbench.load())).state;
    expect(state.workspaces[0].collections[0].name).toBe('Portable verification');
    expect(state.workspaces[0].collections[0].requests[0].name).toBe('Verify portable release');
    await expect(page.getByTestId('request-name')).toHaveValue('Verify portable release');
    await page.getByTestId('send').click();
    await expect(page.getByTestId('response-status')).toContainText('200 OK');
  });
  const collectionToggle = page
    .locator('.collection-row .tree-item-button[aria-expanded="false"]')
    .first();
  if (await collectionToggle.count()) await collectionToggle.click();
  await mkdir(join(root, 'docs', 'screenshots'), { recursive: true });
  await page.screenshot({ path: join(root, 'docs', 'screenshots', 'portable-release.png') });
  await closePortable();
} catch (error) {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (page && !page.isClosed())
    await page.evaluate(() => window.workbench.windowAction('close')).catch(() => {});
  await browser?.close().catch(() => {});
  child?.kill();
  await new Promise((done) => fixture.close(done));
  report.finished = new Date().toISOString();
  await writeFile(
    join(root, 'docs', 'PORTABLE_VERIFICATION.json'),
    JSON.stringify(report, null, 2),
  );
  await writeFile(join(root, 'dist', 'RELEASE.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
