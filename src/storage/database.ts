import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppState } from '../shared/models';
import { initialState } from '../shared/models';
import { stateSchema } from '../shared/validation';

export interface SecretCodec {
  seal(value: string): string;
  open(value: string): string;
}
const sensitiveHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
function transform(value: unknown, codec: SecretCodec, encrypt: boolean): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => transform(v, codec, encrypt));
  const obj = value as Record<string, unknown>;
  if (!encrypt && Object.keys(obj).length === 1 && typeof obj.__aw_sealed === 'string')
    return codec.open(obj.__aw_sealed);
  return Object.fromEntries(
    Object.entries(obj).map(([key, val]) => {
      const secret =
        ['token', 'password', 'clientSecret', 'refreshToken'].includes(key) ||
        (key === 'value' &&
          (obj.secret === true ||
            obj.type === 'apikey' ||
            (typeof obj.key === 'string' && sensitiveHeader.test(obj.key))));
      return [
        key,
        encrypt && secret && typeof val === 'string' && val
          ? { __aw_sealed: codec.seal(val) }
          : transform(val, codec, encrypt),
      ];
    }),
  );
}

export class Store {
  private db: DatabaseSync;
  constructor(
    file: string,
    private codec: SecretCodec,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    );
  }
  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM documents WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO documents(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  load(): AppState {
    const stored = this.getMeta<unknown>('state');
    if (!stored) {
      const state = initialState();
      this.save(state);
      return state;
    }
    try {
      const state = stateSchema.parse(transform(stored, this.codec, false));
      if (state.settings.title === 'ApiWorkbench') state.settings.title = 'SendIt!';
      return state;
    } catch (error) {
      throw new Error(
        `Could not open workspace data. Preserve SendIt-data and restore a backup. Windows-encrypted secrets require the original Windows account. ${error instanceof Error ? error.message : ''}`,
      );
    }
  }
  save(state: AppState) {
    const validated = stateSchema.parse(state);
    const protectedState = transform(validated, this.codec, true);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(
        "INSERT INTO documents(key,value) SELECT 'previous-state',value FROM documents WHERE key='state' ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      this.setMeta('state', protectedState);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  saveCookies(value: string) {
    this.setMeta('cookies', this.codec.seal(value));
  }
  loadCookies(): string | undefined {
    const value = this.getMeta<string>('cookies');
    return value ? this.codec.open(value) : undefined;
  }
  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
