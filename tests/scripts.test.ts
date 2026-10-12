import { describe, expect, it } from 'vitest';
import { runScript, type ScriptState } from '../src/services/scripts';
import { interpolate, variableMap } from '../src/services/variables';
import { pair } from '../src/shared/models';
const state = (): ScriptState => ({
  globals: [pair('a', 'global')],
  environment: [pair('a', 'environment')],
  collectionVariables: [],
  variables: [],
});

describe('bounded QuickJS script sandbox', () => {
  it('supports scope APIs, common assertion chains, test failures and console logs', async () => {
    const result = await runScript(
      `
      pm.test('precedence', () => pm.expect(pm.variables.get('a')).to.equal('environment'));
      pm.globals.set('made', 42); pm.environment.unset('a'); pm.collectionVariables.set('collection', true); pm.variables.set('local', 'yes');
      pm.test('deep', () => pm.expect({a:[1,2]}).to.deep.equal({a:[1,2]}));
      pm.test('property', () => pm.expect({name:'Ada'}).to.have.property('name').that.is.a('string'));
      pm.test('negative', () => pm.expect(2).not.to.equal(3));
      pm.test('failure', () => pm.expect(1).to.equal(2));
      console.log('logged', {ok:true});
    `,
      state(),
    );
    expect(result.error).toBeUndefined();
    expect(result.tests.map((t) => t.passed)).toEqual([true, true, true, true, false]);
    expect(result.globals.find((r) => r.key === 'made')?.value).toBe('42');
    expect(result.environment).toEqual([]);
    expect(result.logs[0]).toContain('logged');
  });
  it('does not expose Node, Electron, fetch, filesystem, or timer capabilities', async () => {
    const result = await runScript(
      `pm.test('isolation', () => { for (const name of ['process','require','fetch','window','setTimeout','Buffer']) pm.expect(typeof globalThis[name]).to.equal('undefined'); });`,
      state(),
    );
    expect(result.error).toBeUndefined();
    expect(result.tests).toEqual([{ name: 'isolation', passed: true }]);
  });
  it('interrupts infinite loops and remains usable afterwards', async () => {
    const result = await runScript('while(true) {}', state(), undefined, 40);
    expect(result.error).toContain('execution limit');
    expect(
      (await runScript('pm.test("still alive",()=>pm.expect(1).to.equal(1))', state())).tests[0]
        .passed,
    ).toBe(true);
  });
  it('limits allocations and rejects async tests instead of falsely passing', async () => {
    const memory = await runScript('const huge = new Array(50000000).fill("x");', state());
    expect(memory.error).toBeTruthy();
    const async = await runScript('pm.test("async", async () => {});', state());
    expect(async.tests[0].passed).toBe(false);
    expect(async.tests[0].error).toContain('Async tests');
  });
  it('reports syntax errors and isolates each execution', async () => {
    expect((await runScript('const = ;', state())).error).toBeTruthy();
    await runScript('globalThis.leftover = 1', state());
    expect(
      (
        await runScript(
          'pm.test("fresh", () => pm.expect(typeof leftover).to.equal("undefined"))',
          state(),
        )
      ).tests[0].passed,
    ).toBe(true);
  });
});

describe('variable resolution', () => {
  it('honors scope precedence, disabled rows, nested references and special keys', () => {
    const map = variableMap(
      [pair('host', 'global')],
      [pair('host', 'collection')],
      [pair('host', 'environment'), pair('base', 'https://{{host}}'), pair('__proto__', 'safe')],
      [pair('host', 'local'), { ...pair('host', 'disabled'), enabled: false }],
    );
    expect(interpolate('{{base}}/{{__proto__}}', map)).toBe('https://local/safe');
    expect(interpolate('{{$randomUUID}}', map)).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('reports unresolved references and cycles', () => {
    expect(() => interpolate('{{missing}}', {})).toThrow('Unresolved');
    expect(() => interpolate('{{a}}', { a: '{{b}}', b: '{{a}}' })).toThrow('Circular');
  });
});
