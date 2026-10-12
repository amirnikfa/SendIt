import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import { join, dirname, basename, resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from '../storage/database';
import {
  authSchema,
  collectionSchema,
  environmentSchema,
  executionSchema,
  settingsSchema,
  clientCertificateSchema,
  stateSchema,
  boundedInput,
} from '../shared/validation';
import { HttpEngine } from '../networking/http';
import { LiveEngine } from '../networking/live';
import {
  MAX_CERTIFICATE_BYTES,
  prepareCertificateFile,
  validateClientCertificate,
} from '../networking/certificates';
import { importText, exportCollection, exportEnvironment } from '../services/interchange';

// The portable launcher extracts program files to TEMP; persistent data belongs beside the launcher.
const dataRoot =
  process.env.PORTABLE_EXECUTABLE_DIR ||
  (app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath());
const dataOverride = process.env.SENDIT_DATA_DIR || process.env.APIWORKBENCH_DATA_DIR;
const newDataDirectory = join(dataRoot, 'SendIt-data');
const legacyDataDirectory = join(dataRoot, 'ApiWorkbench-data');
// Reuse an existing workspace after the rename, including its encrypted credentials.
const dataDirectory = dataOverride
  ? resolve(dataOverride)
  : existsSync(newDataDirectory) || !existsSync(legacyDataDirectory)
    ? newDataDirectory
    : legacyDataDirectory;
let startupError: unknown;
try {
  mkdirSync(dataDirectory, { recursive: true });
  const probe = join(dataDirectory, `.write-${randomUUID()}`);
  writeFileSync(probe, '');
  unlinkSync(probe);
  app.setPath('userData', dataDirectory);
  app.setPath('sessionData', join(dataDirectory, 'chromium'));
  app.setAppLogsPath(join(dataDirectory, 'logs'));
} catch (error) {
  startupError = error;
}
app.setName('SendIt!');
let window: BrowserWindow;
let store: Store;
let engine: HttpEngine;
let live: LiveEngine;
let allowClose = false;
const requests = new Map<string, AbortController>();
const allowedFiles = new Set<string>();
const rendererFile = join(__dirname, '../renderer/index.html');

function isRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'file:' &&
      !parsed.search &&
      resolve(fileURLToPath(parsed)).toLowerCase() === resolve(rendererFile).toLowerCase()
    );
  } catch {
    return false;
  }
}

