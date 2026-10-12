import { getQuickJS } from 'quickjs-emscripten';
import type { ApiResponse, Pair, TestResult } from '../shared/models';

export interface ScriptState {
  globals: Pair[];
  environment: Pair[];
  collectionVariables: Pair[];
  variables: Pair[];
}
export interface ScriptResult extends ScriptState {
  tests: TestResult[];
  logs: string[];
  error?: string;
}

// This program executes exclusively inside QuickJS/WASM. No Node, Electron, network,
// timers, imports or host object callbacks are made available to guest scripts.
const bootstrap = String.raw`
const __tests = [], __logs = [];
const __state = JSON.parse(__input);
const __response = __state.response;
let __next = 0;
function scope(rows) {
  return {
    get(key) { const found = rows.filter(r => r.enabled && r.key === String(key)); return found.length ? found[found.length - 1].value : undefined; },
    has(key) { return this.get(key) !== undefined; },
    set(key, value) { key = String(key); let row = rows.find(r => r.key === key); if (!row) { row = {id: 'script-' + Date.now() + '-' + (++__next), key, enabled:true, value:''}; rows.push(row); } row.value = String(value); row.enabled = true; },
    unset(key) { for (let i = rows.length - 1; i >= 0; --i) if(rows[i].key === String(key)) rows.splice(i, 1); },
    clear() { rows.splice(0); },
    toObject() { return Object.fromEntries(rows.filter(r => r.enabled).map(r => [r.key, r.value])); },
    replaceIn(text) { return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => this.has(key) ? this.get(key) : match); }
  };
}
function eq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.prototype.hasOwnProperty.call(b, k) && eq(a[k], b[k]));
}
function expect(value, label) {
  let negate = false, deep = false;
  const chain = {};
  const inspect = v => { try { return JSON.stringify(v); } catch { return String(v); } };
  function check(ok, message) { const fail = negate ? ok : !ok; negate = false; if (fail) throw new Error((label ? label + ': ' : '') + message); return chain; }
  for (const key of ['to','be','been','is','that','which','and','has','have','with','at','of','same']) Object.defineProperty(chain,key,{get:()=>chain});
  Object.defineProperty(chain,'not',{get:()=>{negate = !negate; return chain;}});
  Object.defineProperty(chain,'deep',{get:()=>{deep = true; return chain;}});
  chain.equal = chain.equals = chain.eq = expected => check(deep ? eq(value,expected) : value === expected, 'Expected ' + inspect(value) + ' to equal ' + inspect(expected));
  chain.eql = expected => check(eq(value,expected),'Expected deeply equal values');
  chain.include = chain.includes = chain.contain = expected => check(typeof value === 'string' || Array.isArray(value) ? value.includes(expected) : value && typeof expected === 'object' && Object.keys(expected).every(k => eq(value[k],expected[k])), 'Expected value to include ' + inspect(expected));
  chain.property = function(key, expected) { const exists = value != null && key in Object(value); check(exists && (arguments.length < 2 || (deep ? eq(value[key],expected) : value[key] === expected)), 'Expected property ' + key); if(exists) value = value[key]; return chain; };
  chain.a = chain.an = type => check(type === 'array' ? Array.isArray(value) : type === 'null' ? value === null : typeof value === type, 'Expected type ' + type);
  chain.above = chain.greaterThan = expected => check(value > expected, 'Expected value > ' + expected);
  chain.below = chain.lessThan = expected => check(value < expected, 'Expected value < ' + expected);
  chain.least = expected => check(value >= expected, 'Expected value >= ' + expected);
  chain.most = expected => check(value <= expected, 'Expected value <= ' + expected);
  chain.within = (a,b) => check(value >= a && value <= b,'Expected value between ' + a + ' and ' + b);
  chain.oneOf = values => check(values.includes(value),'Expected value in list');
  chain.match = pattern => check(pattern.test(value),'Expected value to match ' + pattern);
  chain.lengthOf = n => check(value != null && value.length === n,'Expected length ' + n);
  for (const [key, fn] of Object.entries({true:()=>value === true,false:()=>value === false,null:()=>value === null,undefined:()=>value === undefined,ok:()=>!!value,exist:()=>value != null,empty:()=>value != null && (typeof value.length === 'number' ? value.length === 0 : Object.keys(value).length === 0)})) Object.defineProperty(chain,key,{get:()=>check(fn(),'Expected ' + key)});
  return chain;
}
const __globals = scope(__state.globals), __collection = scope(__state.collectionVariables), __environment = scope(__state.environment), __local = scope(__state.variables);
const __combined = {...__local, get(key) { for (const s of [__local,__environment,__collection,__globals]) if (s.has(key)) return s.get(key); }, has(key) { return this.get(key) !== undefined; }, toObject() { return {...__globals.toObject(),...__collection.toObject(),...__environment.toObject(),...__local.toObject()}; }};
const pm = {
  globals: __globals, environment: __environment, collectionVariables: __collection, variables: __combined,
  expect,
  test(name, fn) { if (__tests.length >= 1000) throw new Error('Test limit (1000) exceeded'); try { const returned = fn(); if (returned && typeof returned.then === 'function') throw new Error('Async tests are unsupported; use a synchronous test callback.'); __tests.push({name:String(name),passed:true}); } catch(e) { __tests.push({name:String(name),passed:false,error:String(e.message || e)}); } }
};
pm.test.skip = name => __logs.push('Skipped test: ' + String(name));
if (__response) {
  pm.response = {
    code: __response.status, status: __response.statusText, responseTime: __response.duration, responseSize: __response.size,
    text: () => __response.body, json: () => JSON.parse(__response.body),
    headers: {get: name => __response.headers.find(h => h.key.toLowerCase() === String(name).toLowerCase())?.value, has(name) { return this.get(name) !== undefined; }, toObject: () => Object.fromEntries(__response.headers.map(h => [h.key,h.value])), all: () => __response.headers.slice()},
    to: { have: { status(code) { expect(__response.status).to.equal(code); }, header(name, value) { const got = pm.response.headers.get(name); expect(got).to.exist; if (value !== undefined) expect(got).to.equal(value); } }, be: {} }
  };
  Object.defineProperty(pm.response.to.be,'ok',{get() { expect(__response.status).to.be.within(200,299); return true; }});
}
const console = Object.fromEntries(['log','info','warn','error','debug'].map(level => [level,(...args) => { if (__logs.length < 200) __logs.push(level + ': ' + args.map(a => {try {return typeof a === 'string' ? a : JSON.stringify(a);} catch{return String(a);}}).join(' ').slice(0,4000)); }]));
`;

