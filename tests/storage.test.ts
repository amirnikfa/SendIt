import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store, type SecretCodec } from '../src/storage/database';
import { initialState, newCollection, newRequest, pair } from '../src/shared/models';
import { stateSchema } from '../src/shared/validation';
import { mkdirSync } from 'node:fs';
const dirs: string[] = [];
const codec: SecretCodec = {
  seal: (value) => Buffer.from(value).toString('base64'),
  open: (value) => Buffer.from(value, 'base64').toString(),
};
function file() {
  mkdirSync('.test-data', { recursive: true });
  const dir = mkdtempSync(join('.test-data', 'storage-'));
  dirs.push(dir);
  return join(dir, 'state.sqlite');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('transactional persistent state', () => {
  it('retains saved requests, drafts, environments and settings after reopen', () => {
    const path = file();
    let store = new Store(path, codec);
    const state = initialState();
    const c = newCollection('Orders API');
    const r = newRequest('List orders');
    r.url = '{{baseUrl}}/orders';
    r.collectionId = c.id;
    c.requests.push(r);
    state.workspaces[0].collections.push(c);
    state.workspaces[0].environments.push({
      id: 'local',
      name: 'Local',
      variables: [pair('baseUrl', 'http://localhost:8080')],
    });
    state.settings.theme = 'light';
    state.tabs[0].request.body.raw = 'draft';
    store.save(state);
    store.close();
    store = new Store(path, codec);
    expect(store.load()).toEqual(state);
    expect(store.getMeta('previous-state')).toBeUndefined();
    store.close();
  });
  it('seals recognized secrets and cookie storage without modifying the in-memory state', () => {
    const path = file();
    const store = new Store(path, codec);
    const state = initialState();
    state.tabs[0].request.auth = { type: 'bearer', token: 'private-bearer-218727' };
    state.workspaces[0].globals.push({
      ...pair('credential', 'secret-variable-48731'),
      secret: true,
    });
    state.tabs[0].request.headers.push(pair('Authorization', 'Bearer header-secret-72841'));
    store.save(state);
    store.saveCookies('session-cookie-129847');
    expect(JSON.stringify(store.getMeta('state'))).not.toContain('private-bearer');
    expect(JSON.stringify(store.getMeta('state'))).not.toContain('secret-variable');
    expect(store.load()).toEqual(state);
    expect(store.loadCookies()).toBe('session-cookie-129847');
    store.close();
    expect(readFileSync(path).includes(Buffer.from('header-secret-72841'))).toBe(false);
  });
  it('rejects invalid writes and retains the previous valid workspace', () => {
    const store = new Store(file(), codec);
    const state = store.load();
    expect(() => store.save({ ...state, workspaces: [] })).toThrow();
    expect(store.load()).toEqual(state);
    state.settings.title = 'Team API';
    store.save(state);
    expect(store.getMeta('previous-state')).toBeTruthy();
    store.close();
  });
  it('rejects cyclic folder graphs before persistence', () => {
    const state = initialState();
    const c = newCollection('Bad');
    c.folders = [
      {
        id: 'a',
        name: 'a',
        parentId: 'b',
        description: '',
        auth: { type: 'inherit' },
        preScript: '',
        postScript: '',
      },
      {
        id: 'b',
        name: 'b',
        parentId: 'a',
        description: '',
        auth: { type: 'inherit' },
        preScript: '',
        postScript: '',
      },
    ];
    state.workspaces[0].collections.push(c);
    expect(stateSchema.safeParse(state).success).toBe(false);
  });
});