function handle(channel: string, listener: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isRendererUrl(event.senderFrame.url)
    )
      throw new Error('Untrusted IPC sender.');
    return listener(...args);
  });
}
async function writeDialog(name: string, data: string | Buffer, title = 'Save file') {
  const chosen = await dialog.showSaveDialog(window, { title, defaultPath: basename(name) });
  if (chosen.canceled || !chosen.filePath) return false;
  writeFileSync(chosen.filePath, data);
  return true;
}
async function readDialog(title: string) {
  const chosen = await dialog.showOpenDialog(window, {
    title,
    properties: ['openFile'],
    filters: [
      { name: 'JSON or text', extensions: ['json', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (chosen.canceled) return null;
  const file = chosen.filePaths[0];
  if (statSync(file).size > 32 * 1024 * 1024)
    throw new Error('Import file exceeds the 32 MB limit.');
  return readFileSync(file, 'utf8');
}
function registerIpc() {
  handle('certificate:pick', async (value) => {
    const kind = z.enum(['ca', 'certificate', 'privateKey', 'pfx']).parse(value);
    const selected = await dialog.showOpenDialog(window, {
      title:
        kind === 'ca'
          ? 'Select a CA certificate'
          : kind === 'certificate'
            ? 'Select a client certificate'
            : kind === 'privateKey'
              ? 'Select a private key'
              : 'Select a PFX/P12 certificate',
      properties: ['openFile'],
      filters: [
        {
          name: 'Certificate files',
          extensions:
            kind === 'pfx'
              ? ['pfx', 'p12']
              : kind === 'privateKey'
                ? ['key', 'pem']
                : ['pem', 'crt', 'cer'],
        },
      ],
    });
    if (selected.canceled) return null;
    const file = selected.filePaths[0];
    if (statSync(file).size > MAX_CERTIFICATE_BYTES)
      throw new Error('Certificate files must be no larger than 256 KB.');
    return prepareCertificateFile(kind, {
      name: basename(file),
      data: readFileSync(file).toString('base64'),
    });
  });
  handle('certificate:validate', (value) =>
    validateClientCertificate(clientCertificateSchema.parse(boundedInput(value))),
  );
  handle('live:connect', (id, protocol, input) =>
    live.connect(
      z.string().min(1).max(200).parse(id),
      z.enum(['websocket', 'sse']).parse(protocol),
      executionSchema.parse(boundedInput(input)),
    ),
  );
  handle('live:send', (id, text) =>
    live.send(
      z.string().max(200).parse(id),
      z
        .string()
        .max(1024 * 1024)
        .parse(text),
    ),
  );
  handle('live:disconnect', (id) => live.disconnect(z.string().max(200).parse(id)));
  handle('app:load', () => ({ state: store.load(), dataDirectory, version: app.getVersion() }));
  handle('app:save', (value) => store.save(stateSchema.parse(boundedInput(value))));
  handle('request:execute', async (requestId, raw) => {
    const id = z.string().min(1).max(200).parse(requestId);
    if (requests.has(id)) throw new Error('Request already running.');
    if (requests.size >= 8) throw new Error('At most eight requests can run concurrently.');
    const input = executionSchema.parse(boundedInput(raw));
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      return await engine.execute(input, controller.signal);
    } finally {
      requests.delete(id);
      store.saveCookies(engine.serializeCookies());
    }
  });
  handle('request:cancel', (id) => requests.get(z.string().max(200).parse(id))?.abort());
  handle('file:pick', async () => {
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Select a file to upload',
      properties: ['openFile'],
    });
    if (chosen.canceled) return null;
    const file = realpathSync(chosen.filePaths[0]);
    allowedFiles.add(file.toLowerCase());
    store.setMeta('authorizedFiles', [...allowedFiles]);
    return file;
  });
  handle('file:import', async () => {
    const text = await readDialog('Import a Postman collection or environment');
    return text === null ? null : importText(text);
  });
  handle('text:import', (value) =>
    importText(
      z
        .string()
        .max(32 * 1024 * 1024)
        .parse(value),
    ),
  );
  handle('collection:export', (value) => {
    const collection = collectionSchema.parse(boundedInput(value));
    return writeDialog(
      `${collection.name}.postman_collection.json`,
      JSON.stringify(exportCollection(collection), null, 2),
      'Export collection (may include credentials)',
    );
  });
  handle('environment:export', (value) => {
    const env = environmentSchema.parse(boundedInput(value));
    return writeDialog(
      `${env.name}.postman_environment.json`,
      JSON.stringify(exportEnvironment(env), null, 2),
      'Export environment (includes secret values)',
    );
  });
  handle('file:save', (name, content, base64) =>
    writeDialog(
      z.string().max(255).parse(name),
      base64 === true
        ? Buffer.from(
            z
              .string()
              .max(280 * 1024 * 1024)
              .parse(content),
            'base64',
          )
        : z
            .string()
            .max(210 * 1024 * 1024)
            .parse(content),
    ),
  );
  handle('app:backup', () =>
    writeDialog(
      'SendIt-backup.json',
      JSON.stringify(
        {
          format: 'sendit-backup',
          version: 1,
          state: store.load(),
          cookies: engine.serializeCookies(),
        },
        null,
        2,
      ),
      'Export backup — contains unencrypted credentials; store securely',
    ),
  );
  handle('app:restore', async () => {
    const text = await readDialog('Restore SendIt! backup');
    if (text === null) return false;
    const backup = z
      .object({
        format: z.enum(['sendit-backup', 'apiworkbench-backup']),
        version: z.literal(1),
        state: stateSchema,
        cookies: z.string().optional(),
      })
      .parse(JSON.parse(text));
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Replace workspace data?',
      message: 'Restore this backup and replace all current workspaces?',
      detail: 'Export a backup first if you want to keep the current data.',
      buttons: ['Cancel', 'Restore backup'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return false;
    if (requests.size) throw new Error('Cancel active requests before restoring.');
    if (backup.cookies) engine.loadCookies(backup.cookies);
    store.save(backup.state);
    store.saveCookies(engine.serializeCookies());
    return true;
  });
  handle('cookies:list', () => engine.cookies());
  handle('cookies:set', async (url, value) => {
    await engine.setCookie(
      z.string().url().max(8192).parse(url),
      z.string().max(16384).parse(value),
    );
    store.saveCookies(engine.serializeCookies());
  });
  handle('cookies:delete', async (domain, path, key) => {
    await engine.deleteCookie(
      z.string().max(1024).parse(domain),
      z.string().max(8192).parse(path),
      z.string().max(8192).parse(key),
    );
    store.saveCookies(engine.serializeCookies());
  });
  handle('auth:oauth', (auth, settings) =>
    engine.oauth(authSchema.parse(auth), settingsSchema.parse(settings)),
  );
  handle('window:action', (action) => {
    switch (z.enum(['minimize', 'maximize', 'close']).parse(action)) {
      case 'minimize':
        window.minimize();
        break;
      case 'maximize':
        window.isMaximized() ? window.unmaximize() : window.maximize();
        break;
      case 'close':
        allowClose = true;
        window.close();
        break;
    }
  });
  handle('window:zoom', (percent) => {
    window.webContents.setZoomFactor(settingsSchema.shape.zoomPercent.parse(percent) / 100);
  });
}

app
  .whenReady()
  .then(async () => {
    if (startupError) {
      dialog.showErrorBox(
        'Portable data directory is not writable',
        `Move SendIt! to a writable folder and launch again. No profile fallback was used.\n\n${dataDirectory}\n${String(startupError)}`,
      );
      app.quit();
      return;
    }
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Windows credential encryption is unavailable.');
    store = new Store(join(dataDirectory, 'workbench.sqlite'), {
      seal: (value) => safeStorage.encryptString(value).toString('base64'),
      open: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    });
    for (const file of store.getMeta<string[]>('authorizedFiles') ?? []) allowedFiles.add(file);
    engine = new HttpEngine((file) => {
      try {
        return allowedFiles.has(realpathSync(file).toLowerCase());
      } catch {
        return false;
      }
    });
    live = new LiveEngine((event) => {
      if (window && !window.isDestroyed()) window.webContents.send('live:event', event);
    });
    const cookies = store.loadCookies();
    if (cookies) engine.loadCookies(cookies);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    const bounds = store.getMeta<Electron.Rectangle>('windowBounds');
    window = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 900,
      minHeight: 640,
      ...bounds,
      show: false,
      frame: false,
      backgroundColor: '#151719',
      title: 'SendIt!',
      icon: join(__dirname, '../assets/icon.png'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (!allowClose && !window.webContents.isDestroyed()) {
        event.preventDefault();
        window.webContents.send('window:closing');
        return;
      }
      store.setMeta('windowBounds', window.getNormalBounds());
    });
    app.on('second-instance', () => {
      if (window.isMinimized()) window.restore();
      window.focus();
    });
    registerIpc();
    await window.loadFile(rendererFile);
    window.show();
  })
  .catch((error) => {
    dialog.showErrorBox('SendIt! could not start', String(error));
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  for (const controller of requests.values()) controller.abort();
  live?.dispose();
  store?.close();
});