export async function runScript(
  source: string,
  state: ScriptState,
  response?: ApiResponse,
  deadlineMs = 500,
): Promise<ScriptResult> {
  const original = structuredClone(state);
  if (!source.trim()) return { ...original, tests: [], logs: [] };
  if (source.length > 256_000)
    return { ...original, tests: [], logs: [], error: 'Script exceeds 256 KB limit.' };
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + deadlineMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  try {
    const payload = JSON.stringify({
      ...original,
      response: response ? { ...response, base64: '', logs: [], tests: [] } : undefined,
    });
    if (payload.length > 5 * 1024 * 1024)
      throw new Error(
        'Script input exceeds 5 MB limit. The response is still available in the response viewer.',
      );
    const handle = vm.newString(payload);
    vm.setProp(vm.global, '__input', handle);
    handle.dispose();
    for (const [code, name] of [
      [bootstrap, 'sandbox.js'],
      [source, 'request-script.js'],
    ] as const) {
      const result = vm.evalCode(code, name);
      if (result.error) {
        const error = vm.dump(result.error) as { message?: string };
        result.error.dispose();
        throw new Error(
          error?.message === 'interrupted'
            ? `Script exceeded ${deadlineMs} ms execution limit.`
            : error?.message || 'Script execution failed.',
        );
      }
      result.value.dispose();
    }
    const result = vm.evalCode(
      'JSON.stringify({globals:__state.globals,environment:__state.environment,collectionVariables:__state.collectionVariables,variables:__state.variables,tests:__tests,logs:__logs})',
    );
    if (result.error) {
      const message = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`Unable to read script results: ${String(message)}`);
    }
    const output = JSON.parse(vm.getString(result.value)) as ScriptResult;
    result.value.dispose();
    return output;
  } catch (error) {
    return {
      ...original,
      tests: [],
      logs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
